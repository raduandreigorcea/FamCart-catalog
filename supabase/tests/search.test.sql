-- search_catalog, lookup_barcode and bump_product_popularity: the three
-- functions the app calls, and the ranking behind the first of them.
--
-- These names and ARGUMENT NAMES are a cross-repository contract. PostgREST
-- resolves an RPC by the argument names in the request body, so a rename here
-- breaks src/lib/productSuggestions.ts silently -- the catalog leg of its
-- Promise.allSettled returns [] and the dropdown just gets worse. The app's CI
-- runs this suite for that reason.
begin;
select plan(37);

delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
   "price":4.99,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
   "product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Lapte Zuzu 1L","brand":"Zuzu","price":8.49,"currency":"RON",
   "quantity":1,"unit":"l","category":"dairy","product_url":"https://www.auchan.ro/p/a2","available":true},
  {"external_id":"A3","name":"Ciocolata Milka Oreo 100g","brand":"Milka","price":9.99,"currency":"RON",
   "quantity":100,"unit":"g","category":"snacks","product_url":"https://www.auchan.ro/p/a3","available":true},
  {"external_id":"A4","name":"Dorna","brand":"Dorna","price":3.49,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a4","available":true},
  {"external_id":"A5","name":"Tableta cu lapte alpin 100g","brand":"Milka","price":8.99,"currency":"RON",
   "quantity":100,"unit":"g","category":"snacks","product_url":"https://www.auchan.ro/p/a5","available":true}
]$j$::jsonb, 'auchan');

-- The same water, at a second shop, worded differently. Its GTIN merges it, so
-- there is one product with two listings and two spellings.
select public.catalog_import_listings($j$[
  {"external_id":"C1","name":"Apă minerală plată Dorna 2 litri","brand":"Dorna","gtin":"5941234567890",
   "price":4.79,"currency":"RON","quantity":2,"unit":"l",
   "product_url":"https://carrefour.ro/produse/c1","available":true}
]$j$::jsonb, 'carrefour');

-- ─── the contract's shape ────────────────────────────────────────────────────
select lives_ok($$select * from public.search_catalog('apa', 100)$$,
  'the app''s two-argument call resolves, so p_markets and p_langs must keep defaults');
select lives_ok($$select * from public.search_catalog('apa', 100, array['RO'], array['ro'])$$,
  'and so does its four-argument one');
select has_function('public', 'search_catalog',
  array['text','integer','text[]','text[]','boolean'],
  'search_catalog keeps its five-argument signature');
select has_function('public', 'lookup_barcode', array['text[]','text[]'],
  'lookup_barcode keeps p_codes and an optional p_langs');
select has_function('public', 'bump_product_popularity', array['text','text'],
  'bump_product_popularity takes exactly p_name and p_maker');

-- ─── one row per product ─────────────────────────────────────────────────────
select is((select count(*)::int from public.search_catalog('dorna 2', 50)), 1,
  'a product two shops carry is ONE row, not one per listing');
select is((select retailers from public.search_catalog('dorna 2', 50)), array['auchan','carrefour'],
  'and it names both of them');
select is((select min_price from public.search_catalog('dorna 2', 50)), 4.79,
  'reporting the cheaper price');

-- ─── the rungs ───────────────────────────────────────────────────────────────
select is((select match_type from public.search_catalog('dorna', 50) limit 1), 'name_exact',
  'a name that IS the query ranks first');
select is((select name from public.search_catalog('dorna', 50) limit 1), 'Dorna',
  'and it is the exactly-named product, not the more popular one');

-- THE BONUS RULE. "Dorna" the product has one listing; "Apa plata Dorna 2L" has
-- two and is cheaper and available, so every bonus favours it -- and it still
-- must not overtake an exact name match.
select ok(
  (select relevance_score from public.search_catalog('dorna', 50) where name = 'Dorna')
  > (select relevance_score from public.search_catalog('dorna', 50) where name = 'Apa plata Dorna 2L'),
  'a bonus can never lift a row over a better match: rungs are 10 apart, bonuses total 9');

select is((select match_type from public.search_catalog('apa plata', 50) limit 1), 'name_prefix',
  'a name starting with the query is the next rung');
select is((select match_type from public.search_catalog('milka', 50) limit 1), 'brand_exact',
  'a query that IS a brand matches it exactly');

-- "milk" prefixes the brand Milka. The Oreo bar has "milka" IN its name so it
-- matches a rung higher; the tablet does not, and is the row that exercises the
-- brand prefix.
select is(
  (select match_type from public.search_catalog('milk', 50) where name = 'Tableta cu lapte alpin 100g'),
  'brand_prefix', 'a brand the query prefixes is a rung of its own');
select ok(
  (select relevance_score from public.search_catalog('milk', 50) where name = 'Ciocolata Milka Oreo 100g')
  > (select relevance_score from public.search_catalog('milk', 50) where name = 'Tableta cu lapte alpin 100g'),
  'and it ranks below the product whose NAME carried the word');
