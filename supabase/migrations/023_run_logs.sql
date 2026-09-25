-- ─── the run's own log, line by line ───────────────────────────────────────
-- THE QUESTION THIS ANSWERS: what did the scraper say while it ran?
--
-- The run row carries counts and one closing sentence. Everything in between
-- -- a department that failed, a circuit that opened, a retry -- was written to
-- stderr and lived only in the GitHub Actions job log, which nobody opens from
-- the dashboard and which a running job does not expose through the API at all.
--
-- So the scraper ships every line of its log here as well (importer/runLog.ts),
-- two seconds or a hundred lines at a time, and the admin's run page reads it
-- live through Realtime. At most 5,000 info and 20,000 warn lines a run,
-- enforced by the scraper; errors are always kept. Trimmed after 30 days by
-- pg_cron.

create table if not exists public.catalog_run_logs (
  id      bigint generated always as identity primary key,
  run_id  uuid not null references public.catalog_scrape_runs(id) on delete cascade,
  t       timestamptz not null,
  level   text not null,
  scope   text not null,
  message text not null,
  fields  jsonb
);

comment on table public.catalog_run_logs is
  'Every line a scraper logged during one run. Written by catalog_run_log, read by the admin run page. See 023.';

alter table public.catalog_run_logs drop constraint if exists catalog_run_logs_level_check;
alter table public.catalog_run_logs add constraint catalog_run_logs_level_check
  check (level in ('info', 'warn', 'error'));

alter table public.catalog_run_logs drop constraint if exists catalog_run_logs_message_check;
alter table public.catalog_run_logs add constraint catalog_run_logs_message_check
  check (char_length(message) <= 2000);

-- The page reads "this run's lines after id N", oldest first.
create index if not exists catalog_run_logs_run on public.catalog_run_logs (run_id, id);
-- The trim reads by age.
create index if not exists catalog_run_logs_t on public.catalog_run_logs (t);

alter table public.catalog_run_logs enable row level security;

drop policy if exists "admins can read run logs" on public.catalog_run_logs;
create policy "admins can read run logs"
  on public.catalog_run_logs for select to authenticated
  using (public.catalog_is_admin());

revoke all on public.catalog_run_logs from anon, authenticated;
grant select on public.catalog_run_logs to authenticated;

-- Realtime delivers each INSERT to a subscriber the policy above admits, and to
-- nobody else. Guarded, because a bare `add table` fails on a second push.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'catalog_run_logs'
     ) then
    alter publication supabase_realtime add table public.catalog_run_logs;
  end if;
end $$;

-- ─── writing ─────────────────────────────────────────────────────────────────
-- A batch per call. A run that does not exist takes nothing rather than
-- throwing: the log is a side channel, and a failure here must never be the
-- thing that ends a crawl. It accepts lines for a CLOSED run too, because the
-- last lines -- "run completed", "done" -- are written after the close.
create or replace function public.catalog_run_log(p_run_id uuid, p_lines jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'p_lines must be a json array' using errcode = '22023';
  end if;

  insert into public.catalog_run_logs (run_id, t, level, scope, message, fields)
  select p_run_id,
         coalesce((line ->> 't')::timestamptz, now()),
         case when line ->> 'level' in ('warn', 'error') then line ->> 'level' else 'info' end,
         left(coalesce(line ->> 'scope', ''), 100),
         left(coalesce(line ->> 'message', ''), 2000),
         nullif(line -> 'fields', 'null'::jsonb)
    from jsonb_array_elements(p_lines) as line
   where exists (select 1 from public.catalog_scrape_runs where id = p_run_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.catalog_run_log(uuid, jsonb) is
  'A scraper ships a batch of its log lines. Returns how many landed. See 023.';

revoke all on function public.catalog_run_log(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_run_log(uuid, jsonb) to service_role;

-- ─── what a run touched ──────────────────────────────────────────────────────
-- Read from the stamps the importer already leaves (004): a listing it created
-- has first_seen_at = the run's started_at, a price it moved has last_price_at
-- = started_at, and the sweep (003) marks unavailable what a COMPLETED run did
-- not stamp. No new bookkeeping, and so one honest limit: this is what is still
-- true today. A later run that reprices A1 again moves its stamp, and the
-- earlier run no longer lists it.
create or replace function public.catalog_admin_run_listings(
  p_run_id uuid,
  p_kind   text,
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  external_id    text,
  name           text,
  price          numeric,
  previous_price numeric,
  currency       text,
  available      boolean,
  product_url    text,
  total          bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_run public.catalog_scrape_runs;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('new', 'repriced', 'gone') then
    raise exception 'unknown kind: %', p_kind using errcode = 'P0001', detail = 'bad_kind';
  end if;

  select * into v_run from public.catalog_scrape_runs where id = p_run_id;
  if v_run.id is null then
    return;
  end if;

  return query
    select l.external_id, l.retailer_name, l.price, l.previous_price, l.currency,
           l.available, l.product_url, count(*) over ()
      from public.catalog_listings l
     where l.retailer_id = v_run.retailer_id
       and case p_kind
             when 'new' then l.first_seen_at = v_run.started_at
             when 'repriced' then l.last_price_at = v_run.started_at and l.first_seen_at <> v_run.started_at
             -- Seen last by the shop's PREVIOUS completed run: anything older
             -- was that run's sweep, not this one's, and without the floor a
             -- listing swept in June would be listed under every run since.
             else v_run.status = 'completed' and not l.available
                  and l.last_seen_at < v_run.started_at
                  and l.last_seen_at >= coalesce((
                    select max(p.started_at) from public.catalog_scrape_runs p
                     where p.retailer_id = v_run.retailer_id
                       and p.status = 'completed'
                       and p.started_at < v_run.started_at
                  ), '-infinity'::timestamptz)
           end
     order by l.retailer_name, l.external_id
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$fn$;

comment on function public.catalog_admin_run_listings(uuid, text, integer, integer) is
  'The listings one run created, repriced or swept, for the admin run page. See 023.';

revoke all on function public.catalog_admin_run_listings(uuid, text, integer, integer) from public, anon;
grant execute on function public.catalog_admin_run_listings(uuid, text, integer, integer) to authenticated;

-- ─── the trim ────────────────────────────────────────────────────────────────
-- Thirty days is a month of nights to compare, and it bounds the table on a
-- free-plan database. cron.schedule replaces a job of the same name.
select cron.schedule(
  'catalog-run-logs-trim',
  '40 0 * * *',
  $$delete from public.catalog_run_logs where t < now() - interval '30 days'$$
);
