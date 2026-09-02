-- The admin surface (009_admin.sql), which is how a dashboard reaches this
-- catalog at all.
--
--   npx supabase --workdir catalog db reset && npx supabase --workdir catalog test db
--
-- What these assert:
--
--   1. EVERY ONE IS GATED. There is no table grant on catalog_products, so these
--      functions are the only way in and the guard is the only thing between an
--      ordinary signed-in account and the whole catalog.
--   2. ADMIN-AUTHORED ROWS ARE NOT 'curated'. This is the point of the file.
--      catalog_prune_curated() deletes curated rows the seed does not name, so a
--      row written as curated from a dashboard would be removed silently by the
--      next prune. Source 'admin' is invisible to prune, and the test proves it
--      by running a prune over the row.
--   3. THE DEDUPE RULE IS THE NORMALISED NAME, and it is enforced with a message
--      naming the situation rather than the index.
--   4. DERIVED COLUMNS STAY DERIVED. normalized_name and search_blob come from
--      the triggers; nothing here writes them, and a rename has to move them.
--   5. add_count IS NOT WRITABLE, here as in the app database. It is earned and
--      it is half of the generated popularity column.
--   6. DELETING TAKES THE WHOLE PRODUCT. Aliases, identifiers and provenance
--      cascade, because an alias for a product that is gone is a search hit
--      leading nowhere.

begin;
select plan(60);

delete from public.catalog_products;
delete from public.catalog_admins;

insert into public.catalog_admins (user_id) values ('admin_user');

-- ── 1. The gate ──────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select throws_ok(
  -- No arguments rather than a positional list. 011 put five text filters
  -- between p_type and p_limit, so `(null, null, 25, 0)` now offers 25 as a
  -- market code and fails on the wrong thing.
  $t$ select * from public.catalog_admin_products() $t$,
  42501,
  null,
  'an ordinary signed-in user cannot browse the catalog through the admin RPC'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Sneaky', 'generic', 'en') $t$,
  42501,
  null,
  'nor create a product'
);

select throws_ok(
  $t$ select public.catalog_admin_delete_product('00000000-0000-0000-0000-000000000001') $t$,
  42501,
  null,
  'nor delete one'
);

-- ── 2. Creating ──────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $t$ select public.catalog_admin_create_product(
        'Rice Cakes', 'generic', 'en', null, null, array['RO','DE'], '5949000000017', 3) $t$,
  'an admin creates a catalog product'
);

reset role;

select is(
  (select count(*)::int from public.catalog_products where canonical_name = 'Rice Cakes'),
  1,
  'and exactly one row lands'
);

-- The whole reason this file exists.
select is(
  (select source_name from public.catalog_sources s
   join public.catalog_products p on p.id = s.product_id
   where p.canonical_name = 'Rice Cakes'),
  'admin',
  'its provenance is admin, not curated'
);

select is(
  (select add_count from public.catalog_products where canonical_name = 'Rice Cakes'),
  0,
  'add_count starts at zero: it is earned, not granted'
);

select is(
  (select popularity from public.catalog_products where canonical_name = 'Rice Cakes'),
  3,
  'and popularity follows base_weight, being generated'
);

-- Derived by the trigger, never passed in.
select is(
  (select normalized_name from public.catalog_products where canonical_name = 'Rice Cakes'),
  public.catalog_normalize('Rice Cakes'),
  'normalized_name is derived by the trigger'
);

select ok(
  (select search_blob from public.catalog_products where canonical_name = 'Rice Cakes') <> '',
  'and the search blob is populated'
);

select is(
  (select count(*)::int from public.catalog_identifiers i
   join public.catalog_products p on p.id = i.product_id
   where p.canonical_name = 'Rice Cakes'),
  1,
  'the barcode is recorded as an identifier'
);

-- ── 3. What creating refuses ─────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select throws_ok(
  $t$ select public.catalog_admin_create_product('rice  cakes', 'generic', 'en') $t$,
  'P0001',
  'The catalog already holds a product that normalises to that name.',
  'a name that folds onto an existing one is refused, which is the dedupe rule'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Other', 'generic', 'en', null, null, '{}', '5949000000017') $t$,
  'P0001',
  'Another product already claims that barcode.',
  'and a barcode another product already claims'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Thing', 'generic', 'en', null, null, '{}', 'not-a-code') $t$,
  'P0001',
  'A barcode must be 8 to 14 digits.',
  'a barcode that is not 8 to 14 digits is refused with a sentence'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Thing', 'sometimes', 'en') $t$,
  'P0001',
  'A product is either generic or commercial.',
  'a product type outside the two is refused'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Thing', 'generic', 'pl') $t$,
  'P0001',
  'The name language must be one of en, de, es, ro, fr, it.',
  'as is a language this app cannot render'
);

