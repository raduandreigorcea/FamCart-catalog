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

-- catalog_run_open is what CALLS this, and it is defined in 010 rather than
-- here. It was defined here once, alongside 003's copy of it, and the two took
-- turns overwriting each other depending on which file was pushed last. See the
-- note where it used to sit in 003.

revoke all on function public.catalog_run_reap(interval) from public, anon, authenticated;
grant execute on function public.catalog_run_reap(interval) to service_role;
