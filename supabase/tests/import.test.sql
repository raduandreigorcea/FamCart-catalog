-- catalog_import_products(): the only writer the catalog has.
--
--   npx supabase --workdir catalog db reset && npx supabase --workdir catalog test db
--
-- What these assert:
--
--   1. IDEMPOTENCY (§26). Running the same import twice inserts nothing the
--      second time and adds no duplicate alias, identifier or provenance row.
--      This is the property the whole seed depends on and the one that is
--      easiest to lose without noticing — a second run that quietly appends is
--      invisible until the catalog is twice the size it should be.
--   2. EARNED POPULARITY SURVIVES. add_count is never written by an import, not
--      even one that renames the product.
--   3. CURATED WINS, AND ONLY WHERE IT SHOULD. An external source may not rename
--      or re-brand a curated row, and may always fill in a blank on it.
--   4. EVIDENCE ACCUMULATES. Markets union, tiers only improve, aliases are
--      added rather than replaced.
--   5. IDENTITY IS RESOLVED IN §12's ORDER. A GTIN match beats a name match, and
--      a GTIN already claimed by another product is never stolen.
--   6. A CONCEPT HAS NO BARCODE. A commercial record that folds onto a generic
--      row by name merges into it without handing it its GTIN.
--   7. ONE BAD ROW COSTS ONE ROW. A malformed record is reported and skipped;
--      the rest of the batch lands.
--   8. NO CLIENT MAY CALL IT.

begin;
select plan(49);

-- Start from an empty catalog, whatever this database happens to hold. Rolled
-- back with everything else, so a development database that has been seeded is
-- untouched -- but WITHOUT this, running the suite after `npm run catalog:seed`
-- produces dozens of failures that every one of them looks like a ranking or a
-- dedupe bug and none of them is. The documented flow is `db reset && test db`;
-- this makes the suite correct even when someone forgets.
delete from public.catalog_products;
delete from public.catalog_bump_limits;
delete from public.catalog_admins;

-- ─── 1. a first import ───────────────────────────────────────────────────────

create temp table res (r jsonb);

insert into res select public.catalog_import_products($json$[
  {
    "type": "generic", "name": "Milk", "lang": "en", "category": "dairy",
    "markets": ["RO", "DE"], "tier": "A", "weight": 100, "source_id": "milk",
    "aliases": [
      {"alias": "Lapte", "lang": "ro", "type": "name"},
      {"alias": "Milch", "lang": "de", "type": "name"},
      {"alias": "Lait",  "lang": "fr", "type": "name"}
    ]
  },
  {
    "type": "commercial", "name": "Pepsi Zero 500ml", "lang": "en", "brand": "Pepsi",
    "category": "drinks", "markets": ["RO"], "tier": "B", "weight": 20,
    "quantity": 500, "unit": "ml",
    "gtins": ["4060800104"], "source_id": "pepsi-zero-500"
  }
]$json$::jsonb, 'curated');

select is((select (r->>'inserted')::int from res), 2, 'both curated products were inserted');
select is((select (r->>'updated')::int from res), 0, 'nothing was updated on a first import');
select is((select (r->>'skipped')::int from res), 0, 'nothing was skipped');
select is((select (r->>'aliases_added')::int from res), 3, 'the three localized names landed');
select is((select (r->>'identifiers_added')::int from res), 1, 'the one barcode landed');

select is(
  (select base_weight from public.catalog_products where normalized_name = 'milk'),
  100,
  'a curated import sets the editorial weight'
);

select ok(
  (select search_blob from public.catalog_products where normalized_name = 'milk')
    like all (array['%lapte%', '%milch%', '%lait%']),
  'lapte, milch and lait all reach the one Milk row'
);

-- ─── 2. idempotency ──────────────────────────────────────────────────────────
-- The same call again. This is the property §26 asks for, and the reason the
-- seed importer can be run on every deploy without thinking about it.

update public.catalog_products set add_count = 42 where normalized_name = 'milk';

