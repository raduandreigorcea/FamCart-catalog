-- Schema invariants for the product catalog.
--
-- Run against the catalog project's own local stack, which is a SECOND stack
-- alongside the app's:
--
--   npx supabase --workdir catalog db start
--   npx supabase --workdir catalog db reset    -- never skip this; see below
--   npx supabase --workdir catalog test db
--
-- THE RESET IS NOT OPTIONAL. `db start` restores from a local backup where one
-- exists and skips the migrations entirely, so the suite runs against whatever
-- the backup held — which after any migration edit is not what is in
-- catalog/supabase/migrations/. It passes and tells you nothing.
--
-- What these assert, all of which the client cannot check for itself:
--
--   1. The fold is the fold. catalog_normalize() agrees with the app database's
--      product_search_text() and with normalizeSearchText() in the browser, and
--      it is the derived columns' only author — a client cannot supply a
--      matching key, because a discovered product's key becomes everyone's.
--   2. The merge key is conservative. Two spellings of one name collapse; two
--      package sizes do not.
--   3. A GTIN names one product, globally, and is never accepted in a shape a
--      scanner could not have produced.
--   4. Aliases widen the search blob without overwriting anything, in both
--      directions and through a rename, and one product has at most one name per
--      language.
--   5. The bounds hold: markets the app can actually send, categories that have
--      translations, a quantity that cannot exist without its unit, and an
--      image URL that cannot be a javascript: payload in an <img src>.
--   6. Reads are for signed-in users; anon reaches nothing and no client role
--      can write. Provenance is admin-only.
--
-- Everything runs inside a rolled-back transaction, so it leaves no rows.

begin;
select plan(52);

-- Start from an empty catalog, whatever this database happens to hold. Rolled
-- back with everything else, so a development database that has been seeded is
-- untouched -- but WITHOUT this, running the suite after `npm run catalog:seed`
-- produces dozens of failures that every one of them looks like a ranking or a
-- dedupe bug and none of them is. The documented flow is `db reset && test db`;
-- this makes the suite correct even when someone forgets.
delete from public.catalog_products;
delete from public.catalog_bump_limits;
delete from public.catalog_admins;

-- ─── 1. the fold ─────────────────────────────────────────────────────────────
-- Called as the migration role, which is the only role that may.

select is(
  public.catalog_normalize('  Apă   Plată 2L ', 'Dorna'),
  'apa plata 2l dorna',
  'catalog_normalize folds case, diacritics, whitespace and appends the brand'
);

select is(
  public.catalog_normalize('Lay''s', null),
  'lay''s',
  'catalog_normalize leaves punctuation alone (product_search_text does too)'
);

select is(
  public.catalog_normalize('Müsli', ''),
  'musli',
  'an empty brand adds nothing, not a trailing space'
);

select is(
  public.catalog_normalize(null, null),
  '',
  'a null name folds to empty rather than null'
);

-- The three languages whose diacritics matter most here, in one string.
--
-- THE EN-DASH BECOMES A HYPHEN, and that is unaccent's doing rather than a
-- decision made here: its dictionary maps typographic punctuation as well as
-- accented letters. The browser's normalizeSearchText() uses NFD +
-- \p{Diacritic}, which does not, so the two folds genuinely disagree on '–',
-- '—' and curly quotes.
--
-- It does not bite, and the reason is worth knowing before someone "fixes" one
-- of them. search_catalog() folds the QUERY server-side, through this same
-- function, so both sides of every match are folded by the same rule. The
-- browser's copy is used for the client-side dedupe key (productKey) and for
-- ordering, never for deciding whether a row matches. A drift here costs a
-- duplicate row in a dropdown, not a product that cannot be found.
select is(
  public.catalog_normalize('Ciocolată Kinder Bueno – Größe crème', null),
  'ciocolata kinder bueno - grosse creme',
  'Romanian, German and French diacritics fold, and unaccent maps the en-dash too'
);

