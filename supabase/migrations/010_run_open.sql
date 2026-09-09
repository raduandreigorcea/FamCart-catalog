-- ─── opening a scrape run, defined once ─────────────────────────────────────
-- THE ONLY DEFINITION OF catalog_run_open. It was written in 003, replaced in
-- 007 to wire in the reap, and then quietly reverted when 003 was re-pushed to
-- ship an unrelated change to a different function in the same file. Nothing
-- failed: run_open still opened runs, so the only symptom was that abandoned
-- runs stopped being closed. Six Carrefour runs were sitting `running`, the
-- oldest for three days, when this was found.
--
-- Two files restating one function is a race whose winner is "whichever was
-- pushed last", and nothing in the repository shows which that was. 003 and 007
-- no longer define it, and both carry a note pointing here, so re-pushing either
-- of them cannot put an old body back.
--
-- The body is 007's, unchanged.

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
--
-- The reap runs here rather than on a schedule, so the thing that notices a dead
-- run is the next attempt at the same work. Nothing to schedule, nothing to
-- forget, and no window where the catalog is waiting on a sweeper that was never
-- installed. See 007 for why the threshold is twelve hours and not one.
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

-- Nothing here is callable from a browser. This is the scraper's function and
-- the scraper holds the service-role key.
revoke all on function public.catalog_run_open(text) from public, anon, authenticated;
grant execute on function public.catalog_run_open(text) to service_role;
