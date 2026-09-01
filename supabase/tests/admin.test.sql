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
select plan(28);

delete from public.catalog_products;
delete from public.catalog_admins;

insert into public.catalog_admins (user_id) values ('admin_user');

-- ── 1. The gate ──────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select throws_ok(
  $t$ select * from public.catalog_admin_products(null, null, 25, 0) $t$,
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

select * from finish();
rollback;
