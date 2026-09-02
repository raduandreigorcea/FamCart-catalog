-- The admin browse filters (011_admin_filters.sql).
--
--   npx supabase --workdir catalog db reset && npx supabase --workdir catalog test db
--
-- Its own file rather than more of admin.test.sql, because what it asserts is a
-- different kind of thing: admin.test.sql is about what the surface REFUSES,
-- and this is about whether a filter selects the rows it claims to.
--
-- What is worth pinning here:
--
--   1. EVERY FILTER NARROWS, and does so on the whole catalog rather than on the
--      page. A filter that quietly matched nothing would look identical to a
--      correct filter over a thin catalog, which is the failure this file exists
--      to catch.
--   2. total_count FOLLOWS THE FILTER. It is what the pager and the count above
--      the table are drawn from, so a total that still described the unfiltered
--      catalog would put "441 products" over three rows.
--   3. AN UNKNOWN MARKET IS NOT AN ABSENT ONE. markets = '{}' means nobody
--      recorded where this is sold, and p_market can only ever ask the other
--      question. Both are here because the pair is the point of p_has_market.
--   4. THE THREE COLUMNS 009 DID NOT RETURN. quantity, quantity_unit and
--      image_url reach the caller. The edit form fills itself from this function
--      and submits every field, so while they were missing, correcting a
--      product's name cleared its size and its image.
--   5. A BAD FILTER VALUE RAISES rather than returning nothing.

begin;
select plan(33);

delete from public.catalog_products;
delete from public.catalog_admins;

insert into public.catalog_admins (user_id) values ('admin_user');

-- ── the fixture ──────────────────────────────────────────────────────────────
-- Five products chosen so that no two filters select the same set: whatever a
-- filter returns, it returned it for its own reason.
--
--   m1  generic, RO+DE, tier A, dairy,  no brand, no barcode, earned, old
--   m2  commercial, IT, tier B, snacks, brand, barcode, image, size, unearned
--   m3  commercial, NO MARKET, tier C, no category, no brand, no barcode
--   m4  generic, RO, tier A, produce,  no brand, no barcode, earned, curated
--   m5  commercial, DE, tier C, household, brand, barcode, admin-authored

insert into public.catalog_products
  (id, product_type, canonical_name, name_lang, brand, category, markets,
   quality_tier, quantity, quantity_unit, image_url, base_weight, add_count,
   created_at)
values
  ('00000000-0000-0000-0000-0000000000f1', 'generic', 'Milk', 'en',
   null, 'dairy', array['RO','DE'], 'A', null, null, null, 90, 5,
   '2024-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000f2', 'commercial', 'Nutella 400g', 'it',
   'Ferrero', 'snacks', array['IT'], 'B', 400, 'g',
   'https://images.example.com/nutella.jpg', 10, 0, '2025-06-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000f3', 'commercial', 'Orphan Bar', 'de',
   null, null, '{}', 'C', null, null, null, 0, 0, '2026-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000f4', 'generic', 'Bananas', 'en',
   null, 'produce', array['RO'], 'A', null, null, null, 80, 3,
   '2024-02-01T00:00:00Z'),
  ('00000000-0000-0000-0000-0000000000f5', 'commercial', 'Acme Cleaner', 'en',
   'Acme', 'household', array['DE'], 'C', null, null, null, 0, 0,
   '2026-02-01T00:00:00Z');

insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
values
  ('00000000-0000-0000-0000-0000000000f2', 'gtin', '3017620422003', 'openfoodfacts'),
  ('00000000-0000-0000-0000-0000000000f5', 'gtin', '4000000000091', 'admin');

insert into public.catalog_sources (product_id, source_name, source_product_id)
values
  ('00000000-0000-0000-0000-0000000000f1', 'curated', 'milk'),
  ('00000000-0000-0000-0000-0000000000f2', 'openfoodfacts', '3017620422003'),
  ('00000000-0000-0000-0000-0000000000f3', 'openfoodfacts', 'orphan'),
  ('00000000-0000-0000-0000-0000000000f4', 'curated', 'bananas'),
  ('00000000-0000-0000-0000-0000000000f5', 'admin', null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

-- ── 1. Nothing asked, everything answered ────────────────────────────────────

select is(
  (select count(*) from public.catalog_admin_products()),
  5::bigint,
  'with no filter the whole catalog comes back'
);

-- ── 2. The value filters ─────────────────────────────────────────────────────

-- Containment, not equality: m1 is sold in RO and DE and matches both.
select is(
  (select count(*) from public.catalog_admin_products(p_market => 'RO')),
  2::bigint,
  'a market selects every product whose set contains it'
);

select is(
  (select count(*) from public.catalog_admin_products(p_market => 'DE')),
  2::bigint,
  'and a product in two markets is found under each'
);

select is(
  (select count(*) from public.catalog_admin_products(p_tier => 'A')),
  2::bigint,
  'a record tier selects on quality_tier'
);

select is(
  (select count(*) from public.catalog_admin_products(p_category => 'dairy')),
  1::bigint,
  'a category selects on category'
);

select is(
  (select count(*) from public.catalog_admin_products(p_lang => 'it')),
  1::bigint,
  'a language selects on the name language, not on the aliases'
);

-- Provenance lives in its own table and a row can carry more than one, so this
-- is an EXISTS rather than a column comparison.
select is(
  (select count(*) from public.catalog_admin_products(p_source => 'openfoodfacts')),
  2::bigint,
  'a source selects through catalog_sources'
);

select is(
  (select count(*) from public.catalog_admin_products(p_source => 'admin')),
  1::bigint,
  'including the provenance this dashboard writes'
);

-- ── 3. The tri-states, both ways round ───────────────────────────────────────
-- Each of these is asserted in both directions on purpose. A predicate that
-- accidentally ignored its argument would pass the `true` half by coincidence
-- whenever most of the fixture happened to have the field.

select is(
  (select count(*) from public.catalog_admin_products(p_has_barcode => true)),
  2::bigint,
  'has-barcode finds the identified products'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_barcode => false)),
  3::bigint,
  'and its false half finds the rest, rather than everything'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_brand => true)),
  2::bigint,
  'has-brand finds the products with a maker'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_brand => false)),
  3::bigint,
  'and its false half the brandless ones, which for a generic is correct'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_image => true)),
  1::bigint,
  'has-image selects on image_url'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_quantity => true)),
  1::bigint,
  'has-quantity selects on the size the source stated'
);