select is((select match_type from public.search_catalog('oreo ciocolata', 50) limit 1), 'name_tokens',
  'words in any order still match the name');

-- The other shop's wording finds the row, which is what search_blob is for.
select is((select count(*)::int from public.search_catalog('minerala', 50)), 1,
  'a word only ONE retailer used still finds the product');

-- ─── the market filter ───────────────────────────────────────────────────────
select ok((select count(*) from public.search_catalog('lapte', 50, array['RO'])) > 0,
  'a Romanian phone gets Romanian shops');
select is((select count(*)::int from public.search_catalog('lapte', 50, array['DE'])), 0,
  'THE REVERSAL: a German phone gets nothing, because it cannot buy any of this');
select ok((select count(*) from public.search_catalog('lapte', 50, null)) > 0,
  'and no market at all means no filter, not no results');

-- ─── a disabled retailer disappears from search, without losing its data ─────
update public.catalog_retailers set enabled = false where slug = 'auchan';
select is((select count(*)::int from public.search_catalog('lapte', 50)), 0,
  'a disabled retailer stops answering');
select is((select count(*)::int from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id where r.slug = 'auchan'), 5,
  'but its listings are still there, waiting to be re-enabled');
update public.catalog_retailers set enabled = true where slug = 'auchan';

-- ─── p_langs is accepted and ignored ─────────────────────────────────────────
select is(
  (select count(*)::int from public.search_catalog('lapte', 50, null, array['de'])),
  (select count(*)::int from public.search_catalog('lapte', 50, null, array['ro'])),
  'p_langs changes nothing: every product here is Romanian and there is no second language to prefer');

-- ─── fuzzy is opt-in ─────────────────────────────────────────────────────────
-- The reason it moved behind a flag: an empty result now means "no shop we read
-- lists this", which is true and useful. Guessing turned that into `beer`
-- answering with `Beef`.
select is((select count(*)::int from public.search_catalog('ciocolota', 50)), 0,
  'a typo returns nothing by default -- an empty answer is a real answer now');
select ok((select count(*) from public.search_catalog('ciocolata milk', 50, null, null, true)) > 0,
  'and the nearest thing is available when it is asked for explicitly');

-- ─── input is data, not syntax ───────────────────────────────────────────────
select is((select count(*)::int from public.search_catalog('100%', 50)), 0,
  'a percent sign is a percent sign, not a LIKE wildcard');
select is((select count(*)::int from public.search_catalog('_', 50)), 0,
  'and neither is an underscore');
select is((select count(*)::int from public.search_catalog('a', 50)), 0,
  'a single character is too short to be a question');

-- ─── barcode ─────────────────────────────────────────────────────────────────
select is((select name from public.lookup_barcode(array['5941234567890'])), 'Apa plata Dorna 2L',
  'a scanned code resolves exactly');
select is((select count(*)::int from public.lookup_barcode(array['0000000000000'])), 0,
  'and an unknown one resolves to nothing rather than a guess');

-- ─── popularity ──────────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"user-1"}';
select public.bump_product_popularity('Apă minerală plată Dorna 2 litri', 'Dorna');
select is((select add_count from public.catalog_products where canonical_name = 'Apa plata Dorna 2L'), 1,
  'a bump sent with the OTHER shop''s wording still finds the product');

-- ─── the shopping list's lookup ──────────────────────────────────────────────
-- A list row knows a name and a maker and nothing else, so showing which shop it
-- came from is a lookup -- and one for the whole list at once, because twenty
-- rows must not mean twenty round trips.
select has_function('public', 'catalog_shops_for', array['text[]'],
  'catalog_shops_for takes an array of names');

select is(
  (select retailers from public.catalog_shops_for(array['Apa plata Dorna 2L'])),
  array['auchan', 'carrefour'],
  'it names every shop carrying the product');

select is(
  (select count(*)::int from public.catalog_shops_for(array['Nothing Called This'])),
  0, 'and says nothing about a name no shop uses');

-- The row on somebody's list was very often picked out of a dropdown showing a
-- SHOP's wording rather than ours, so the shop's own name has to resolve too.
select is(
  (select name from public.catalog_shops_for(array['Apă minerală plată Dorna 2 litri'])),
  'Apa plata Dorna 2L',
  'a retailer''s own wording resolves to the product it belongs to');

select is(
  (select count(*)::int from public.catalog_shops_for(array['Apa plata Dorna 2L', 'Lapte Zuzu 1L', 'Dorna'])),
  3, 'a whole list is one call');

-- A disabled shop stops being reported here for the same reason it stops
-- answering search: its rows are still there, but nobody can buy from it.
update public.catalog_retailers set enabled = false where slug = 'carrefour';
select is(
  (select retailers from public.catalog_shops_for(array['Apa plata Dorna 2L'])),
  array['auchan'],
  'a disabled shop is not reported as carrying anything');
update public.catalog_retailers set enabled = true where slug = 'carrefour';

select * from finish();
rollback;
