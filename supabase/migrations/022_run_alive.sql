-- ─── a sign of life, separate from what a run imported ─────────────────────
-- THE QUESTION THIS ANSWERS: is a running scraper actually doing anything?
--
-- The Scrapers page could only judge a crawl by products_found, which moves when
-- a batch of products is IMPORTED. A crawl can read for hours and import none:
-- Carrefour spends most of its night in departments outside groceries, and on
-- 2026-09-17 Lidl Spain sat at 0 for over an hour and then finished with 739.
-- Both looked exactly like a crawl that had hung.
--
-- So the scraper reports separately that it is hearing back from the shop:
-- once a minute while any answer arrives (importer/run.ts, watchLiveness),
-- carrying how many good pages it read. A minute with no answer reports
-- nothing, so `last_alive_at` going stale IS the alarm.
--
-- An increment rather than an edit to 003, for the reason 021 is: the columns
-- have to be added to a table that already exists, and a column declared inside
-- `create table if not exists` would never reach production.

alter table public.catalog_scrape_runs add column if not exists pages_read integer not null default 0;
alter table public.catalog_scrape_runs add column if not exists last_alive_at timestamptz;

alter table public.catalog_scrape_runs drop constraint if exists catalog_scrape_runs_pages_read_check;
alter table public.catalog_scrape_runs add constraint catalog_scrape_runs_pages_read_check
  check (pages_read >= 0);

create or replace function public.catalog_run_alive(
  p_run_id uuid,
  p_pages  integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- A no-op once the run is closed, like catalog_run_progress: a last report
  -- racing the close must not make a finished run look alive.
  update public.catalog_scrape_runs
     set pages_read    = pages_read + greatest(coalesce(p_pages, 0), 0),
         last_alive_at = now()
   where id = p_run_id
     and status = 'running';
end;
$fn$;

comment on function public.catalog_run_alive(uuid, integer) is
  'A running scraper is hearing back from the shop. Once a minute at most; see 022.';

revoke all on function public.catalog_run_alive(uuid, integer) from public, anon, authenticated;
grant execute on function public.catalog_run_alive(uuid, integer) to service_role;
