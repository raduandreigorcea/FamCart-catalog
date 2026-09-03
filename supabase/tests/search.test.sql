-- search_catalog(), lookup_barcode() and bump_product_popularity(): the three
-- functions the app actually calls.
--
--   npx supabase --workdir catalog db reset && npx supabase --workdir catalog test db
--
-- Deliberately built on fixtures rather than on the curated seed. A ranking test
-- that reads "Milk comes before Eggs" against real seed data passes for the
-- wrong reason the moment someone edits a weight in generics.json, and stops
-- telling you anything about the ranking itself.
--
-- What these assert:
--
--   1. THE LADDER. Eight mutually exclusive rungs, in order, with nothing else
--      able to reorder them. This is the whole of §17 and the fix for a search
--      for "milch" returning Eggs.
--   2. THE BONUSES CANNOT CROSS A RUNG. Market, language and quality move a row
--      within its rung and never out of it. Relevance is not tradeable against
--      location — that is the property, and it is one arithmetic slip away from
--      being false.
--   3. MARKET DEMOTES, NEVER FILTERS. A product sold somewhere else still comes
--      back. An empty dropdown is indistinguishable from "never heard of it".
--   4. POPULARITY IS THE TIE-BREAK, NOT THE SCORE (§23).
--   5. THE ANSWER COMES BACK READABLE. A Romanian phone asking for "lapte" gets
--      "Lapte", not "Milk". This is what the aliases table is for.
--   6. FUZZY RUNS ONLY ON AN EMPTY RESULT, so it can never displace a real
--      answer, and nonsense still returns nothing.
--   7. THE QUERY IS DATA. A typed % or _ is a character, not a wildcard.
--   8. A BARCODE IS EXACT (§25). No ranking, no fold, no fuzzy.
--   9. A BUMP REACHES THE RIGHT ROW even when the name it was given is a
--      translation, and it has a ceiling a client cannot raise.
--
-- Everything runs inside a rolled-back transaction.

begin;
select plan(56);

-- Start from an empty catalog, whatever this database happens to hold. Rolled
-- back with everything else, so a development database that has been seeded is
-- untouched -- but WITHOUT this, running the suite after `npm run catalog:seed`
-- produces dozens of failures that every one of them looks like a ranking or a
-- dedupe bug and none of them is. The documented flow is `db reset && test db`;
-- this makes the suite correct even when someone forgets.
delete from public.catalog_products;
delete from public.catalog_bump_limits;
delete from public.catalog_admins;

-- ─── fixtures: one rung each ─────────────────────────────────────────────────
-- Every product below is reachable by the query 'zeta' through exactly one rung
-- of the ladder, and they all carry the same popularity so that the score is the
-- only thing deciding the order.

insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand, base_weight) values
  ('00000000-0000-0000-0000-0000000000a1', 'generic',    'Zeta',           'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a2', 'generic',    'Beta',           'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a3', 'generic',    'Zetaline',       'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a4', 'generic',    'Gamma',          'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a5', 'generic',    'Big Zeta Box',   'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a6', 'commercial', 'Something',      'en', 'Zeta', 50),
  ('00000000-0000-0000-0000-0000000000a7', 'generic',    'Omega',          'en', null,   50),
  ('00000000-0000-0000-0000-0000000000a8', 'generic',    'Theta',          'en', null,   50);

insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-0000000000a2', 'Zeta',            'ro', 'name'),      -- exact alias
  ('00000000-0000-0000-0000-0000000000a4', 'Zetaline',        'de', 'name'),      -- prefix alias
  ('00000000-0000-0000-0000-0000000000a7', 'Big Zeta Thing',  'fr', 'synonym'),   -- token alias
  ('00000000-0000-0000-0000-0000000000a8', 'Zeta Shelf',      'en', 'category');  -- blob only

