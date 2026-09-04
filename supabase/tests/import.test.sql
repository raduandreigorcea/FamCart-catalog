-- catalog_import_listings(), the only way anything enters this catalog.
--
-- The claims worth having a test for are the ones that are invisible when they
-- break: a re-import that quietly duplicates, an earned popularity that quietly
-- resets, a fuzzy merge that quietly puts two products in one row.
begin;
select plan(36);

delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

-- ─── the first import ────────────────────────────────────────────────────────
select lives_ok($$
  select public.catalog_import_listings($j$[
    {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
     "price":4.99,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
     "product_url":"https://www.auchan.ro/p/a1","available":true},
    {"external_id":"A2","name":"Lapte Zuzu 1.5% 1L","brand":"Zuzu",
     "price":8.49,"currency":"RON","quantity":1,"unit":"l","category":"dairy",
     "product_url":"https://www.auchan.ro/p/a2","available":true}
  ]$j$::jsonb, 'auchan')
$$, 'a first import runs');

select is((select count(*)::int from public.catalog_products), 2, 'two products landed');
select is((select count(*)::int from public.catalog_listings), 2, 'two listings landed');
select is((select count(*)::int from public.catalog_identifiers), 1, 'and the one GTIN offered');

-- ─── idempotency ─────────────────────────────────────────────────────────────
-- The claim the whole scheduling story rests on: running a scrape twice must not
-- double the catalog.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
     "price":4.99,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
     "product_url":"https://www.auchan.ro/p/a1","available":true},
    {"external_id":"A2","name":"Lapte Zuzu 1.5% 1L","brand":"Zuzu",
     "price":8.49,"currency":"RON","quantity":1,"unit":"l","category":"dairy",
     "product_url":"https://www.auchan.ro/p/a2","available":true}
  ]$j$::jsonb, 'auchan') ->> 'inserted')::int,
  0, 'the same rows again insert nothing');

select is((select count(*)::int from public.catalog_products), 2, 'and create no product');
select is((select count(*)::int from public.catalog_listings), 2, 'and no second listing');

-- ─── a price change ──────────────────────────────────────────────────────────
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
     "price":5.49,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
     "product_url":"https://www.auchan.ro/p/a1","available":true}
  ]$j$::jsonb, 'auchan') ->> 'updated')::int,
  1, 'a moved price is an update');

select is((select price from public.catalog_listings where external_id = 'A1'), 5.49,
  'the new price is on the listing');
select is((select previous_price from public.catalog_listings where external_id = 'A1'), 4.99,
  'and the old one is remembered');
select isnt((select last_price_at from public.catalog_listings where external_id = 'A1'), null,
  'with the moment it changed');

-- previous_price must mean "before this change", not "during the last run".
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
     "price":5.49,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
     "product_url":"https://www.auchan.ro/p/a1","available":true}
  ]$j$::jsonb, 'auchan') ->> 'unchanged')::int,
  1, 're-importing the same price changes nothing');
select is((select previous_price from public.catalog_listings where external_id = 'A1'), 4.99,
  'and previous_price still means the price before the change, not the last run');

-- ─── earned popularity survives everything ───────────────────────────────────
update public.catalog_products set add_count = 7
 where canonical_name = 'Apa plata Dorna 2L';

select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A1","name":"Apa plata Dorna 2L RENAMED","brand":"Dorna","gtin":"5941234567890",
     "price":6.99,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
     "product_url":"https://www.auchan.ro/p/a1","available":true}
  ]$j$::jsonb, 'auchan') ->> 'products_created')::int,
  0, 'a renamed listing resolves through its GTIN, not into a new product');

select is((select add_count from public.catalog_products where canonical_name = 'Apa plata Dorna 2L'), 7,
  'THE RULE: no import ever writes add_count');
select is((select canonical_name from public.catalog_products where add_count = 7), 'Apa plata Dorna 2L',
  'and a listing never renames the product it points at');
select is((select retailer_name from public.catalog_listings where external_id = 'A1'), 'Apa plata Dorna 2L RENAMED',
  'though the listing does record what the shop now calls it');

-- ─── matching, in order ──────────────────────────────────────────────────────
-- 1. GTIN wins, even when the names have nothing in common.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"C1","name":"Apă minerală plată Dorna, 2 litri","brand":"Dorna","gtin":"5941234567890",
     "price":4.79,"currency":"RON","quantity":2,"unit":"l",
     "product_url":"https://carrefour.ro/produse/c1","available":true}
  ]$j$::jsonb, 'carrefour') ->> 'products_created')::int,
  0, 'a GTIN merges two shops'' wording into one product');

select is((select listing_count from public.catalog_products where add_count = 7), 2,
  'and the product now has two listings');

-- 2. No GTIN, different wording: two products, and that is the correct answer.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"C2","name":"Lapte de consum Zuzu 1,5% grasime 1 L","brand":"Zuzu",
     "price":8.99,"currency":"RON","quantity":1,"unit":"l",
     "product_url":"https://carrefour.ro/produse/c2","available":true}
  ]$j$::jsonb, 'carrefour') ->> 'products_created')::int,
  1, 'without a GTIN, differently-worded names stay separate products');

-- 3. No GTIN, same fold: one product.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"C3","name":"Lapte Zuzu 1.5%, 1 l","brand":"Zuzu",
     "price":8.79,"currency":"RON","quantity":1,"unit":"l",
     "product_url":"https://carrefour.ro/produse/c3","available":true}
  ]$j$::jsonb, 'carrefour') ->> 'products_created')::int,
  0, 'but the same name punctuated differently is one product');

