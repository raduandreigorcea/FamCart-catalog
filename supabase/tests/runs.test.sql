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
select plan(42);

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

-- ─── runs abandoned by a killed process ──────────────────────────────────────
-- A scrape closes its own run, and both ways of doing that need the process to
-- still be alive. SIGKILL is neither: when the OS reclaimed memory from an
-- Auchan crawl 28,000 products in, the row sat `running` with nobody to close
-- it. An abandoned row hides the last real result behind a crawl that looks like
-- it is still going.
select public.catalog_run_open('lidl') as run_id \gset ab_
update public.catalog_scrape_runs set started_at = now() - interval '2 days' where id = :'ab_run_id';

select is((select status from public.catalog_scrape_runs where id = :'ab_run_id'), 'running',
  'an abandoned run starts out looking exactly like a live one');

select is(public.catalog_run_reap(), 1, 'the reaper closes it');

select is((select status from public.catalog_scrape_runs where id = :'ab_run_id'), 'failed',
  'as FAILED, so it can never sweep');

select alike((select error from public.catalog_scrape_runs where id = :'ab_run_id'), '%abandoned%'::text,
  'saying so, rather than leaving somebody to guess why it has no counts'::text);

-- Twelve hours, not one: a full Carrefour crawl is about a day, and a threshold
-- shorter than the longest honest run would reap a crawl that is still working.
select public.catalog_run_open('lidl') as run_id \gset fresh_
select is(public.catalog_run_reap(), 0,
  'and leaves a run that only just started alone');

-- ─── a run that was never meant to see the whole shop ────────────────────────
-- Carrefour has 85,000 product pages and a CI job gets six hours, so a nightly
-- run reads one fifth of the sitemap. That is not a failure and it is not a
-- success: it imported what it saw and has no standing to say anything about
-- the rest.
--
-- It exists as its own status because of what somebody reads afterwards. Closing
-- these as `failed` would put a red row on the dashboard every single night,
-- and an alarm that fires nightly is one nobody reads -- so the real Carrefour
-- outage, when it comes, would look exactly like Monday.
select public.catalog_run_open('carrefour') as run_id \gset s_
update public.catalog_scrape_runs set started_at = now() - interval '3 hours' where id = :'s_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"C9","name":"Lapte Zuzu 1L","brand":"Zuzu","price":8.49,"currency":"RON",
   "quantity":1,"unit":"l","product_url":"https://carrefour.ro/produse/c9","available":true}
]$j$::jsonb, 'carrefour', :'s_run_id'::uuid);
select public.catalog_run_progress(:'s_run_id'::uuid, 1, 1, 0, 0);
select public.catalog_run_partial(:'s_run_id'::uuid, '--shard 1/5: one slice of the shop, by design');

select is((select status from public.catalog_scrape_runs where id = :'s_run_id'), 'partial',
  'a deliberate slice is partial, which is neither a failure nor a success');
select is((select count(*)::int from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id
            where r.slug = 'carrefour' and not l.available), 0,
  'THE RULE AGAIN: a slice marks nothing unavailable');
select is((select marked_unavailable from public.catalog_scrape_runs where id = :'s_run_id'), 0,
  'and says it swept nothing');
select ok(
  (select error from public.catalog_scrape_runs where id = :'s_run_id') like '%shard%',
  'keeping the reason, so "partial" is never a mystery');
select is((select count(*)::int from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id
            where r.slug = 'carrefour' and l.external_id = 'C9'), 1,
  'and what it DID see is imported and kept, like every other run');

-- A client must not be able to close a run at all, by any of the three doors.
select ok(not has_function_privilege('authenticated', 'public.catalog_run_partial(uuid, text)', 'execute'),
  'and no client may close a run as partial any more than as completed');