-- ─── fixtures ────────────────────────────────────────────────────────────────

insert into public.catalog_products (id, product_type, canonical_name, name_lang, category, markets, base_weight)
values ('00000000-0000-0000-0000-00000000a001', 'generic', '  Apă   Plată ', 'ro', 'drinks', array['RO','DE','GB'], 100);

insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand, quantity, quantity_unit)
values ('00000000-0000-0000-0000-00000000a002', 'commercial', 'Pepsi Zero 500ml', 'en', 'Pepsi', 500, 'ml');

-- ─── 2. derived columns ──────────────────────────────────────────────────────

select is(
  (select normalized_name from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001'),
  'apa plata',
  'normalized_name is derived on insert, whatever the caller passed'
);

select is(
  (select search_blob from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001'),
  'apa plata',
  'a product with no aliases has its name as its whole search blob'
);

select is(
  (select normalized_name from public.catalog_products where id = '00000000-0000-0000-0000-00000000a002'),
  'pepsi zero 500ml pepsi',
  'the brand is part of the merge key, so two brands of one name stay apart'
);

select is(
  (select popularity from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001'),
  100,
  'popularity is base_weight + add_count'
);

update public.catalog_products set add_count = 7 where id = '00000000-0000-0000-0000-00000000a001';

select is(
  (select popularity from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001'),
  107,
  'popularity follows add_count without anyone writing it'
);

-- A client cannot pin the matching key by supplying it: the trigger overwrites.
update public.catalog_products
   set normalized_name = 'whatever i like', search_blob = 'whatever i like'
 where id = '00000000-0000-0000-0000-00000000a002';

select is(
  (select normalized_name from public.catalog_products where id = '00000000-0000-0000-0000-00000000a002'),
  'pepsi zero 500ml pepsi',
  'a supplied normalized_name is overwritten, not honoured'
);

-- ─── 3. the merge key ────────────────────────────────────────────────────────

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('generic', '  apă    PLATĂ ', 'ro')$$,
  '23505',
  null,
  'a second spelling of one name is rejected by the merge key'
);

-- The other half of §14: materially different packages must NOT collapse.
select lives_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, brand, quantity, quantity_unit)
    values ('commercial', 'Pepsi Zero 2L', 'en', 'Pepsi', 2, 'l')$$,
  'a different package size is a different product'
);

select is(
  (select count(*)::int from public.catalog_products where brand = 'Pepsi'),
  2,
  'Pepsi Zero 500ml and Pepsi Zero 2L are two rows'
);

-- ─── 4. aliases ──────────────────────────────────────────────────────────────

insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-00000000a001', 'Still Water',    'en', 'name'),
  ('00000000-0000-0000-0000-00000000a001', 'Stilles Wasser', 'de', 'name'),
  ('00000000-0000-0000-0000-00000000a001', 'Eau Plate',      'fr', 'name');

select is(
  (select normalized_alias from public.catalog_aliases
    where product_id = '00000000-0000-0000-0000-00000000a001' and lang = 'de' and alias_type = 'name'),
  'stilles wasser',
  'an alias is folded by the same rule as a name'
);

select ok(
  (select search_blob from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001')
    like all (array['apa plata%', '%still water%', '%stilles wasser%', '%eau plate%']),
  'every alias reaches the search blob, and the canonical name still leads it'
);

-- This is the whole point of the aliases table: one row, six ways in.
select is(
  (select count(*)::int from public.catalog_products
    where search_blob like '%wasser%' or search_blob like '%eau%'),
  1,
  'milk/lapte/lait reach ONE row rather than three'
);

select throws_ok(
  $$insert into public.catalog_aliases (product_id, alias, lang, alias_type)
    values ('00000000-0000-0000-0000-00000000a001', 'Wasser', 'de', 'name')$$,
  '23505',
  null,
  'a product has at most one name per language'
);

select lives_ok(
  $$insert into public.catalog_aliases (product_id, alias, lang, alias_type)
    values ('00000000-0000-0000-0000-00000000a001', 'Wasser', 'de', 'synonym')$$,
  'a synonym in a language that already has a name is fine'
);

select throws_ok(
  $$insert into public.catalog_aliases (product_id, alias, lang, alias_type)
    values ('00000000-0000-0000-0000-00000000a001', '  wasser ', 'de', 'synonym')$$,
  '23505',
  null,
  'the same alias cannot be added twice — what makes a re-seed idempotent'
);

-- A rename must not cost the product its aliases.
update public.catalog_products set canonical_name = 'Apa Minerala'
 where id = '00000000-0000-0000-0000-00000000a001';

select ok(
  (select search_blob from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001')
    like all (array['apa minerala%', '%eau plate%']),
  'renaming a product rebuilds the blob and keeps every alias in it'
);

delete from public.catalog_aliases
 where product_id = '00000000-0000-0000-0000-00000000a001' and alias = 'Eau Plate';

select ok(
  (select search_blob from public.catalog_products where id = '00000000-0000-0000-0000-00000000a001')
    not like '%eau plate%',
  'deleting an alias takes it back out of the blob'
);

-- ─── 5. identifiers ──────────────────────────────────────────────────────────

insert into public.catalog_identifiers (product_id, identifier_value, source)
values ('00000000-0000-0000-0000-00000000a002', '4060800104', 'openfoodfacts');

select throws_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ('00000000-0000-0000-0000-00000000a001', '4060800104', 'curated')$$,
  '23505',
  null,
  'a GTIN names one product globally'
);

select lives_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ('00000000-0000-0000-0000-00000000a002', '04060800104', 'openfoodfacts')$$,
  'one product may carry several codes (a UPC-A read as EAN-13, a relabelled pack)'
);

select throws_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ('00000000-0000-0000-0000-00000000a001', 'ABC123', 'curated')$$,
  '23514',
  null,
  'a GTIN that is not digits is not a GTIN'
);

