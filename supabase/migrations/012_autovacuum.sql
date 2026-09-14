-- ─── vacuum after every nightly import, not after every fifth ───────────────
-- A search for a word nobody had searched since the last import took 400-900ms
-- on the server; the same search a second time took 30-60ms. Measured on
-- 2026-09-13 against 107,774 products and 123,780 listings.
--
-- THE TIME WAS NOT DISK. track_io_timing put shared reads at 5-17ms of it. It
-- tracked the pages the query DIRTIED instead: a read-only search dirtied 55 to
-- 208 pages, and `explain (wal)` showed one full-page WAL image per page.
--
-- That is hint bits. The first reader of a row written by the import checks
-- whether its transaction committed and records the answer on the page; with
-- data_checksums on (it is, on Supabase) the first such change to a page after
-- a checkpoint writes the whole page to the WAL. So every keystroke that reached
-- rows nobody had read since the scrape paid for writing them, and each new
-- word reaches new rows.
--
-- VACUUM does that once, for every page, and marks them all-visible. Autovacuum
-- would have, but its default trigger is 20% of the table changed, and a nightly
-- run changes about 10% (11,064 dead products, 13,092 dead listings on the day
-- this was measured, last autovacuum the day before). So the tables sat below
-- the threshold, and searches did the vacuum's work one page at a time.
--
-- 2% puts every nightly run over the line. The insert factor matters as much as
-- the update one: a first run of a new shop is nearly all inserts, and those
-- rows need their hint bits set exactly the same.
--
-- Not a VACUUM statement in this file: migrations run inside a transaction, and
-- VACUUM refuses to. Re-runnable, since `set (...)` just restates the values.
alter table public.catalog_products set (
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor       = 0.02
);

alter table public.catalog_listings set (
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_analyze_scale_factor       = 0.02
);