select throws_ok(
  $t$ select public.catalog_admin_create_product('Thing', 'generic', 'en', null, null, array['US']) $t$,
  'P0001',
  'One of those markets is not a market this catalog can hold.',
  'and a market the check constraint would reject anyway, with a readable message'
);

-- ── 4. Prune leaves it alone ─────────────────────────────────────────────────
-- The silent failure this file is built to avoid, exercised rather than argued.
-- An empty keep-list is refused outright, so the prune is run with a keep-list
-- that names something else entirely: a curated row would be taken, and this one
-- must not be.

reset role;
insert into public.catalog_products (product_type, canonical_name, name_lang)
values ('generic', 'Seeded Thing', 'en');

insert into public.catalog_sources (product_id, source_name, source_product_id)
select id, 'curated', 'seeded-thing' from public.catalog_products
where canonical_name = 'Seeded Thing';

select is(
  (select count(*)::int from public.catalog_prune_curated(array['something-else'], true)),
  1,
  'a prune with a keep-list naming neither row takes exactly one product'
);

select is(
  (select count(*)::int from public.catalog_products where canonical_name = 'Seeded Thing'),
  0,
  'and the one it takes is the curated one'
);

select is(
  (select count(*)::int from public.catalog_products where canonical_name = 'Rice Cakes'),
  1,
  'the admin-authored row survives, because prune only joins on curated'
);

-- ── 5. Updating ──────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $t$ select public.catalog_admin_update_product(
        (select id from public.catalog_products where canonical_name = 'Rice Cakes'),
        'Rice Cake', 'generic', 'en', null, null, null, null) $t$,
  'an admin renames a product'
);

reset role;

select is(
  (select normalized_name from public.catalog_products where canonical_name = 'Rice Cake'),
  public.catalog_normalize('Rice Cake'),
  'and the derived key moves with the name rather than going stale'
);

select is(
  (select base_weight from public.catalog_products where canonical_name = 'Rice Cake'),
  3,
  'a null base_weight on update leaves the existing one alone'
);

select is(
  (select markets from public.catalog_products where canonical_name = 'Rice Cake'),
  array['RO','DE'],
  'and null markets likewise, rather than emptying them'
);

-- ── 6. Deleting takes the whole product ──────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $t$ select public.catalog_admin_delete_product(
        (select id from public.catalog_products where canonical_name = 'Rice Cake')) $t$,
  'an admin deletes a product'
);

reset role;

select is(
  (select count(*)::int from public.catalog_identifiers),
  0,
  'its identifiers go with it'
);

select is(
  (select count(*)::int from public.catalog_sources),
  0,
  'and so does its provenance'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $t$ select public.catalog_admin_delete_product('00000000-0000-0000-0000-00000000dead'::uuid) $t$,
  'deleting a product that is already gone is a no-op, not an error'
);

-- ── 7. Editing everything (010_admin_edit_everything.sql) ────────────────────
-- The columns 009 left unreachable, and the one convention that governs all of
-- them: null leaves a column alone, an empty string clears it, anything else
-- sets it. The convention is the thing worth pinning -- an update that omits a
-- field and erases it is silent, and the field it erases is usually the barcode.

reset role;
insert into public.catalog_products
  (id, product_type, canonical_name, name_lang, brand, category, markets,
   base_weight, quality_tier, quantity, quantity_unit, image_url)
values
  ('00000000-0000-0000-0000-0000000000e1', 'commercial', 'Editable Thing', 'en',
   'Acme', 'pantry', array['RO'], 4, 'C', 500, 'g', 'https://example.com/a.jpg');

insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
values ('00000000-0000-0000-0000-0000000000e1', 'gtin', '4000000000021', 'admin');

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

-- Everything sent at once, which is what the dashboard form does.
select lives_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', 'drinks',
        array['DE','AT'], 9, '4000000000038', 750, 'ml',
        'https://example.com/b.jpg', 'A') $t$,
  'an admin edits every column at once'
);

reset role;

