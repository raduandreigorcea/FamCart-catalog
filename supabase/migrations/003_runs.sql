-- ─── scrape runs ─────────────────────────────────────────────────────────────
-- THE RULE THIS FILE EXISTS FOR:
--
--   Only a run that finished, and finished plausibly, may decide that a product
--   is no longer on a retailer's shelf.
--
-- A scraper that dies halfway, times out, gets rate-limited into a corner or is
-- killed by whoever ran it has seen a fraction of the catalog. If "I did not see
-- it" meant "it is gone", every one of those would wipe a retailer. Auchan
-- returned 429 on two endpoints during the very session this schema was written
-- in; that is not a hypothetical.
--
-- So availability is never a side effect of an import. Imports only ever say
-- "I saw this, now". The sweep -- the step that says "and therefore I did NOT
-- see these" -- happens once, at the end, and only when the run earned the right
-- to run it.

create table if not exists public.catalog_scrape_runs (
  id                 uuid primary key default gen_random_uuid(),
  retailer_id        uuid not null references public.catalog_retailers(id) on delete cascade,
  status             text not null default 'running',
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  products_found     integer not null default 0,
  products_valid     integer not null default 0,
  products_rejected  integer not null default 0,
  inserted           integer not null default 0,
  updated            integer not null default 0,
  unchanged          integer not null default 0,
  products_created   integer not null default 0,
  identifiers_added  integer not null default 0,
  conflicts          integer not null default 0,
  marked_unavailable integer not null default 0,
  error_count        integer not null default 0,
  error              text,
  stats              jsonb not null default '{}'::jsonb
);

comment on table public.catalog_scrape_runs is
  'One row per scrape attempt. The observability surface, and the gate on the availability sweep.';
comment on column public.catalog_scrape_runs.status is
  'running -> completed (swept) | partial (imported, refused to sweep) | failed (swept nothing).';

alter table public.catalog_scrape_runs drop constraint if exists catalog_scrape_runs_status_check;
alter table public.catalog_scrape_runs add constraint catalog_scrape_runs_status_check
  check (status in ('running', 'completed', 'partial', 'failed'));

alter table public.catalog_scrape_runs drop constraint if exists catalog_scrape_runs_counts_check;
alter table public.catalog_scrape_runs add constraint catalog_scrape_runs_counts_check
  check (
    products_found >= 0 and products_valid >= 0 and products_rejected >= 0
    and inserted >= 0 and updated >= 0 and unchanged >= 0
    and products_created >= 0 and identifiers_added >= 0 and conflicts >= 0
    and marked_unavailable >= 0 and error_count >= 0
  );

alter table public.catalog_scrape_runs drop constraint if exists catalog_scrape_runs_finished_check;
alter table public.catalog_scrape_runs add constraint catalog_scrape_runs_finished_check
  check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  );

create index if not exists catalog_scrape_runs_retailer_started
  on public.catalog_scrape_runs (retailer_id, started_at desc);
-- Finding the last run that was allowed to sweep, which is what the sanity floor
-- and the staleness report both compare against.
create index if not exists catalog_scrape_runs_completed
  on public.catalog_scrape_runs (retailer_id, started_at desc) where status = 'completed';

alter table public.catalog_scrape_runs enable row level security;

drop policy if exists "admins can read scrape runs" on public.catalog_scrape_runs;
create policy "admins can read scrape runs"
  on public.catalog_scrape_runs for select to authenticated
  using (public.catalog_is_admin());

revoke all on public.catalog_scrape_runs from anon, authenticated;
grant select on public.catalog_scrape_runs to authenticated;

