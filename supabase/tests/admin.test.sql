-- The admin surface. Two things worth testing: that every door is locked, and
-- that the filters narrow the thing they claim to narrow.
begin;
select plan(24);

delete from public.catalog_scrape_runs;
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;
delete from public.catalog_admins;

select public.catalog_import_listings($j$[
  {"external_id":"A1","name":"Apa plata Dorna 2L","brand":"Dorna","gtin":"5941234567890",
   "price":4.99,"currency":"RON","quantity":2,"unit":"l","category":"drinks",
   "image_url":"https://cdn.auchan.ro/a1.jpg",
   "product_url":"https://www.auchan.ro/p/a1","available":true},
  {"external_id":"A2","name":"Lapte Zuzu 1L","brand":"Zuzu","price":8.49,"currency":"RON",
   "quantity":1,"unit":"l","category":"dairy","product_url":"https://www.auchan.ro/p/a2","available":false},
  {"external_id":"A3","name":"Ceva fara nimic","price":1.99,"currency":"RON",
   "product_url":"https://www.auchan.ro/p/a3","available":true}
]$j$::jsonb, 'auchan');
select public.catalog_import_listings($j$[
  {"external_id":"C1","name":"Lapte Zuzu 1 l","brand":"Zuzu","price":8.99,"currency":"RON",
   "quantity":1,"unit":"l","category":"dairy","product_url":"https://carrefour.ro/produse/c1","available":true}
]$j$::jsonb, 'carrefour');

-- ─── every door is locked ────────────────────────────────────────────────────
-- The caller here is nobody: requesting_user_id() is null and catalog_admins is
-- empty. 002 revoked every table privilege from `authenticated`, so these
-- functions are the whole surface and each has to check for itself.
select throws_ok($$select * from public.catalog_admin_products()$$, '42501', null,
  'browse refuses a non-admin');
select throws_ok($$select public.catalog_admin_create_product('X')$$, '42501', null,
  'create refuses a non-admin');
select throws_ok(
  $$select public.catalog_admin_update_product('00000000-0000-0000-0000-000000000000'::uuid, 'X')$$,
  '42501', null, 'update refuses a non-admin');
select throws_ok(
  $$select public.catalog_admin_delete_product('00000000-0000-0000-0000-000000000000'::uuid)$$,
  '42501', null, 'delete refuses a non-admin');
select throws_ok($$select public.catalog_stats()$$, '42501', null,
  'and so does the health report');

-- ─── become one ──────────────────────────────────────────────────────────────
insert into public.catalog_admins (user_id, note) values ('admin-1', 'the test');
set local request.jwt.claims = '{"sub":"admin-1"}';

select is((select count(*)::int from public.catalog_admin_products()), 3,
  'an admin sees every product');
select is((select total_count from public.catalog_admin_products() limit 1), 3::bigint,
  'and total_count counts the table when nothing is filtered');

-- ─── the filters narrow, and total_count follows them ────────────────────────
select is((select count(*)::int from public.catalog_admin_products(p_retailer := 'carrefour')), 1,
  'p_retailer narrows to one shop''s products');
select is((select total_count from public.catalog_admin_products(p_retailer := 'carrefour') limit 1), 1::bigint,
  'and total_count follows the FILTER, not the table');
select is((select count(*)::int from public.catalog_admin_products(p_has_barcode := false)), 2,
  'p_has_barcode false finds the products with no code');
select is((select count(*)::int from public.catalog_admin_products(p_has_brand := false)), 1,
  'p_has_brand false finds the unbranded one');
select is((select count(*)::int from public.catalog_admin_products(p_has_image := true)), 1,
  'p_has_image true finds the one with a picture');
select is((select count(*)::int from public.catalog_admin_products(p_category := 'dairy')), 1,
  'p_category narrows to a shelf');
select is((select count(*)::int from public.catalog_admin_products(p_available := false)), 0,
  'p_available false finds nothing: the milk is out of stock at Auchan but in stock at Carrefour');
select is((select count(*)::int from public.catalog_admin_products(p_query := 'dorna')), 1,
  'p_query searches the blob');

-- A bad filter VALUE is a bug in the caller, and an empty result would look
-- exactly like an empty category.
select throws_ok($$select * from public.catalog_admin_products(p_category := 'nonsense')$$,
  'P0001', null, 'an unknown category is an error, not an empty page');
select throws_ok($$select * from public.catalog_admin_products(p_retailer := 'kaufland')$$,
  'P0001', null, 'and so is an unknown retailer');

-- ─── create, update, delete ──────────────────────────────────────────────────
select public.catalog_admin_create_product('Faina alba 1kg', 'Baneasa', 'pantry', 1, 'kg', '5949000000009')
  as new_id \gset
select is((select listing_count from public.catalog_products where id = :'new_id'), 0,
  'a hand-made product has no listing: nobody is selling it yet');

select throws_ok(
  $$select public.catalog_admin_create_product('Faina alba 1 kg', 'Baneasa', 'pantry', 1, 'kg')$$,
  'P0001', null,
  'and the merge key still refuses a second copy of it');

-- The convention that matters: the dashboard submits every field on every save,
-- so null has to mean "leave alone" or correcting a name would clear the size.
select lives_ok(
  format($$select public.catalog_admin_update_product(%L::uuid, 'Faina alba superioara 1kg')$$, :'new_id'),
  'a name-only update runs');
select is((select quantity from public.catalog_products where id = :'new_id'), 1::numeric,
  'and null LEFT THE SIZE ALONE rather than clearing it');
select is((select category from public.catalog_products where id = :'new_id'), 'pantry',
  'and the category too');

select public.catalog_admin_delete_product(:'new_id'::uuid);
select is((select count(*)::int from public.catalog_products where id = :'new_id'), 0,
  'delete removes the product');

-- ─── the alarm ───────────────────────────────────────────────────────────────
select public.catalog_run_open('auchan') as run_id \gset a_
update public.catalog_scrape_runs set started_at = now() - interval '1 hour' where id = :'a_run_id';
select public.catalog_run_progress(:'a_run_id'::uuid, 3, 3, 0, 0);
select public.catalog_run_complete(:'a_run_id'::uuid);

select is(
  (select (x ->> 'slug') from jsonb_array_elements(public.catalog_stats() -> 'retailers') x
    where x ->> 'slug' = 'auchan'),
  'auchan',
  'the health report names every retailer, so a scraper that stopped reporting is visible');

select * from finish();
rollback;
