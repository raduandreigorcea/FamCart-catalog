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

-- How far the crawl is through its OWN plan, in its own unit: the sitemap's
-- "pages", Carrefour's "departments", the Auchan "categories" known so far. The
-- Scrapers page drew its bar from the shop's last completed run, which a first
-- run does not have and Carrefour never has; this is known from minute one.
alter table public.catalog_scrape_runs add column if not exists progress_done  integer;
alter table public.catalog_scrape_runs add column if not exists progress_total integer;
alter table public.catalog_scrape_runs add column if not exists progress_unit  text;

alter table public.catalog_scrape_runs drop constraint if exists catalog_scrape_runs_pages_read_check;
alter table public.catalog_scrape_runs add constraint catalog_scrape_runs_pages_read_check
  check (pages_read >= 0);

-- The two-argument version this file first shipped. Arguments with defaults
-- OVERLOAD rather than replace, so the old one is dropped by its full list.
drop function if exists public.catalog_run_alive(uuid, integer);

create or replace function public.catalog_run_alive(
  p_run_id uuid,
  p_pages  integer default 0,
  p_done   integer default null,
  p_total  integer default null,
  p_unit   text    default null
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
     set pages_read     = pages_read + greatest(coalesce(p_pages, 0), 0),
         last_alive_at  = now(),
         -- Only when the scraper said something: a report without a plan must
         -- not wipe the last one.
         progress_done  = coalesce(greatest(p_done, 0), progress_done),
         progress_total = coalesce(greatest(p_total, 0), progress_total),
         progress_unit  = coalesce(nullif(btrim(p_unit), ''), progress_unit)
   where id = p_run_id
     and status = 'running';
end;
$fn$;

comment on function public.catalog_run_alive(uuid, integer, integer, integer, text) is
  'A running scraper is hearing back from the shop. Once a minute at most; see 022.';

revoke all on function public.catalog_run_alive(uuid, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.catalog_run_alive(uuid, integer, integer, integer, text) to service_role;