delete from res;
insert into res select public.catalog_import_products($json$[
  {
    "type": "generic", "name": "Milk", "lang": "en", "category": "dairy",
    "markets": ["RO", "DE"], "tier": "A", "weight": 100, "source_id": "milk",
    "aliases": [
      {"alias": "Lapte", "lang": "ro", "type": "name"},
      {"alias": "Milch", "lang": "de", "type": "name"},
      {"alias": "Lait",  "lang": "fr", "type": "name"}
    ]
  }
]$json$::jsonb, 'curated');

select is((select (r->>'inserted')::int from res), 0, 're-importing inserts nothing');
select is((select (r->>'aliases_added')::int from res), 0, 're-importing adds no duplicate alias');

select is(
  (select count(*)::int from public.catalog_aliases a
    join public.catalog_products p on p.id = a.product_id
   where p.normalized_name = 'milk'),
  3,
  'the product still has exactly three aliases'
);

select is(
  (select count(*)::int from public.catalog_sources s
    join public.catalog_products p on p.id = s.product_id
   where p.normalized_name = 'milk'),
  1,
  'and exactly one provenance row — the partial unique index really covers it'
);

select is(
  (select add_count from public.catalog_products where normalized_name = 'milk'),
  42,
  'earned popularity survives a re-import untouched'
);

-- ─── 3. curated wins ─────────────────────────────────────────────────────────
-- Open Food Facts finds the same barcode under a different name, with an image
-- and a market the seed did not know.

delete from res;
insert into res select public.catalog_import_products($json$[
  {
    "type": "commercial", "name": "PEPSI ZERO SUGAR BOTTLE", "lang": "fr",
    "brand": "PepsiCo", "markets": ["FR", "IT"], "tier": "A",
    "image_url": "https://images.openfoodfacts.org/pepsi.jpg",
    "weight": 999999,
    "gtins": ["4060800104"], "source_id": "4060800104",
    "aliases": [{"alias": "Pepsi Zero Zucchero", "lang": "it", "type": "name"}]
  }
]$json$::jsonb, 'openfoodfacts');

select is((select (r->>'updated')::int from res), 1, 'the GTIN resolved to the existing product');
select is((select (r->>'inserted')::int from res), 0, 'a GTIN match never creates a second row');

select is(
  (select canonical_name from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'Pepsi Zero 500ml',
  'an external source cannot rename a curated product'
);

select is(
  (select brand from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'Pepsi',
  'nor re-brand it'
);

select is(
  (select base_weight from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  20,
  'nor buy its way to the top of the rankings'
);

-- ...but the blanks it can fill, it does.
select is(
  (select image_url from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'https://images.openfoodfacts.org/pepsi.jpg',
  'a missing image is filled in by whoever knows it'
);

select is(
  (select markets from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  array['FR', 'IT', 'RO'],
  'markets are unioned, so a French source does not erase the Romanian evidence'
);

select is(
  (select quality_tier from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'A',
  'a better tier is taken'
);

select ok(
  (select search_blob from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi')
    like '%zucchero%',
  'and the Italian name it brought is now searchable'
);

select is(
  (select source_count from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  2,
  'two sources corroborating the product is counted, not assumed'
);

-- A thinner source afterwards must not undo any of it.
delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Pepsi", "lang": "en", "tier": "C",
   "gtins": ["4060800104"], "source_id": "4060800104-thin"}
]$json$::jsonb, 'openproductsfacts');

select is(
  (select quality_tier from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'A',
  'a later, poorer source cannot demote a product'
);

select is(
  (select image_url from public.catalog_products where normalized_name = 'pepsi zero 500ml pepsi'),
  'https://images.openfoodfacts.org/pepsi.jpg',
  'nor blank a field it does not know about'
);

-- ─── 4. a concept has no barcode ─────────────────────────────────────────────
-- Open Food Facts holds real packs named exactly 'Feta', 'Parmesan' or 'Milk'.
-- Folding one onto the curated concept is the right merge; handing the concept
-- its code is not, because lookup_barcode() would then answer a scan with the
-- word on the list rather than the pack in your hand.

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Milk", "lang": "en",
   "gtins": ["5940000000017"], "source_id": "off-milk-pack"}
]$json$::jsonb, 'openfoodfacts');

-- Zero rather than one is the whole assertion: had the row failed to fold it
-- would have become its own product and recorded the barcode there.
select is(
  (select (r->>'identifiers_added')::int from res),
  0,
  'a barcode arriving on a generic row is dropped, not recorded'
);

select is(
  (select count(*)::int from public.catalog_identifiers i
     join public.catalog_products p on p.id = i.product_id
    where p.normalized_name = 'milk'),
  0,
  'the concept still carries no identifier'
);

-- ─── 5. identity ordering ────────────────────────────────────────────────────
-- A row whose NAME matches one product and whose GTIN matches another belongs to
-- the GTIN's (§12: an exact identifier outranks a strong name).

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Bread", "lang": "en", "category": "bakery",
   "gtins": ["5941234567890"], "source_id": "bread", "weight": 90}
]$json$::jsonb, 'curated');

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Milk", "lang": "en",
   "gtins": ["5941234567890"], "source_id": "off-bread"}
]$json$::jsonb, 'openfoodfacts');

