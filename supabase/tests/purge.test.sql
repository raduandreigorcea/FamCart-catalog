-- catalog_purge_listings(): the one function that deletes.
--
-- What it must never do is the dangerous half: remove a product another shop
-- still sells, reach a product nobody scraped, or be callable by a signed-in
-- user. Those are the claims tested here.
begin;
select plan(10);

delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
   "price":4.99,"currency":"RON","quantity":2,"unit":"l",
   "product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Tricou print unisex, negru","brand":"Morning Glory","gtin":"5941111111116",
   "price":39.99,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a2","available":true}
]$j$::jsonb, 'auchan');

-- The same water at a second shop, merged onto one product by its GTIN.
select public.catalog_import_listings($j$[
  {"external_id":"C1","name":"Apa minerala plata Dorna 2 litri","brand":"Dorna","gtin":"5941234567890",
   "price":4.79,"currency":"RON","quantity":2,"unit":"l",
   "product_url":"https://carrefour.ro/produse/c1","available":true}
]$j$::jsonb, 'carrefour');

-- Made by hand in the admin: no listing, so no scraper can ever name it.
insert into public.catalog_products (canonical_name) values ('Produs adaugat manual');

select has_function('public', 'catalog_purge_listings', array['text[]', 'text'],
  'catalog_purge_listings takes the listing ids and the retailer');
select ok(not has_function_privilege('authenticated', 'public.catalog_purge_listings(text[], text)', 'execute'),
  'a signed-in user cannot delete from the catalog');

select is(public.catalog_purge_listings(array['A2'], 'auchan'),
  '{"listings_deleted": 1, "products_deleted": 1}'::jsonb,
  'a t-shirt only one shop listed goes, listing and product');
select is((select count(*)::int from public.catalog_products where canonical_name like 'Tricou%'), 0,
  'and the product is gone');
select is((select count(*)::int from public.catalog_identifiers where identifier_value = '5941111111116'), 0,
  'with its barcode');

select is(public.catalog_purge_listings(array['A1'], 'auchan'),
  '{"listings_deleted": 1, "products_deleted": 0}'::jsonb,
  'a product another shop still sells loses only this shop''s listing');
select is((select listing_count from public.catalog_products where canonical_name = 'Apa plata Dorna 2L'), 1,
  'and keeps the other one');

select is(public.catalog_purge_listings(array['NOPE'], 'carrefour'),
  '{"listings_deleted": 0, "products_deleted": 0}'::jsonb,
  'an id no listing carries removes nothing');
select is((select count(*)::int from public.catalog_products where canonical_name = 'Produs adaugat manual'), 1,
  'and a product made by hand is never reached');

select throws_ok($$select public.catalog_purge_listings(array['A1'], 'kaufland')$$, 'P0001', null,
  'an unknown retailer is an error, not a silent no-op');

select * from finish();
rollback;
