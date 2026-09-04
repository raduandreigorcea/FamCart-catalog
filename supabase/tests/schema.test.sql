-- What the shape of the catalog guarantees, independent of anything that writes
-- to it. If a claim in 002 is load-bearing, it is asserted here.
begin;
select plan(40);

-- Every suite starts from an empty catalog rather than assuming one. `db reset`
-- leaves the three retailer rows from 002 in place and nothing else, but these
-- run against a developer's machine too, where a smoke test may have left rows.
delete from public.catalog_listings;
delete from public.catalog_identifiers;
delete from public.catalog_products;

-- ─── the fold ────────────────────────────────────────────────────────────────
-- The rule three runtimes have to agree on. The browser's copy is
-- normalizeSearchText() in src/lib/productSearch.ts; the TypeScript copy in
-- src/core/normalize.ts is pinned against test/fixtures/fold.json, which was
-- generated from THIS function.
select is(public.catalog_normalize('Apă Plată'), 'apa plata', 'strips diacritics and lowercases');
select is(public.catalog_normalize('  Lapte   UHT  '), 'lapte uht', 'collapses whitespace and trims');
select is(public.catalog_normalize(null), '', 'null folds to the empty string, never null');
select is(public.catalog_normalize('Șuncă Țărănească'), 'sunca taraneasca', 'handles the Romanian comma-below letters');

-- ─── the merge key ───────────────────────────────────────────────────────────
select is(
  public.catalog_merge_key('Coca-Cola Zero', 'Coca Cola Zero 1,5 L', 1.5, 'l'),
  public.catalog_merge_key('Coca Cola Zero', 'Coca-Cola zero 1.5l', 1.5, 'l'),
  'one product written two ways folds to one key');

select isnt(
  public.catalog_merge_key('Coca-Cola Zero', 'Coca Cola Zero 1,5 L', 1.5, 'l'),
  public.catalog_merge_key('Coca-Cola Zero', 'Coca Cola Zero 500ml', 500, 'ml'),
  'THE RULE: 1.5L and 500ml of the same drink are different products');

select is(
  public.catalog_merge_key('Nutline', 'Alune 135 g', 135, 'g'),
  public.catalog_merge_key('Nutline', 'Alune 0,135 kg', 0.135, 'kg'),
  'grams and kilograms reduce to one base unit');

select is(
  public.catalog_merge_key('Zuzu', 'Lapte 6 x 0,5 l', 3, 'l'),
  public.catalog_merge_key('Zuzu', 'Lapte 3L', 3, 'l'),
  'a multipack and its total are the same size');

select is(
  public.catalog_canonical_quantity(1.5, 'l'), 'ml:1500',
  'a whole number carries no trailing point');

select unalike(
  public.catalog_merge_key(null, 'Banane, +/- 1 kg', 1, 'kg'), '%+%'::text,
  'an approximation marker leaves no residue in the key'::text);

select alike(
  public.catalog_merge_key('Zuzu', 'Lapte 3.5% 1L', 1, 'l'), '%3 5\%%'::text,
  'a percentage is not mistaken for a quantity and survives into the key'::text);

-- ─── identity is enforced, not merely computed ───────────────────────────────
insert into public.catalog_products (canonical_name, brand, quantity, quantity_unit)
values ('Apa plata Dorna 2L', 'Dorna', 2, 'l');

select throws_ok(
  $$insert into public.catalog_products (canonical_name, brand, quantity, quantity_unit)
    values ('Apă plată Dorna 2 l', 'Dorna', 2, 'l')$$,
  '23505', null,
  'the unique index on merge_key IS the dedupe rule');

select is(
  (select count(*)::int from public.catalog_products), 1,
  'and the duplicate did not land');

-- ─── bounds ──────────────────────────────────────────────────────────────────
select throws_ok(
  $$insert into public.catalog_products (canonical_name, category) values ('X', 'nonsense')$$,
  '23514', null, 'category is a closed vocabulary');

select throws_ok(
  $$insert into public.catalog_products (canonical_name, quantity) values ('X', 5)$$,
  '23514', null, 'a quantity without a unit is refused');

select throws_ok(
  $$insert into public.catalog_products (canonical_name, quantity, quantity_unit) values ('X', 5, 'furlong')$$,
  '23514', null, 'the unit vocabulary is closed');

select throws_ok(
  $$insert into public.catalog_products (canonical_name, image_url) values ('X', 'http://insecure/x.jpg')$$,
  '23514', null, 'an image must be https');