-- ─── a shop that really shrank ───────────────────────────────────────────────
-- THE TRAP THIS CLOSES. The floor compares against the last completed run, and
-- a `partial` run never becomes one. So a shop that genuinely halved is measured
-- against its old size forever: every future run is partial, and it can never
-- sweep again. Lidl went from 511 products to 251 and landed exactly there.
--
-- The count cannot tell that apart from a broken scraper -- both report half.
-- Where the count came from can: Lidl's crawl read 251 of the 251 URLs Lidl
-- itself advertised, with nothing failing to parse. A run that covered the
-- shop's own index is authoritative about the shop's size, whatever last week
-- said, so the delta floor does not apply to it.
select public.catalog_run_open('lidl') as run_id \gset c1_
update public.catalog_scrape_runs set started_at = now() - interval '4 hours' where id = :'c1_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"L1","name":"Ciocolata Lidl 100g","brand":"Lidl","price":5.99,"currency":"RON",
   "quantity":100,"unit":"g","product_url":"https://www.lidl.ro/p/l1","available":true},
  {"external_id":"L2","name":"Cafea Lidl 250g","brand":"Lidl","price":15.99,"currency":"RON",
   "quantity":250,"unit":"g","product_url":"https://www.lidl.ro/p/l2","available":true}
]$j$::jsonb, 'lidl', :'c1_run_id'::uuid);
select public.catalog_run_progress(:'c1_run_id'::uuid, 2, 2, 0, 0);
select is(public.catalog_run_complete(:'c1_run_id'::uuid) ->> 'status', 'completed',
  'a first full run completes and becomes the baseline');

-- The next night the shop lists ONE of the two, and the crawl reads all of it.
select public.catalog_run_open('lidl') as run_id \gset c2_
update public.catalog_scrape_runs set started_at = now() - interval '1 hour' where id = :'c2_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"L1","name":"Ciocolata Lidl 100g","brand":"Lidl","price":5.99,"currency":"RON",
   "quantity":100,"unit":"g","product_url":"https://www.lidl.ro/p/l1","available":true}
]$j$::jsonb, 'lidl', :'c2_run_id'::uuid);
select public.catalog_run_progress(:'c2_run_id'::uuid, 1, 1, 0, 0);

-- Half of two is on the floor, so without the coverage claim this is partial.
select is(
  public.catalog_run_complete(:'c2_run_id'::uuid, false) ->> 'status', 'partial',
  'halving alone is still refused, which is the whole point of the floor');

-- Same numbers, but the crawl says it read everything the shop advertised.
select public.catalog_run_open('lidl') as run_id \gset c3_
update public.catalog_scrape_runs set started_at = now() - interval '30 minutes' where id = :'c3_run_id';
select public.catalog_import_listings($j$[
  {"external_id":"L1","name":"Ciocolata Lidl 100g","brand":"Lidl","price":5.99,"currency":"RON",
   "quantity":100,"unit":"g","product_url":"https://www.lidl.ro/p/l1","available":true}
]$j$::jsonb, 'lidl', :'c3_run_id'::uuid);
select public.catalog_run_progress(:'c3_run_id'::uuid, 1, 1, 0, 0);
select is(
  public.catalog_run_complete(:'c3_run_id'::uuid, true) ->> 'status', 'completed',
  'a run that covered the shop own index is authoritative about the shop size');
select is((select available from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id
            where r.slug = 'lidl' and l.external_id = 'L2'), false,
  'and the product the shop stopped listing is finally marked gone');

-- The one thing coverage may NEVER override.
select public.catalog_run_open('lidl') as run_id \gset c4_
select public.catalog_run_progress(:'c4_run_id'::uuid, 0, 0, 0, 0);
select is(
  public.catalog_run_complete(:'c4_run_id'::uuid, true) ->> 'status', 'partial',
  'a run that found NOTHING is refused however much it claims to have covered');
select is((select count(*)::int from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id
            where r.slug = 'lidl'), 2,
  'and nothing was deleted by any of it -- gone from the shelf is not gone from the catalog');

select * from finish();
rollback;