select throws_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_value, source)
    values ('00000000-0000-0000-0000-00000000a001', '123', 'curated')$$,
  '23514',
  null,
  'a code too short for any GTIN standard is rejected'
);

select lives_ok(
  $$insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
    values ('00000000-0000-0000-0000-00000000a001', 'mpn', 'PHL-A60-806', 'curated')$$,
  'a manufacturer part number is not held to the GTIN shape'
);

-- ─── 6. bounds ───────────────────────────────────────────────────────────────

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('nonsense', 'X', 'en')$$,
  '23514', null,
  'product_type is generic or commercial and nothing else'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('generic', 'X', 'pl')$$,
  '23514', null,
  'a name in a language the app does not speak cannot be the canonical name'
);

-- The eleven, not the six: src/lib/region.ts can emit any of them from a
-- timezone, and a code this table refuses is a code that matches no product.
select lives_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, markets)
    values ('generic', 'Sachertorte', 'de', array['AT','CH','DE','BE','IE','MD'])$$,
  'all eleven markets src/lib/region.ts can detect are accepted, not just the six primary ones'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, markets)
    values ('generic', 'Twinkie', 'en', array['US'])$$,
  '23514', null,
  'a market the app can never send is rejected rather than stored unreachable'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, category)
    values ('generic', 'Widget', 'en', 'gadgets')$$,
  '23514', null,
  'categories are a closed list, because each one needs translations'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, image_url)
    values ('generic', 'Widget', 'en', 'javascript:alert(1)')$$,
  '23514', null,
  'an image_url that is not https cannot reach an <img src> in the app'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, quantity)
    values ('generic', 'Widget', 'en', 500)$$,
  '23514', null,
  'a quantity with no unit is a number nobody can read'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, quantity, quantity_unit)
    values ('generic', 'Widget', 'en', 500, 'furlongs')$$,
  '23514', null,
  'the unit comes from a closed list too'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang, base_weight)
    values ('generic', 'Widget', 'en', -1)$$,
  '23514', null,
  'editorial weight cannot be negative'
);