-- Section 9 makes language a FILTER, so a fixture with no Romanian name would
-- vanish from every query below that passes p_langs -- and these assertions are
-- about rungs and bonuses, not about language. Every generic in the real seed
-- carries all six names; these get a Romanian one for the same reason, so that
-- readability is a constant across the set rather than the thing deciding it.
-- Spelled the SAME as each canonical name on purpose. search_catalog hands back
-- the name in the caller's language, so a Romanian alias reading "Gamma ro"
-- would rename every row in the assertions below and turn a ranking test into a
-- localisation test. Identical strings keep language a pass/fail gate here and
-- nothing more.
insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-0000000000a1', 'Zeta',      'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000a3', 'Zetaline',  'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000a4', 'Gamma',     'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000a6', 'Something', 'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000a7', 'Omega',     'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000a8', 'Theta',     'ro', 'name');

select is(
  (select array_agg(name order by ord)
   from (select name, row_number() over () ord from public.search_catalog('zeta', 20)) t),
  array['Zeta', 'Beta', 'Zetaline', 'Gamma', 'Big Zeta Box', 'Something', 'Omega', 'Theta'],
  'the ladder orders exact name, exact alias, prefix, alias prefix, tokens, brand, alias tokens, category'
);

-- ─── the bonuses cannot cross a rung ─────────────────────────────────────────
-- The row on the lower rung is given every bonus there is; the row above it is
-- given none. If the bonuses were larger than the gap, this is where it shows.

update public.catalog_products
   set markets = array['RO'], quality_tier = 'A'
 where id = '00000000-0000-0000-0000-0000000000a5';   -- 'Big Zeta Box', rung 60
insert into public.catalog_aliases (product_id, alias, lang, alias_type)
values ('00000000-0000-0000-0000-0000000000a5', 'Cutia Zeta', 'ro', 'name');

update public.catalog_products
   set markets = array['GB'], quality_tier = 'C'
 where id = '00000000-0000-0000-0000-0000000000a4';   -- 'Gamma', rung 70

select is(
  (select name from public.search_catalog('zeta', 20, array['RO'], array['ro']) limit 1 offset 3),
  'Gamma',
  'a nearby, readable, tier-A row on a lower rung still loses to a plain row on a higher one'
);

select ok(
  (select array_position(
     (select array_agg(name order by ord)
      from (select name, row_number() over () ord from public.search_catalog('zeta', 20, array['RO'], array['ro'])) t),
     'Gamma')
   <
   array_position(
     (select array_agg(name order by ord)
      from (select name, row_number() over () ord from public.search_catalog('zeta', 20, array['RO'], array['ro'])) t),
     'Cutia Zeta')),
  'and the whole ladder holds with the bonuses applied'
);

-- ─── market demotes, never filters ───────────────────────────────────────────

select is(
  (select count(*)::int from public.search_catalog('zeta', 20, array['IE'])),
  8,
  'searching from a market no product is sold in still returns every match'
);

select is(
  (select name from public.search_catalog('zeta', 20, array['IE']) limit 1),
  'Zeta',
  'and the best match is still the best match there'
);

-- Within one rung, the market is what separates two otherwise identical rows.
insert into public.catalog_products (id, product_type, canonical_name, name_lang, markets, base_weight)
values ('00000000-0000-0000-0000-0000000000b1', 'generic', 'Zetamix', 'en', array['RO'], 50),
       ('00000000-0000-0000-0000-0000000000b2', 'generic', 'Zetamux', 'en', array['GB'], 50);

select is(
  (select name from public.search_catalog('zetam', 5, array['RO']) limit 1),
  'Zetamix',
  'between two equal prefix matches, the one sold where the searcher is comes first'
);

select is(
  (select name from public.search_catalog('zetam', 5, array['GB']) limit 1),
  'Zetamux',
  'and the same query from the other market flips them'
);