-- The pair p_market cannot express. '{}' is UNKNOWN, so this is the only way to
-- ask which rows nobody has placed.
select is(
  (select count(*) from public.catalog_admin_products(p_has_market => false)),
  1::bigint,
  'has-market false finds the row with no market recorded at all'
);

select is(
  (select count(*) from public.catalog_admin_products(p_has_market => true)),
  4::bigint,
  'and its true half every row that names one'
);

select is(
  (select count(*) from public.catalog_admin_products(p_earned => true)),
  2::bigint,
  'earned finds the products households have actually added'
);

select is(
  (select count(*) from public.catalog_admin_products(p_earned => false)),
  3::bigint,
  'and its false half the ones carrying editorial weight and nothing else'
);

select is(
  (select count(*) from public.catalog_admin_products(p_added_since => '2025-01-01T00:00:00Z')),
  3::bigint,
  'added-since selects on created_at'
);

-- ── 4. They combine, and they combine with the search ────────────────────────

select is(
  (select count(*) from public.catalog_admin_products(
     p_type => 'commercial', p_has_brand => false)),
  1::bigint,
  'filters AND together: a commercial product with no maker is the shape worth finding'
);

select is(
  (select count(*) from public.catalog_admin_products(p_market => 'RO', p_tier => 'A')),
  2::bigint,
  'and a market narrows within a tier'
);

select is(
  (select canonical_name from public.catalog_admin_products(
     p_query => 'nutella', p_tier => 'B')),
  'Nutella 400g',
  'a filter narrows the search rather than replacing it'
);

select is(
  (select count(*) from public.catalog_admin_products(
     p_query => 'nutella', p_tier => 'A')),
  0::bigint,
  'and a filter the match fails is allowed to return nothing'
);

-- ── 5. The total describes the filter, not the catalog ───────────────────────
-- This is what the pager and the count above the table are drawn from. A total
-- that still described the unfiltered catalog would offer pages that do not
-- exist.

select is(
  (select total_count from public.catalog_admin_products(p_tier => 'A', p_limit => 1)),
  2::bigint,
  'total_count counts everything the filter matched'
);

select is(
  (select count(*) from public.catalog_admin_products(p_tier => 'A', p_limit => 1)),
  1::bigint,
  'while the page itself honours the limit'
);

-- ── 6. The three columns 009 did not return ──────────────────────────────────
-- The edit form fills itself from this function and submits every field it
-- holds, so a column missing here was not merely unshown: correcting a
-- product's name cleared its size and its image on save.

select is(
  (select quantity from public.catalog_admin_products(p_query => 'nutella')),
  400::numeric,
  'the quantity reaches the caller'
);

select is(
  (select quantity_unit from public.catalog_admin_products(p_query => 'nutella')),
  'g',
  'and its unit'
);

select is(
  (select image_url from public.catalog_admin_products(p_query => 'nutella')),
  'https://images.example.com/nutella.jpg',
  'and the image address'
);

-- ── 7. A filter value the catalog cannot hold is an error, not an empty page ─

select throws_ok(
  $t$ select * from public.catalog_admin_products(p_market => 'XX') $t$,
  'P0001',
  null,
  'a market outside the eleven is refused by name'
);

select throws_ok(
  $t$ select * from public.catalog_admin_products(p_tier => 'D') $t$,
  'P0001',
  null,
  'as is a record tier outside A, B and C'
);

select throws_ok(
  $t$ select * from public.catalog_admin_products(p_category => 'condiments') $t$,
  'P0001',
  null,
  'and a category outside the seventeen'
);

select throws_ok(
  $t$ select * from public.catalog_admin_products(p_source => 'wikipedia') $t$,
  'P0001',
  null,
  'and a provenance this catalog does not record'
);

select throws_ok(
  $t$ select * from public.catalog_admin_products(p_lang => 'pt') $t$,
  'P0001',
  null,
  'and a language the interface does not speak'
);

select * from finish();
rollback;
