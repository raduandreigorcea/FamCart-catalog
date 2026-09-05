-- ─── runs that never got to say they died ───────────────────────────────────
-- A scrape closes its own run: `completed` when it finished, `failed` when it
-- threw or was interrupted. Both go through the CLI, and both need the process
-- to still be alive.
--
-- SIGKILL is neither. When the operating system reclaims memory from a crawl --
-- which happened here, to an Auchan run 28,000 products in -- the process
-- vanishes with no chance to run a handler, and its row sits `running` forever.
--
-- That row is not harmless. `catalog_stats()` reports the last run per retailer,
-- so an abandoned one hides the last real result behind a crawl that looks like
-- it is still going, and "still going" is indistinguishable from "started
-- yesterday and never came back".
--
-- WHY THIS IS NOT A CRON JOB. It runs at the start of the next scrape, from
-- catalog_run_open, so the thing that notices a dead run is the next attempt at
-- the same work. Nothing to schedule, nothing to forget, and no window where the
-- catalog is waiting on a sweeper that was never installed.

create or replace function public.catalog_run_reap(p_older_than interval default '12 hours')
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_reaped integer;
begin
  update public.catalog_scrape_runs
     set status      = 'failed',
         finished_at = now(),
         error       = coalesce(error, 'abandoned: no result was ever recorded, so the process died without closing it')
   where status = 'running'
     and started_at < now() - p_older_than;

  get diagnostics v_reaped = row_count;
  return v_reaped;
end;
$fn$;

comment on function public.catalog_run_reap(interval) is
  'Close runs abandoned by a killed process. Marks them failed, so they can never sweep.';

-- ─── open, now with a look behind it ────────────────────────────────────────
-- Same signature and same behaviour as before; it just tidies up first.
--
-- TWELVE HOURS, not one. A full Carrefour crawl is 85,121 pages at one request a
-- second, which is about a day, so a threshold shorter than the longest honest
-- run would reap a crawl that is still working. Twelve hours is longer than any
-- run that is going well except Carrefour's, and a Carrefour run reaped at hour
-- thirteen by a second one starting is not a problem anyway: the reaped run keeps
-- importing, and when it finally calls complete() the status check refuses it and
-- reports `already_closed`. It loses its sweep, which is the right outcome for a
-- run somebody thought was dead.
create or replace function public.catalog_run_open(p_retailer text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_retailer_id uuid;
  v_run_id      uuid;
  v_reaped      integer;
begin
  select id into v_retailer_id from public.catalog_retailers where slug = p_retailer;
  if v_retailer_id is null then
    raise exception 'unknown retailer: %', p_retailer using errcode = 'P0001', detail = 'unknown_retailer';
  end if;

  v_reaped := public.catalog_run_reap();
  if v_reaped > 0 then
    raise notice 'closed % abandoned run(s) before starting', v_reaped;
  end if;

  insert into public.catalog_scrape_runs (retailer_id, status)
  values (v_retailer_id, 'running')
  returning id into v_run_id;

  return v_run_id;
end;
$fn$;

comment on function public.catalog_run_open(text) is
  'Start a scrape run and return its id. Closes runs abandoned by a killed process first.';

revoke all on function public.catalog_run_reap(interval) from public, anon, authenticated;
grant execute on function public.catalog_run_reap(interval) to service_role;