-- 120 matches the app database's product_catalog.name exactly: a catalog row too
-- long to be echoed there would fail that write instead of this one.
select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('generic', repeat('x', 121), 'en')$$,
  '23514', null,
  'a name longer than the app database can hold is rejected here, where the cause is visible'
);

select throws_ok(
  $$insert into public.catalog_sources (product_id, source_name)
    values ('00000000-0000-0000-0000-00000000a001', 'some-scraper')$$,
  '23514', null,
  'provenance names a known source; it is a licensing fact, not free text'
);

-- ─── 7. cascade ──────────────────────────────────────────────────────────────

insert into public.catalog_sources (product_id, source_name, source_product_id)
values ('00000000-0000-0000-0000-00000000a002', 'openfoodfacts', '4060800104');

select throws_ok(
  $$insert into public.catalog_sources (product_id, source_name, source_product_id)
    values ('00000000-0000-0000-0000-00000000a001', 'openfoodfacts', '4060800104')$$,
  '23505', null,
  'one row per upstream id per source — what makes a re-import update rather than append'
);

delete from public.catalog_products where id = '00000000-0000-0000-0000-00000000a002';

select is(
  (select count(*)::int from public.catalog_identifiers
    where product_id = '00000000-0000-0000-0000-00000000a002'),
  0,
  'deleting a product takes its identifiers with it'
);

select is(
  (select count(*)::int from public.catalog_sources
    where product_id = '00000000-0000-0000-0000-00000000a002'),
  0,
  'deleting a product takes its provenance with it'
);

-- ─── 8. who may read and write ───────────────────────────────────────────────

-- The provenance row from the cascade test above went with its product, so the
-- surviving product gets one of its own for the admin read below.
insert into public.catalog_sources (product_id, source_name, source_product_id)
values ('00000000-0000-0000-0000-00000000a001', 'curated', 'still-water');

insert into public.catalog_admins (user_id) values ('admin_user');

-- anon reaches nothing at all — and it fails at the GRANT, before RLS is ever
-- consulted. Worth asserting as the error rather than as an empty result: an
-- empty result would also be produced by a policy, and the two are different
-- guarantees. Revoking the grant means a signed-out request cannot so much as
-- name the table.
set local role anon;

select throws_ok(
  $$select count(*) from public.catalog_products$$,
  '42501', null,
  'a signed-out request cannot read the catalog at all'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('generic', 'Injected', 'en')$$,
  '42501', null,
  'anon cannot write to the catalog'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select ok(
  (select count(*) from public.catalog_products) > 0,
  'a signed-in user can read the catalog'
);

select ok(
  (select count(*) from public.catalog_aliases) > 0,
  'a signed-in user can read aliases — the localized names come back with the row'
);

select throws_ok(
  $$insert into public.catalog_products (product_type, canonical_name, name_lang)
    values ('generic', 'Injected', 'en')$$,
  '42501', null,
  'a signed-in user cannot write to the catalog either; rows arrive by import only'
);

select throws_ok(
  $$update public.catalog_products set base_weight = 1000000$$,
  '42501', null,
  'nor can a signed-in user promote a product by rewriting its editorial weight'
);

-- The merge key stays out of reach: a client that could compute it could craft a
-- name that collides with an existing product's.
select throws_ok(
  $$select public.catalog_normalize('anything', null)$$,
  '42501', null,
  'no client role may compute the matching key'
);

select is(
  (select count(*)::int from public.catalog_sources),
  0,
  'provenance is invisible to an ordinary signed-in user'
);

select is(
  public.catalog_is_admin(),
  false,
  'an ordinary user is not a catalog admin'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select is(
  public.catalog_is_admin(),
  true,
  'an account in catalog_admins is'
);

select ok(
  (select count(*) from public.catalog_sources) > 0,
  'an admin can read provenance'
);

reset role;

select * from finish();
rollback;
