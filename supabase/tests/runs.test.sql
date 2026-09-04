-- The scrape run lifecycle, and the rule the whole file exists for:
--
--   only a run that finished, and finished plausibly, may decide that a product
--   is no longer on a retailer's shelf.
--
-- NOTE ON TIME. now() is frozen for the whole of a transaction, so every run
-- opened here would otherwise share one watermark and "not seen since" could
-- never be true. Each run's started_at is therefore set explicitly. That is a
-- property of the test, not of the schema: in production the runs are minutes or
-- days apart and catalog_run_open's default is right.
begin;
select plan(24);

delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

-- ─── a healthy first run ─────────────────────────────────────────────────────
select public.catalog_run_open('auchan') as run_id \gset r1_
update public.catalog_scrape_runs set started_at = now() - interval '3 hours' where id = :'r1_run_id';

select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","price":4.99,"currency":"RON",
   "quantity":2,"unit":"l","product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Lapte Zuzu 1L","brand":"Zuzu","price":8.49,"currency":"RON",
   "quantity":1,"unit":"l","product_url":"https://www.auchan.ro/p/a2","available":true},
  {"external_id":"A3","name":"Paine alba 500g","brand":"Vel Pitar","price":4.49,"currency":"RON",
   "quantity":500,"unit":"g","product_url":"https://www.auchan.ro/p/a3","available":true}
]$j$::jsonb, 'auchan', :'r1_run_id'::uuid);
select public.catalog_run_progress(:'r1_run_id'::uuid, 3, 3, 0, 0);

select is(public.catalog_run_complete(:'r1_run_id'::uuid) ->> 'status', 'completed',
  'a run that found everything completes');
select is((select status from public.catalog_scrape_runs where id = :'r1_run_id'), 'completed',
  'and the row says so');
select isnt((select finished_at from public.catalog_scrape_runs where id = :'r1_run_id'), null,
  'and carries a finish time');
select is((select count(*)::int from public.catalog_listings where not available), 0,
  'with nothing marked unavailable, because nothing was missing');

-- ─── a run that FAILS sweeps nothing ─────────────────────────────────────────
-- It saw one product of three. If "did not see" meant "gone", this would wipe
-- two thirds of Auchan.
select public.catalog_run_open('auchan') as run_id \gset f_
update public.catalog_scrape_runs set started_at = now() - interval '2 hours' where id = :'f_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","price":4.99,"currency":"RON",
   "quantity":2,"unit":"l","product_url":"https://www.auchan.ro/p/a1","available":true}
]$j$::jsonb, 'auchan', :'f_run_id'::uuid);
select public.catalog_run_progress(:'f_run_id'::uuid, 1, 1, 0, 3);
select public.catalog_run_fail(:'f_run_id'::uuid, 'connection reset by peer');

select is((select status from public.catalog_scrape_runs where id = :'f_run_id'), 'failed',
  'a failed run is recorded as failed');
select is((select count(*)::int from public.catalog_listings where not available), 0,
  'THE RULE: a failed run marks nothing unavailable');
select is((select marked_unavailable from public.catalog_scrape_runs where id = :'f_run_id'), 0,
  'and says it swept nothing');
select is((select error from public.catalog_scrape_runs where id = :'f_run_id'), 'connection reset by peer',
  'keeping the reason for whoever looks');

-- ─── the sanity floor ────────────────────────────────────────────────────────
-- A run that COMPLETES but found a third of what it found last time. Nothing in
-- the run itself is wrong -- no exception, no error -- which is exactly why the
-- count has to be checked.
select public.catalog_run_open('auchan') as run_id \gset p_
update public.catalog_scrape_runs set started_at = now() - interval '1 hour' where id = :'p_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","price":3.99,"currency":"RON",
   "quantity":2,"unit":"l","product_url":"https://www.auchan.ro/p/a1","available":true}
]$j$::jsonb, 'auchan', :'p_run_id'::uuid);
select public.catalog_run_progress(:'p_run_id'::uuid, 1, 1, 0, 0);

select is(public.catalog_run_complete(:'p_run_id'::uuid) ->> 'status', 'partial',
  'a run below half the last completed count lands as partial');
select is((select count(*)::int from public.catalog_listings where not available), 0,
  'and sweeps nothing');
select alike((select error from public.catalog_scrape_runs where id = :'p_run_id'), '%floor%'::text,
  'saying why, so it is not left to be inferred from the counts'::text);
select is((select price from public.catalog_listings where external_id = 'A1'), 3.99,
  'but what it DID see was imported: refusing to sweep is not refusing to learn');

-- ─── a run that found nothing ────────────────────────────────────────────────
select public.catalog_run_open('auchan') as run_id \gset z_
update public.catalog_scrape_runs set started_at = now() - interval '30 minutes' where id = :'z_run_id';
select is(public.catalog_run_complete(:'z_run_id'::uuid) ->> 'status', 'partial',
  'a run that found nothing never completes');
select is(public.catalog_run_complete(:'z_run_id'::uuid) ->> 'reason', 'already_closed',
  'and closing it twice is a no-op rather than a second verdict');
select is((select count(*)::int from public.catalog_listings where not available), 0,
  'THE RULE: zero products never empties a retailer');

-- ─── the sweep that is supposed to happen ────────────────────────────────────
-- Two of three, which is above the floor. The bread really was delisted.
select public.catalog_run_open('auchan') as run_id \gset g_
select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","price":4.99,"currency":"RON",
   "quantity":2,"unit":"l","product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Lapte Zuzu 1L","brand":"Zuzu","price":8.49,"currency":"RON",
   "quantity":1,"unit":"l","product_url":"https://www.auchan.ro/p/a2","available":true}
]$j$::jsonb, 'auchan', :'g_run_id'::uuid);
select public.catalog_run_progress(:'g_run_id'::uuid, 2, 2, 0, 0);

select is(public.catalog_run_complete(:'g_run_id'::uuid) ->> 'status', 'completed',
  'two of three is above the floor and completes');
select is((select available from public.catalog_listings where external_id = 'A3'), false,
  'the listing nobody saw is marked unavailable');
select is((select available from public.catalog_listings where external_id = 'A1'), true,
  'and the ones that were seen are untouched');
select is((select marked_unavailable from public.catalog_scrape_runs where id = :'g_run_id'), 1,
  'the run reports exactly what it swept');

-- ─── absence is not deletion ─────────────────────────────────────────────────
select is((select count(*)::int from public.catalog_products), 3,
  'no product was deleted');
select is((select count(*)::int from public.catalog_listings), 3,
  'and no listing either -- "off the shelf" and "not a product" are different facts');
select ok(
  (select last_seen_at from public.catalog_listings where external_id = 'A3')
  < (select started_at from public.catalog_scrape_runs where id = :'g_run_id'),
  'and last_seen_at still records when it was last there');

-- ─── one retailer's failure is not another's ─────────────────────────────────
select public.catalog_run_open('carrefour') as run_id \gset x_
select public.catalog_run_fail(:'x_run_id'::uuid, 'blocked');
select is((select count(*)::int from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id
            where r.slug = 'auchan' and not l.available), 1,
  'a Carrefour failure changes nothing about Auchan');

select throws_ok(
  $$select public.catalog_run_open('kaufland')$$,
  'P0001', null,
  'opening a run for a retailer with no row is a loud error');

select * from finish();
rollback;