select is(
  (select name_lang from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'de',
  'the name language changes'
);

select is(
  (select brand from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'Acme Gmbh',
  'the brand changes'
);

select is(
  (select category from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'drinks',
  'the category changes'
);

select is(
  (select markets from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  array['DE','AT'],
  'the markets change'
);

select is(
  (select quality_tier from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'A',
  'the record tier changes'
);

select is(
  (select quantity_unit from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'ml',
  'the quantity unit changes'
);

select is(
  (select image_url from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'https://example.com/b.jpg',
  'the image changes'
);

-- The one 009 refused. It moves, and the old code goes with it rather than
-- lingering as a second row that would still resolve a scan.
select is(
  (select identifier_value from public.catalog_identifiers
   where product_id = '00000000-0000-0000-0000-0000000000e1'),
  '4000000000038',
  'the barcode moves'
);

select is(
  (select count(*)::int from public.catalog_identifiers
   where product_id = '00000000-0000-0000-0000-0000000000e1'),
  1,
  'and the code it replaced does not linger beside it'
);

-- The derived key follows the new name and brand, computed by the trigger's own
-- rule rather than a second copy of it.
select is(
  (select normalized_name from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  public.catalog_normalize('Editable Thing', 'Acme Gmbh'),
  'and the merge key follows the name and brand together'
);

-- ── 8. null leaves alone, empty clears ───────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select lives_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh') $t$,
  'an update that mentions only the required fields is accepted'
);

reset role;

-- The failure this convention exists to prevent: an update that did not mention
-- the barcode must not remove it.
select is(
  (select count(*)::int from public.catalog_identifiers
   where product_id = '00000000-0000-0000-0000-0000000000e1'),
  1,
  'a barcode nobody mentioned survives the update'
);

select is(
  (select markets from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  array['DE','AT'],
  'and so do the markets'
);

select is(
  (select base_weight from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  9,
  'and the base weight'
);

select is(
  (select quality_tier from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'A',
  'and the record tier'
);

select is(
  (select quantity_unit from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  'ml',
  'and the quantity'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

-- Emptied on purpose, which is a real thing to want when a code turns out to
-- belong to something else.
select lives_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', '', null, null,
        '', null, '', '') $t$,
  'an empty string clears a field rather than being refused'
);

reset role;

select is(
  (select count(*)::int from public.catalog_identifiers
   where product_id = '00000000-0000-0000-0000-0000000000e1'),
  0,
  'an explicitly emptied barcode is removed'
);

select is(
  (select category from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  null,
  'an explicitly emptied category is cleared'
);

-- The pair moves together, because the check constraint refuses one without the
-- other.
select is(
  (select quantity from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  null,
  'clearing the unit clears the number with it'
);

select is(
  (select image_url from public.catalog_products where id = '00000000-0000-0000-0000-0000000000e1'),
  null,
  'and an emptied image is cleared'
);

-- ── 9. What editing refuses ──────────────────────────────────────────────────

reset role;
insert into public.catalog_products (id, product_type, canonical_name, name_lang)
values ('00000000-0000-0000-0000-0000000000e2', 'commercial', 'Rival Thing', 'en');

insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
values ('00000000-0000-0000-0000-0000000000e2', 'gtin', '4000000000045', 'admin');

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

-- The reason the barcode was withheld in the first place, now refused outright
-- rather than avoided by hiding the field.
select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        '4000000000045') $t$,
  'P0001',
  'Another product already claims that barcode.',
  'a barcode belonging to another product cannot be taken'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        'nonsense') $t$,
  'P0001',
  'A barcode must be 8 to 14 digits.',
  'and a malformed one is refused before the constraint can fire'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', 'condiments') $t$,
  'P0001',
  'That is not a category this catalog uses.',
  'a category outside the seventeen is refused'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        null, null, 'furlong') $t$,
  'P0001',
  'A quantity unit is one of g, kg, ml, l, cl or piece.',
  'as is a unit the constraint does not know'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        null, null, 'g') $t$,
  'P0001',
  'A quantity needs a number greater than zero to go with its unit.',
  'and a unit with no number, which the constraint would reject anyway'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        null, null, null, 'http://example.com/a.jpg') $t$,
  'P0001',
  'An image address must start with https:// and be under 500 characters.',
  'an image address that is not https is refused'
);

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e1'::uuid,
        'Editable Thing', 'commercial', 'de', 'Acme Gmbh', null, null, null,
        null, null, null, null, 'D') $t$,
  'P0001',
  'A record tier is A, B or C.',
  'and a tier outside A, B and C'
);

-- The merge key is name AND brand, which is what the derive trigger computes.
-- Two products may share a name while their brands differ, and renaming one so
-- that the PAIR collides has to be refused by name -- if the pre-check used the
-- name alone it would pass here and the unique index would fire instead, which
-- is the raw 23505 these messages exist to replace.
reset role;
insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand)
values
  ('00000000-0000-0000-0000-0000000000e3', 'commercial', 'Cola', 'en', 'Acme'),
  ('00000000-0000-0000-0000-0000000000e4', 'commercial', 'Cola', 'en', 'Beta');

set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select throws_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e4'::uuid,
        'Cola', 'commercial', 'en', 'Acme') $t$,
  'P0001',
  'Another product already normalises to that name.',
  'a collision that exists only because of the brand is refused by name'
);

select lives_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e4'::uuid,
        'Cola', 'commercial', 'en', 'Gamma') $t$,
  'while the same name under a different brand is left alone'
);

-- Keeping its own barcode is not taking somebody else's.
select lives_ok(
  $t$ select public.catalog_admin_update_product(
        '00000000-0000-0000-0000-0000000000e2'::uuid,
        'Rival Thing', 'commercial', 'en', null, null, null, null,
        '4000000000045') $t$,
  'a product may be saved with the barcode it already has'
);

select * from finish();
rollback;