select throws_ok(
  $$insert into public.catalog_retailers (slug, name, country, domain)
    values ('tesco', 'Tesco', 'PL', 'tesco.pl')$$,
  '23514', null,
  'a retailer country outside the app''s eleven markets is refused');

-- ─── price and stock live on the listing ─────────────────────────────────────
select hasnt_column('public', 'catalog_products', 'price',
  'a product has no price: three shops disagree and all three are right');
select hasnt_column('public', 'catalog_products', 'available',
  'a product has no availability either');
select has_column('public', 'catalog_listings', 'price', 'the listing carries the price');
select has_column('public', 'catalog_listings', 'available', 'the listing carries availability');
select has_column('public', 'catalog_listings', 'last_seen_at', 'and when it was last seen');

select throws_ok(
  format($$insert into public.catalog_listings
             (product_id, retailer_id, external_id, retailer_name, price, product_url)
           values (%L, (select id from public.catalog_retailers where slug='auchan'),
                   'X1', 'X', 9.99, 'https://www.auchan.ro/p/x1')$$,
         (select id from public.catalog_products limit 1)),
  '23514', null,
  'a price with no currency is a number nobody can spend');

-- ─── derived columns follow the rows ─────────────────────────────────────────
insert into public.catalog_listings
  (product_id, retailer_id, external_id, retailer_name, price, currency, product_url)
values
  ((select id from public.catalog_products limit 1),
   (select id from public.catalog_retailers where slug = 'auchan'),
   'A1', 'Apa plata Dorna 2L', 4.99, 'RON', 'https://www.auchan.ro/p/a1'),
  ((select id from public.catalog_products limit 1),
   (select id from public.catalog_retailers where slug = 'carrefour'),
   'C1', 'Apă plată Dorna 2 l', 4.79, 'RON', 'https://carrefour.ro/produse/c1');

select is((select listing_count from public.catalog_products limit 1), 2,
  'listing_count is maintained by a trigger, not by whoever imported');

select is((select popularity from public.catalog_products limit 1), 10,
  'popularity is generated: earned adds plus five per retailer carrying it');

select alike((select search_blob from public.catalog_products limit 1), '%apa plata dorna 2 l%'::text,
  'the blob carries the OTHER retailer''s wording, so their words still find the row'::text);

delete from public.catalog_listings where external_id = 'C1';
select is((select listing_count from public.catalog_products limit 1), 1,
  'and the count follows a listing going away');

-- ─── barcodes ────────────────────────────────────────────────────────────────
insert into public.catalog_identifiers (product_id, identifier_value, source)
values ((select id from public.catalog_products limit 1), '5941234567890', 'auchan');

select throws_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ((select id from public.catalog_products limit 1), 'not-a-barcode', 'auchan')$$,
  '23514', null, 'a GTIN is 8 to 14 digits and nothing else');

insert into public.catalog_products (canonical_name, brand) values ('Something Else', 'Other');
select throws_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ((select id from public.catalog_products where canonical_name = 'Something Else'),
            '5941234567890', 'carrefour')$$,
  '23505', null,
  'a GTIN identifies one article in the world, so it is unique across the catalog');

-- ─── who can reach what ──────────────────────────────────────────────────────
select ok(
  (select relrowsecurity from pg_class where oid = 'public.catalog_products'::regclass),
  'RLS is on for products');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.catalog_listings'::regclass),
  'RLS is on for listings');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.catalog_scrape_runs'::regclass),
  'RLS is on for scrape runs');

select ok(has_table_privilege('authenticated', 'public.catalog_products', 'select'),
  'a signed-in user may read the catalog');
select ok(not has_table_privilege('authenticated', 'public.catalog_products', 'insert'),
  'and may not write it -- there is no client write path to fall back on');
select ok(not has_table_privilege('authenticated', 'public.catalog_listings', 'update'),
  'not even to a listing');
select ok(not has_table_privilege('anon', 'public.catalog_products', 'select'),
  'and an anonymous caller sees nothing at all');

select ok(not has_function_privilege('authenticated', 'public.catalog_merge_key(text, text, numeric, text)', 'execute'),
  'the merge key is computable by nobody: knowing it means being able to collide with it');
select ok(not has_function_privilege('authenticated', 'public.catalog_import_listings(jsonb, text, uuid)', 'execute'),
  'and the one writer is service_role only');
select ok(has_function_privilege('authenticated', 'public.search_catalog(text, integer, text[], text[], boolean)', 'execute'),
  'while search is what a signed-in user is actually here for');

select * from finish();
rollback;