select is((select (r->>'inserted')::int from res), 0, 'the GTIN won over the name, so nothing was created');

select is(
  (select count(*)::int from public.catalog_products where normalized_name = 'milk'),
  1,
  'and the Milk row was not touched by a record that merely shares its name'
);

-- The name it wanted is taken by another product, so the rename is declined
-- rather than aborting the batch.
select is(
  (select canonical_name from public.catalog_products
    where id = (select product_id from public.catalog_identifiers where identifier_value = '5941234567890')),
  'Bread',
  'a rename that would collide with another product is declined, not attempted'
);

-- ─── 6. a claimed GTIN is never stolen ───────────────────────────────────────

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Something Else Entirely", "lang": "en",
   "gtins": ["5941234567890", "5949999999999"], "source_id": "off-thief"}
]$json$::jsonb, 'openfoodfacts');

select is(
  (select product_id from public.catalog_identifiers where identifier_value = '5941234567890'),
  (select id from public.catalog_products where normalized_name = 'bread'),
  'the already-claimed barcode still points at the product that claimed it'
);

-- ─── 7. one bad row costs one row ────────────────────────────────────────────

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "generic", "name": "", "lang": "en"},
  {"type": "generic", "name": "Eggs", "lang": "en", "category": "gadgets", "source_id": "eggs"},
  {"type": "generic", "name": "Butter", "lang": "en", "category": "dairy", "weight": 80, "source_id": "butter"}
]$json$::jsonb, 'curated');

select is((select (r->>'skipped')::int from res), 2, 'the nameless row and the bad-category row were skipped');
select is((select (r->>'inserted')::int from res), 1, 'the good row in the same batch still landed');
select is(
  (select jsonb_array_length(r->'errors') from res),
  2,
  'and both failures came back named rather than silently dropped'
);
select ok(
  (select count(*) from public.catalog_products where normalized_name = 'butter') = 1,
  'Butter is in the catalog'
);
select ok(
  (select count(*) from public.catalog_products where normalized_name = 'eggs') = 0,
  'Eggs is not, because its category has no translations'
);

-- ─── 8. reachability ─────────────────────────────────────────────────────────

select throws_ok(
  $$select public.catalog_import_products('[]'::jsonb, 'some-scraper')$$,
  'P0001',
  'catalog_import_products: unknown source some-scraper',
  'an unknown source is refused outright; provenance is a closed list'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select throws_ok(
  $$select public.catalog_import_products('[]'::jsonb, 'curated')$$,
  '42501', null,
  'no signed-in client can write to the global catalog'
);

reset role;

-- ─── 9. taking a curated row back out ────────────────────────────────────────
-- The seed file is the authority for curated rows, and it was only half an
-- authority until this existed: adding an entry created a row and removing one
-- left the row behind forever. Fifty concepts were dropped from the seed in one
-- go, which is exactly the size of drift that goes unnoticed.
--
-- This is the most dangerous function in the schema -- it deletes catalog rows
-- from a list a caller supplies -- so the guards matter more than the feature.

delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "generic", "name": "Kept Concept",    "lang": "en", "source_id": "kept"},
  {"type": "generic", "name": "Dropped Concept", "lang": "en", "source_id": "dropped"},
  {"type": "generic", "name": "Corroborated",    "lang": "en", "source_id": "corroborated"}
]$json$::jsonb, 'curated');