-- Unknown is not the same as elsewhere.
insert into public.catalog_products (id, product_type, canonical_name, name_lang, base_weight)
values ('00000000-0000-0000-0000-0000000000b3', 'generic', 'Zetamqx', 'en', 50);

select is(
  (select array_agg(name order by ord)
   from (select name, row_number() over () ord from public.search_catalog('zetam', 5, array['RO'])) t),
  array['Zetamix', 'Zetamqx', 'Zetamux'],
  'a product with no market data outranks one sold somewhere else, and loses to one sold here'
);

-- ─── popularity is the tie-break, never the score ────────────────────────────

update public.catalog_products set base_weight = 1000000
 where id = '00000000-0000-0000-0000-0000000000a8';   -- 'Theta', the category-only match

select is(
  (select name from public.search_catalog('zeta', 20) limit 1),
  'Zeta',
  'a million points of popularity does not lift a category match above an exact name'
);

select is(
  (select array_agg(name order by ord))[array_length(array_agg(name), 1)],
  'Theta',
  'it stays exactly where its rung puts it: last'
) from (select name, row_number() over () ord from public.search_catalog('zeta', 20)) t;

update public.catalog_products set base_weight = 50
 where id = '00000000-0000-0000-0000-0000000000a8';

-- ...but within one rung it decides.
update public.catalog_products set base_weight = 90
 where id = '00000000-0000-0000-0000-0000000000b3';   -- 'Zetamqx'

select is(
  (select name from public.search_catalog('zetam', 5) limit 1),
  'Zetamqx',
  'within one rung, and with no market to separate them, the more popular product wins'
);

-- ─── the answer comes back readable ──────────────────────────────────────────

insert into public.catalog_products (id, product_type, canonical_name, name_lang, category, base_weight)
values ('00000000-0000-0000-0000-0000000000c1', 'generic', 'Milk', 'en', 'dairy', 100);
insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-0000000000c1', 'Lapte', 'ro', 'name'),
  ('00000000-0000-0000-0000-0000000000c1', 'Milch', 'de', 'name'),
  ('00000000-0000-0000-0000-0000000000c1', 'Lactate', 'ro', 'category'),
  ('00000000-0000-0000-0000-0000000000c1', 'Milchprodukte', 'de', 'category');

select is(
  (select name from public.search_catalog('lapte', 5, null, array['ro']) limit 1),
  'Lapte',
  'a Romanian phone asking for lapte is told Lapte, not Milk'
);

select is(
  (select name from public.search_catalog('milk', 5, null, array['ro']) limit 1),
  'Lapte',
  'and asking for it in English still gets the readable name back'
);

select is(
  (select name from public.search_catalog('milk', 5, null, array['en']) limit 1),
  'Milk',
  'an English phone gets the canonical name'
);

select is(
  (select name from public.search_catalog('milk', 5) limit 1),
  'Milk',
  'and no language at all falls back to the canonical rather than failing'
);

-- The bug this ranking was written for. 'Eggs' is reachable from 'milch' only
-- through the German category name, and must never come first.
insert into public.catalog_products (id, product_type, canonical_name, name_lang, category, base_weight)
values ('00000000-0000-0000-0000-0000000000c2', 'generic', 'Eggs', 'en', 'dairy', 100);
insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-0000000000c2', 'Milchprodukte', 'de', 'category'),
  ('00000000-0000-0000-0000-0000000000c2', 'Lactate',       'ro', 'category'),
  -- Its own names, not only its shelf's. Section 9 filters on whether the
  -- PRODUCT can be read, and a German phone cannot read "Eggs" however well its
  -- category is translated. Every generic in the real seed carries all six.
  ('00000000-0000-0000-0000-0000000000c2', 'Eier',          'de', 'name'),
  ('00000000-0000-0000-0000-0000000000c2', 'Ouă',           'ro', 'name');

select is(
  (select name from public.search_catalog('milch', 5, null, array['de']) limit 1),
  'Milch',
  'searching for milk in German returns milk, not everything on the dairy shelf'
);

