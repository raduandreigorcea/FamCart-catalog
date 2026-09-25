-- The run's own log, and the one door into it. What matters: the scraper can
-- write, only a catalog admin can read (Realtime applies the same policy), and
-- the listings a run touched are found by the stamps the importer leaves.
begin;
select plan(14);

delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;
delete from public.catalog_admins;

select has_table('public', 'catalog_run_logs', 'the log table exists');

-- ─── writing ─────────────────────────────────────────────────────────────────
select public.catalog_run_open('auchan') as run_id \gset r_
update public.catalog_scrape_runs set started_at = now() - interval '2 hours' where id = :'r_run_id';

select is(
  public.catalog_run_log(:'r_run_id'::uuid, $j$[
    {"t":"2026-09-25T01:20:00Z","level":"info","scope":"auchan","message":"run opened","fields":{"run":"x"}},
    {"t":"2026-09-25T01:20:01Z","level":"warn","scope":"auchan","message":"page failed"},
    {"t":"2026-09-25T01:20:02Z","level":"shout","scope":"auchan","message":"odd level"}
  ]$j$::jsonb),
  3, 'the scraper writes a batch and is told how many landed');
select is((select count(*)::int from public.catalog_run_logs where run_id = :'r_run_id'), 3,
  'all three are there');
select is((select level from public.catalog_run_logs where message = 'odd level'), 'info',
  'a level the table does not know is kept as info rather than refused');
select is((select fields ->> 'run' from public.catalog_run_logs where message = 'run opened'), 'x',
  'the fields survive as json');
select is(
  public.catalog_run_log('00000000-0000-0000-0000-000000000000'::uuid,
    '[{"level":"info","scope":"x","message":"lost"}]'::jsonb),
  0, 'a run that does not exist takes nothing, and does not throw');

-- ─── the listings a run touched ──────────────────────────────────────────────
select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","price":4.99,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Lapte Zuzu 1L","price":8.49,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a2","available":true}
]$j$::jsonb, 'auchan', :'r_run_id'::uuid);
select public.catalog_run_progress(:'r_run_id'::uuid, 2, 2, 0, 0);
select public.catalog_run_complete(:'r_run_id'::uuid);

select public.catalog_run_open('auchan') as run_id \gset s_
update public.catalog_scrape_runs set started_at = now() - interval '1 hour' where id = :'s_run_id';
-- A1 repriced, A2 missing, A3 new.
select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","price":5.49,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A3","name":"Paine alba 500g","price":4.49,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a3","available":true}
]$j$::jsonb, 'auchan', :'s_run_id'::uuid);
select public.catalog_run_progress(:'s_run_id'::uuid, 2, 2, 0, 0);
select public.catalog_run_complete(:'s_run_id'::uuid, true);

-- ─── every door is locked ────────────────────────────────────────────────────
set local role authenticated;
select is((select count(*)::int from public.catalog_run_logs), 0,
  'a signed-in non-admin reads no log lines');
select throws_ok(
  format('select public.catalog_run_log(%L::uuid, %L::jsonb)', :'r_run_id', '[]'),
  '42501', null, 'and cannot write any');
select throws_ok(
  format('select * from public.catalog_admin_run_listings(%L::uuid, %L)', :'s_run_id', 'new'),
  '42501', null, 'nor list what a run touched');
reset role;

insert into public.catalog_admins (user_id, note) values ('admin-1', 'the test');
set local request.jwt.claims = '{"sub":"admin-1"}';
set local role authenticated;

select is((select count(*)::int from public.catalog_run_logs), 3, 'an admin reads them');
select results_eq(
  format('select external_id from public.catalog_admin_run_listings(%L::uuid, %L)', :'s_run_id', 'new'),
  $$values ('A3')$$, 'new: first seen by this run');
select results_eq(
  format('select external_id from public.catalog_admin_run_listings(%L::uuid, %L)', :'s_run_id', 'repriced'),
  $$values ('A1')$$, 'repriced: the price moved in this run, and it was not new');
select results_eq(
  format('select external_id from public.catalog_admin_run_listings(%L::uuid, %L)', :'s_run_id', 'gone'),
  $$values ('A2')$$, 'gone: swept by this completed run');
reset role;

-- ─── a deleted run takes its log with it ─────────────────────────────────────
delete from public.catalog_scrape_runs where id = :'r_run_id';
select is((select count(*)::int from public.catalog_run_logs), 0, 'the log goes with its run');

select * from finish();
rollback;