-- Something other than the seed has also seen this one.
--
-- NO BRAND on the incoming row, deliberately. The merge key is the folded
-- "name brand", so an external record calling it "Corroborated" by "Someone"
-- folds to `corroborated someone` and creates a SECOND product rather than
-- corroborating the first -- which is correct behaviour and quietly made an
-- earlier version of this test assert nothing at all.
delete from res;
insert into res select public.catalog_import_products($json$[
  {"type": "commercial", "name": "Corroborated", "lang": "en",
   "gtins": ["7777777777777"], "source_id": "off-corroborated"}
]$json$::jsonb, 'openfoodfacts');

select is(
  (select count(*)::int from public.catalog_sources s
     join public.catalog_products p on p.id = s.product_id
    where p.normalized_name = 'corroborated'),
  2,
  'the fixture really did corroborate one row rather than create a second'
);

update public.catalog_products set add_count = 9 where normalized_name = 'dropped concept';

-- The keep-list is DERIVED from what is actually in the catalog rather than
-- written out, because the sections above this one left their own curated rows
-- behind and a hand-written list would silently be pruning those instead of
-- testing anything. Everything stays except 'dropped'.
create temp view keep as
  select array_agg(s.source_product_id) as ids
  from public.catalog_sources s
  where s.source_name = 'curated'
    and s.source_product_id is not null
    and s.source_product_id <> 'dropped';

-- GUARD 1. The catastrophe this exists to prevent: a loader that failed to read
-- its files, passed an empty list, and truthfully reported pruning everything.
select throws_ok(
  $$select * from public.catalog_prune_curated(array[]::text[], true)$$,
  'P0001',
  'catalog_prune_curated: refusing to prune against an empty keep-list',
  'an empty keep-list is refused rather than obeyed'
);

select throws_ok(
  $$select * from public.catalog_prune_curated(null, true)$$,
  'P0001', null,
  'and so is a null one'
);

-- GUARD 3. A report by default; the destructive call is always the second one.
select is(
  (select array_agg(source_id) from public.catalog_prune_curated((select ids from keep))),
  array['dropped'],
  'exactly the curated row the seed no longer lists is reported'
);

select is(
  (select removed from public.catalog_prune_curated((select ids from keep)) where source_id = 'dropped'),
  false,
  'but nothing is removed without being asked'
);

select is(
  (select count(*)::int from public.catalog_products where normalized_name = 'dropped concept'),
  1,
  'and it really is still there'
);

select is(
  (select add_count from public.catalog_prune_curated((select ids from keep)) where source_id = 'dropped'),
  9,
  'the report carries what real people earned on it, so a popular row gets a second look'
);

-- GUARD 2. Corroborated by another source, so not the seed's to withdraw: the
-- seed may have introduced it, but the row now rests on evidence from elsewhere.
select ok(
  'corroborated' <> all (
    select source_id
    from public.catalog_prune_curated(
      array(select unnest((select ids from keep)) except select 'corroborated')
    )
  ),
  'a row another source has also seen is never eligible, even when the seed drops it'
);

-- And now for real.
select is(
  (select removed from public.catalog_prune_curated((select ids from keep), true) where source_id = 'dropped'),
  true,
  'with --apply it goes'
);

select is(
  (select count(*)::int from public.catalog_products where normalized_name = 'dropped concept'),
  0,
  'and it is gone'
);

select is(
  (select count(*)::int from public.catalog_products where normalized_name = 'kept concept'),
  1,
  'while everything the seed still lists is untouched'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select throws_ok(
  $$select * from public.catalog_prune_curated(array['kept'], true)$$,
  '42501', null,
  'and no client role can reach it at all'
);

reset role;

select * from finish();
rollback;