select is(
  (select count(*)::int from public.search_catalog('milch', 5, null, array['de'])),
  2,
  'the shelf is still reachable — the category match is demoted, not dropped'
);

-- A query that IS a shelf gets the shelf, ordered by popularity.
select is(
  (select count(*)::int from public.search_catalog('lactate', 5, null, array['ro'])),
  2,
  'a category name returns everything on that category'
);

-- ─── word order and escaping ─────────────────────────────────────────────────

insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand, base_weight)
values ('00000000-0000-0000-0000-0000000000d1', 'generic', 'Apa Plata Borsec', 'ro', null, 40);

select is(
  (select name from public.search_catalog('borsec apa', 5) limit 1),
  'Apa Plata Borsec',
  'every token is matched separately, so word order is not load-bearing'
);

select is(
  (select count(*)::int from public.search_catalog('%', 50)),
  0,
  'a typed percent sign on its own is a character, not the whole catalog'
);

-- Proving the escape needs a pair of products that a WILDCARD would match and a
-- LITERAL would not. Counting rows for a query like 'zet_' proves nothing: the
-- strict pass correctly rejects it and the fuzzy pass then answers, so the
-- result is non-empty either way and the test would pass with the escaping
-- removed.
insert into public.catalog_products (product_type, canonical_name, name_lang) values
  ('generic', 'Qwx_yz', 'en'),
  ('generic', 'QwxAyz', 'en'),
  ('generic', 'Rvw%st', 'en'),
  ('generic', 'RvwBst', 'en');

select is(
  (select array_agg(name) from public.search_catalog('qwx_yz', 50)),
  array['Qwx_yz'],
  'an underscore matches an underscore and not any character'
);

select is(
  (select array_agg(name) from public.search_catalog('rvw%st', 50)),
  array['Rvw%st'],
  'and a percent matches a percent and not any run of characters'
);

select is(
  (select count(*)::int from public.search_catalog('   ', 50)),
  0,
  'whitespace alone matches nothing rather than everything'
);

select is(
  (select count(*)::int from public.search_catalog(null, 50)),
  0,
  'and a null query is not an error'
);

-- ─── fuzzy, and only on an empty result ──────────────────────────────────────

insert into public.catalog_products (id, product_type, canonical_name, name_lang, base_weight)
values ('00000000-0000-0000-0000-0000000000e1', 'generic', 'Sampon', 'ro', 60);

-- OFF BY DEFAULT. An empty result means "ask discovery", not "here is the
-- nearest string" -- see the long comment in 004. Measured against the real
-- catalog, the automatic version answered "beer" with "Beef" and "toothpaste"
-- with "Toothbrush", and no threshold separates those from a genuine typo.
select is(
  (select count(*)::int from public.search_catalog('sampoo', 5)),
  0,
  'a query nothing matches returns nothing, rather than the nearest thing'
);

select is(
  (select name from public.search_catalog('sampoo', 5, null, null, true) limit 1),
  'Sampon',
  'a caller that has already tried everything else can ask for the nearest thing'
);

select is(
  (select count(*)::int from public.search_catalog('qqqzzzwww', 50, null, null, true)),
  0,
  'and even then nonsense returns nothing rather than noise'
);

select is(
  (select name from public.search_catalog('zeta', 20, null, null, true) limit 1),
  'Zeta',
  'and a search that DID match is untouched even with fuzzy asked for'
);

-- ─── limits ──────────────────────────────────────────────────────────────────

select is(
  (select count(*)::int from public.search_catalog('zeta', 2)),
  2,
  'p_limit is honoured'
);

select is(
  (select count(*)::int from public.search_catalog('zeta', 100000)),
  (select count(*)::int from public.search_catalog('zeta', 200)),
  'an absurd limit is clamped to the maximum rather than trusted'
);