-- ─── open ────────────────────────────────────────────────────────────────────
-- started_at is the run's watermark. Every listing the run touches is stamped
-- with it, so "not seen in this run" is a plain timestamp comparison and needs
-- no per-run join table.
--
-- Deliberately does NOT refuse to open when another run for the same retailer is
-- still 'running'. A crashed process leaves its row running forever, and a lock
-- that only a crashed process can release is a lock that eventually stops all
-- scraping. Concurrency is controlled by whoever schedules the runs; the worst a
-- genuine overlap costs is that the later run's watermark wins, and the sweep is
-- floor-guarded anyway.
create or replace function public.catalog_run_open(p_retailer text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_retailer_id uuid;
  v_run_id      uuid;
begin
  select id into v_retailer_id from public.catalog_retailers where slug = p_retailer;
  if v_retailer_id is null then
    raise exception 'unknown retailer: %', p_retailer using errcode = 'P0001', detail = 'unknown_retailer';
  end if;

  insert into public.catalog_scrape_runs (retailer_id, status)
  values (v_retailer_id, 'running')
  returning id into v_run_id;

  return v_run_id;
end;
$fn$;

comment on function public.catalog_run_open(text) is
  'Start a scrape run and return its id. started_at becomes the run watermark.';

-- ─── progress ────────────────────────────────────────────────────────────────
-- A heartbeat the CLI calls between batches, so a long Carrefour crawl is
-- legible while it is happening rather than only once it ends. Counters are
-- added to, not replaced, because the CLI reports per batch.
create or replace function public.catalog_run_progress(
  p_run_id            uuid,
  p_products_found    integer default 0,
  p_products_valid    integer default 0,
  p_products_rejected integer default 0,
  p_error_count       integer default 0,
  p_stats             jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.catalog_scrape_runs
     set products_found    = products_found    + greatest(coalesce(p_products_found, 0), 0),
         products_valid    = products_valid    + greatest(coalesce(p_products_valid, 0), 0),
         products_rejected = products_rejected + greatest(coalesce(p_products_rejected, 0), 0),
         error_count       = error_count       + greatest(coalesce(p_error_count, 0), 0),
         stats             = case when p_stats is null then stats else stats || p_stats end
   where id = p_run_id
     and status = 'running';
end;
$fn$;

comment on function public.catalog_run_progress(uuid, integer, integer, integer, integer, jsonb) is
  'Add to a running run''s counters between batches. A no-op once the run is closed.';

-- ─── fail ────────────────────────────────────────────────────────────────────
-- The important thing this function does is NOTHING to availability. Whatever
-- the run managed to import stays imported and stays available; the rows it
-- never reached keep the state they had.
create or replace function public.catalog_run_fail(p_run_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.catalog_scrape_runs
     set status      = 'failed',
         finished_at = now(),
         error       = left(coalesce(p_error, 'unknown error'), 2000)
   where id = p_run_id
     and status = 'running';
end;
$fn$;

comment on function public.catalog_run_fail(uuid, text) is
  'Close a run as failed. Never sweeps: a partial view of a shelf is not evidence of absence.';

-- ─── complete, and the floor ─────────────────────────────────────────────────
-- The only path that may mark listings unavailable, and it still refuses in two
-- cases:
--
--   * the run found nothing at all. A scraper that returns zero products has
--     almost certainly broken -- a changed selector, a moved endpoint, a block --
--     and the one thing it must not do is conclude that the shop closed.
--   * the run found less than half of what the last completed run found. The
--     threshold is a judgement call and it is deliberately blunt: a real
--     assortment does not halve overnight, and a crawl that gave up early does
--     exactly that. Half is low enough that seasonal churn and a retailer
--     genuinely dropping a range pass through, and high enough that a crawl
--     which died a third of the way in does not.
--
-- Both land the run as 'partial': the data IS imported (what we saw, we saw),
-- the availability sweep simply does not happen, and `error` says why so the
-- admin dashboard can show it rather than leaving somebody to infer it from
-- counts.
create or replace function public.catalog_run_complete(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_run       public.catalog_scrape_runs%rowtype;
  v_previous  integer;
  v_swept     integer := 0;
  v_status    text;
  v_reason    text := null;
begin
  select * into v_run from public.catalog_scrape_runs where id = p_run_id for update;
  if not found then
    raise exception 'unknown run: %', p_run_id using errcode = 'P0001', detail = 'unknown_run';
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('status', v_run.status, 'swept', false,
                              'marked_unavailable', v_run.marked_unavailable,
                              'reason', 'already_closed');
  end if;

  select products_valid into v_previous
    from public.catalog_scrape_runs
   where retailer_id = v_run.retailer_id
     and status = 'completed'
     and id <> v_run.id
   order by started_at desc
   limit 1;

  if v_run.products_valid = 0 then
    v_status := 'partial';
    v_reason := 'found_nothing';
  elsif v_previous is not null and v_previous > 0
        and v_run.products_valid::numeric < v_previous::numeric * 0.5 then
    v_status := 'partial';
    v_reason := format('found %s, previous completed run found %s (below the 50%% floor)',
                       v_run.products_valid, v_previous);
  else
    v_status := 'completed';
  end if;

  if v_status = 'completed' then
    update public.catalog_listings
       set available = false
     where retailer_id = v_run.retailer_id
       and last_seen_at < v_run.started_at
       and available;
    get diagnostics v_swept = row_count;
  end if;

  update public.catalog_scrape_runs
     set status             = v_status,
         finished_at        = now(),
         marked_unavailable = v_swept,
         error              = coalesce(v_reason, error)
   where id = p_run_id;

  return jsonb_build_object(
    'status', v_status,
    'swept', v_status = 'completed',
    'marked_unavailable', v_swept,
    'products_valid', v_run.products_valid,
    'previous_products_valid', v_previous,
    'reason', v_reason
  );
end;
$fn$;

comment on function public.catalog_run_complete(uuid) is
  'Close a run. Sweeps stale listings to unavailable only when the run found something and at least half of what the last completed run found.';

-- Nothing here is callable from a browser. These are the scraper's functions and
-- the scraper holds the service-role key.
revoke all on function public.catalog_run_open(text) from public, anon, authenticated;
revoke all on function public.catalog_run_progress(uuid, integer, integer, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.catalog_run_fail(uuid, text) from public, anon, authenticated;
revoke all on function public.catalog_run_complete(uuid) from public, anon, authenticated;

grant execute on function public.catalog_run_open(text) to service_role;
grant execute on function public.catalog_run_progress(uuid, integer, integer, integer, integer, jsonb) to service_role;
grant execute on function public.catalog_run_fail(uuid, text) to service_role;
grant execute on function public.catalog_run_complete(uuid) to service_role;