-- 4. THE RULE THE WHOLE MATCHING SECTION EXISTS FOR.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A9","name":"Apa plata Dorna 500ml","brand":"Dorna",
     "price":2.49,"currency":"RON","quantity":500,"unit":"ml",
     "product_url":"https://www.auchan.ro/p/a9","available":true}
  ]$j$::jsonb, 'auchan') ->> 'products_created')::int,
  1, 'a different SIZE is a different product, however alike the names read');

-- ─── blanks fill, values do not ──────────────────────────────────────────────
select is((select image_url from public.catalog_products where add_count = 7), null,
  'the product has no image yet');
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"C1","name":"Apă minerală plată Dorna, 2 litri","brand":"Dorna","gtin":"5941234567890",
     "price":4.79,"currency":"RON","quantity":2,"unit":"l",
     "image_url":"https://cdn.carrefour.ro/dorna.jpg",
     "product_url":"https://carrefour.ro/produse/c1","available":true}
  ]$j$::jsonb, 'carrefour') ->> 'products_created')::int,
  0, 'a later listing carrying an image does not create a product');
select is((select image_url from public.catalog_products where add_count = 7),
  'https://cdn.carrefour.ro/dorna.jpg', 'and a BLANK is filled from it');

-- ─── a GTIN that already belongs to somebody else ────────────────────────────
-- A row carrying a barcode owned by a DIFFERENT product cannot arise from the
-- barcode itself -- GTIN is the first resolution step, so such a row simply
-- resolves to that product. It arises when the row matched some OTHER way and
-- then offered a code that is already spoken for: a retailer that has started
-- putting the wrong EAN on a page, or a listing we already knew that suddenly
-- reports one.
--
-- The answer is to count it and leave both products alone. Reassigning the code
-- would silently move a barcode between products; merging on the strength of a
-- contradiction is how a catalog ends up telling somebody that chocolate is
-- water.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"A2","name":"Lapte Zuzu 1.5% 1L","brand":"Zuzu","gtin":"5941234567890",
     "price":8.49,"currency":"RON","quantity":1,"unit":"l","category":"dairy",
     "product_url":"https://www.auchan.ro/p/a2","available":true}
  ]$j$::jsonb, 'auchan') ->> 'conflicts')::int,
  1, 'a known listing offering another product''s barcode is a reported conflict');

select is((select count(*)::int from public.catalog_identifiers where identifier_value = '5941234567890'),
  1, 'and the code still has exactly one owner');

select is(
  (select p.canonical_name from public.catalog_identifiers i
     join public.catalog_products p on p.id = i.product_id
    where i.identifier_value = '5941234567890'),
  'Apa plata Dorna 2L',
  'which is still the product that had it first');

-- And the ordinary case: a row whose barcode IS the match resolves through it
-- rather than creating anything, which is the documented first priority.
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"L1","name":"Apa Dorna doi litri","brand":"Dorna","gtin":"5941234567890",
     "price":4.59,"currency":"RON","quantity":2,"unit":"l",
     "product_url":"https://www.lidl.ro/p/l1","available":true}
  ]$j$::jsonb, 'lidl') ->> 'products_created')::int,
  0, 'a barcode match creates no product even when the name is unrecognisable');

-- ─── one bad row costs one row ───────────────────────────────────────────────
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"OK1","name":"Paine alba 500g","brand":"Vel Pitar",
     "price":4.49,"currency":"RON","quantity":500,"unit":"g","category":"bakery",
     "product_url":"https://www.auchan.ro/p/ok1","available":true},
    {"external_id":"","name":"","product_url":"not-a-url"},
    {"external_id":"OK2","name":"Unt 200g","brand":"Napolact",
     "price":12.99,"currency":"RON","quantity":200,"unit":"g","category":"dairy",
     "product_url":"https://www.auchan.ro/p/ok2","available":true}
  ]$j$::jsonb, 'auchan') ->> 'inserted')::int,
  2, 'the good rows either side of a broken one still land');

select is(
  (public.catalog_import_listings($j$[{"external_id":"","name":"","product_url":"x"}]$j$::jsonb, 'auchan') ->> 'error_count')::int,
  1, 'and the broken row is counted');

select isnt(
  (public.catalog_import_listings($j$[{"external_id":"","name":"","product_url":"x"}]$j$::jsonb, 'auchan') -> 'errors' -> 0),
  null, 'with something in the errors array to read');

-- ─── malformed input that is not fatal ───────────────────────────────────────
select is(
  (public.catalog_import_listings($j$[
    {"external_id":"B1","name":"Bere Ursus 500ml","brand":"Ursus","gtin":"nope",
     "price":3.99,"currency":"RON","quantity":500,"unit":"ml","category":"alcohol",
     "product_url":"https://www.auchan.ro/p/b1","available":true}
  ]$j$::jsonb, 'auchan') ->> 'inserted')::int,
  1, 'a malformed barcode drops the barcode, not the row');
select is((select count(*)::int from public.catalog_identifiers where source = 'auchan' and identifier_value = 'nope'),
  0, 'and no rubbish identifier is stored');

-- ─── the retailer must exist ─────────────────────────────────────────────────
select throws_ok(
  $$select public.catalog_import_listings('[]'::jsonb, 'kaufland')$$,
  'P0001', null,
  'importing for a retailer with no row is a loud error, not a silent no-op');

-- ─── availability is not the importer's business ─────────────────────────────
select is((select count(*)::int from public.catalog_listings where not available), 0,
  'importing never marks anything unavailable -- that is a completed run''s job');

select * from finish();
rollback;