select is(
  (select count(*)::int from public.search_catalog('zeta', 0)),
  1,
  'and a zero limit is raised to one rather than returning nothing'
);

-- ─── barcodes ────────────────────────────────────────────────────────────────

-- A barcode belongs to a pack, not to the word on the list, and a code on a
-- concept is refused. These two have played the part of concepts for every search
-- assertion above; from here they are the packs that carry the codes. Nothing
-- below reads their type.
update public.catalog_products set product_type = 'commercial'
 where id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2');

insert into public.catalog_identifiers (product_id, identifier_value, source) values
  ('00000000-0000-0000-0000-0000000000c1', '5941234567890', 'curated'),
  ('00000000-0000-0000-0000-0000000000c2', '05941234567890', 'curated');

select is(
  (select name from public.lookup_barcode(array['5941234567890'])),
  'Milk',
  'a barcode resolves to its product'
);

select is(
  (select name from public.lookup_barcode(array['5941234567890'], array['ro'])),
  'Lapte',
  'and comes back readable when the scanner says what language it speaks'
);

-- barcodeCandidates() in the app expands one scan into the equivalent
-- encodings, so more than one can match. The most-used product is the answer.
update public.catalog_products set base_weight = 500
 where id = '00000000-0000-0000-0000-0000000000c2';

select is(
  (select name from public.lookup_barcode(array['5941234567890', '05941234567890'])),
  'Eggs',
  'when a scan matches several encodings the most-used product wins'
);

select is(
  (select count(*)::int from public.lookup_barcode(array['9999999999999'])),
  0,
  'an unknown barcode returns nothing — never the nearest product'
);

select is(
  (select count(*)::int from public.lookup_barcode(array[]::text[])),
  0,
  'and an empty scan is not an error'
);

-- §25: a barcode is never text-searched. '594' is a prefix of a stored code and
-- must match nothing.
select is(
  (select count(*)::int from public.lookup_barcode(array['594'])),
  0,
  'a barcode is an exact key, never a prefix and never fuzzy'
);

-- ─── bumping ─────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select public.bump_product_popularity('Milk', null);

reset role;
select is(
  (select add_count from public.catalog_products where id = '00000000-0000-0000-0000-0000000000c1'),
  1,
  'adding a product to a list makes it more popular'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

-- The name the client has is the one search_catalog gave it, which for a
-- Romanian phone is the Romanian one. Without the alias lookup every bump from
-- a non-English phone would silently count for nothing.
select public.bump_product_popularity('Lapte', null);

reset role;
select is(
  (select add_count from public.catalog_products where id = '00000000-0000-0000-0000-0000000000c1'),
  2,
  'a bump sent under a localized name reaches the same row'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';
select public.bump_product_popularity('Something', 'Zeta');
reset role;

select is(
  (select add_count from public.catalog_products where id = '00000000-0000-0000-0000-0000000000a6'),
  1,
  'a bump with a maker resolves through the full merge key'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';
select public.bump_product_popularity('A Product This Catalog Has Never Heard Of', null);
reset role;

select pass('a bump for an unknown product is a no-op rather than an error');

-- Anonymous cannot count. requesting_user_id() is null, so there is nobody to
-- charge the rate limit to.
set local role authenticated;
set local request.jwt.claims = '{}';
select public.bump_product_popularity('Milk', null);
reset role;

select is(
  (select add_count from public.catalog_products where id = '00000000-0000-0000-0000-0000000000c1'),
  2,
  'a request with no subject in its token cannot move a ranking'
);

-- The ceiling. Without it, one signed-in client can drive any product to the
-- top of every search by calling this in a loop.
set local role authenticated;
set local request.jwt.claims = '{"sub":"user_b"}';
do $$
begin
  for i in 1..130 loop
    perform public.bump_product_popularity('Zeta', null);
  end loop;
end $$;
reset role;

select is(
  (select add_count from public.catalog_products where id = '00000000-0000-0000-0000-0000000000a1'),
  120,
  'a client can spend its hourly ceiling and not a bump more'
);

select is(
  (select bumps from public.catalog_bump_limits where user_id = 'user_b'),
  130,
  'and the counter keeps climbing, so hammering it does not reset the window'
);

-- ─── reachability ────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"user_a"}';

select lives_ok(
  $$select * from public.search_catalog('milk', 5)$$,
  'a signed-in user can search'
);

select lives_ok(
  $$select * from public.lookup_barcode(array['5941234567890'])$$,
  'and scan'
);

select throws_ok(
  $$select public.catalog_normalize('milk', null)$$,
  '42501', null,
  'but still cannot compute the merge key the search is built on'
);

select throws_ok(
  $$select * from public.catalog_bump_limits$$,
  '42501', null,
  'nor read how close it is to its own ceiling'
);

reset role;
set local role anon;

select throws_ok(
  $$select * from public.search_catalog('milk', 5)$$,
  '42501', null,
  'a signed-out request cannot search at all'
);

select throws_ok(
  $$select public.bump_product_popularity('Milk', null)$$,
  '42501', null,
  'nor bump'
);

reset role;

-- ─── 9. a name you cannot read is not a suggestion ───────────────────────────
-- Market DEMOTES, language FILTERS, and the asymmetry is the point: a product
-- sold in the next country is still worth offering, a product named in a
-- language you do not read is not. Every curated row is readable in all six
-- languages, so this changes nothing about the seed -- it exists for what
-- DISCOVERY brings back, which arrives named in whatever language Open Food
-- Facts happened to file it under.
--
-- Three rows that all answer the query "nutella" (by brand or by name) and
-- differ only in what language they can be read in.

insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand, base_weight) values
  ('00000000-0000-0000-0000-0000000000e9', 'commercial', 'Crema de Alune 400g',           'ro', 'Nutella', 50),
  ('00000000-0000-0000-0000-0000000000ea', 'commercial', 'Pate a tartiner aux noisettes', 'fr', 'Nutella', 50),
  ('00000000-0000-0000-0000-0000000000eb', 'commercial', 'Nutella Biscuits 304g',         'it', 'Nutella', 50);

select is(
  (select array_agg(name) from public.search_catalog('nutella', 20, null, array['ro'])),
  array['Crema de Alune 400g'],
  'a Romanian phone is offered only the one it can read'
);

select is(
  (select array_agg(name) from public.search_catalog('nutella', 20, null, array['fr'])),
  array['Pate a tartiner aux noisettes'],
  'and a French phone only the French one — the same rows, a different answer'
);

select is(
  (select count(*)::int from public.search_catalog('nutella', 20)),
  3,
  'asking in no particular language filters nothing'
);

-- THE ESCAPE HATCH, and the reason this is not a hard filter. "Nutella Biscuits
-- 304g" is readable by anybody and still carries whatever language its source
-- filed it under, so hiding it when there is no alternative would be hiding the
-- product somebody is searching for by name.
select is(
  (select array_agg(name) from public.search_catalog('biscuits 304g', 20, null, array['ro'])),
  array['Nutella Biscuits 304g'],
  'a row nobody can read is still offered when it is the only answer there is'
);

-- ...and the escape is per QUERY, not global. The row above proves the hatch
-- opens; this proves it stays shut whenever anything readable did match.
select is(
  (select count(*)::int from public.search_catalog('nutella', 20, null, array['de'])),
  3,
  'a German phone, for which none of the three is readable, gets all three'
);

-- A product whose canonical name is natively in the language counts as readable
-- with no alias at all: that is how every Romanian shop line in the seed
-- qualifies.
select is(
  (select count(*)::int from public.search_catalog('crema de alune', 20, null, array['ro'])),
  1,
  'a natively-Romanian name needs no Romanian alias to be readable'
);

select * from finish();
rollback;
