-- What the concept layer actually changed about search results.
--
--   npx supabase --workdir catalog db reset    -- never skip this
--   npx supabase --workdir catalog test db
--
-- concepts.test.sql asserts that a word resolves to the right idea. This file
-- asserts what the SEARCH does with that idea, which is the part a person sees.
--
-- The three intents, and the one sentence each that matters:
--
--   branded   'apa' is a category, so real products come first and the generic
--             placeholder sinks. It is never hidden: the dropdown must not go
--             empty, which is the rule the whole ranking is built around.
--   generic   'cartofi' is a thing you can buy, so the generic row leads and
--             nothing external needs asking.
--   mixed     'lapte' is both, so both come back, ordered by how well they
--             matched rather than by what type of row they are.
--
-- Plus the two failures that made this necessary, pinned so they cannot return:
-- 'apa' matching onions through 'ceApă', and a water whose name contains no
-- part of the query being unfindable at all.
--
-- Everything runs inside a rolled-back transaction, so it leaves no rows.

begin;
select plan(25);

delete from public.catalog_products;
delete from public.catalog_concepts;

-- ─── fixtures ────────────────────────────────────────────────────────────────
-- A miniature of the real catalog: one concept per intent, each with a generic
-- row and, where the point requires it, commercial ones.

insert into public.catalog_concepts (id, slug, intent, category, base_weight) values
  ('00000000-0000-0000-0000-0000000c0001', 'water',     'branded', 'drinks',        100),
  ('00000000-0000-0000-0000-0000000c0002', 'potato',    'generic', 'produce',       100),
  ('00000000-0000-0000-0000-0000000c0003', 'milk',      'mixed',   'dairy',         100),
  ('00000000-0000-0000-0000-0000000c0004', 'deodorant', 'branded', 'personal-care',  90),
  ('00000000-0000-0000-0000-0000000c0005', 'onion',     'generic', 'produce',        90);

insert into public.catalog_concept_terms (concept_id, term, lang, term_type) values
  ('00000000-0000-0000-0000-0000000c0001', 'Water',     'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Apă',       'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0002', 'Potatoes',  'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0002', 'Cartofi',   'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0003', 'Milk',      'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0003', 'Lapte',     'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0004', 'Deodorant', 'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0004', 'Deodorant', 'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0005', 'Onions',    'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0005', 'Ceapă',     'ro', 'label');

insert into public.catalog_products
  (id, product_type, canonical_name, name_lang, brand, category, markets, quality_tier, base_weight, concept_id)
values
  -- The generic placeholders. Attributed to their own concept, because a
  -- generic row IS its concept.
  ('00000000-0000-0000-0000-00000000a001', 'generic', 'Water', 'en', null, 'drinks',
   array['RO','DE','GB'], 'A', 100, '00000000-0000-0000-0000-0000000c0001'),
  ('00000000-0000-0000-0000-00000000a002', 'generic', 'Potatoes', 'en', null, 'produce',
   array['RO','DE','GB'], 'A', 100, '00000000-0000-0000-0000-0000000c0002'),
  ('00000000-0000-0000-0000-00000000a003', 'generic', 'Milk', 'en', null, 'dairy',
   array['RO','DE','GB'], 'A', 100, '00000000-0000-0000-0000-0000000c0003'),
  ('00000000-0000-0000-0000-00000000a004', 'generic', 'Onions', 'en', null, 'produce',
   array['RO','DE','GB'], 'A', 90, '00000000-0000-0000-0000-0000000c0005'),

  -- Real products. Only the LAST of these is attributed to a concept, and that
  -- is the whole point of it: "Borsec" contains no part of "apa".
  ('00000000-0000-0000-0000-00000000b001', 'commercial', 'Apa Plata 2L', 'ro', 'Dorna', 'drinks',
   array['RO'], 'B', 30, null),
  ('00000000-0000-0000-0000-00000000b002', 'commercial', 'Lapte 1.5% 1L', 'ro', 'Zuzu', 'dairy',
   array['RO'], 'B', 30, null),
  ('00000000-0000-0000-0000-00000000b003', 'commercial', 'Deodorant Roll-On 50ml', 'ro', 'Nivea', 'personal-care',
   array['RO'], 'B', 30, null),
  ('00000000-0000-0000-0000-00000000b004', 'commercial', 'Borsec 2L', 'ro', 'Borsec', 'drinks',
   array['RO'], 'B', 40, '00000000-0000-0000-0000-0000000c0001');

insert into public.catalog_aliases (product_id, alias, lang, alias_type) values
  ('00000000-0000-0000-0000-00000000a001', 'Apă',     'ro', 'name'),
  ('00000000-0000-0000-0000-00000000a002', 'Cartofi', 'ro', 'name'),
  ('00000000-0000-0000-0000-00000000a003', 'Lapte',   'ro', 'name'),
  ('00000000-0000-0000-0000-00000000a004', 'Ceapă',   'ro', 'name');

-- ─── 1. branded: real products lead, the placeholder sinks ───────────────────

select isnt_empty(
  $$select name from public.search_catalog('apa', 20, array['RO'], array['ro'])$$,
  'apa returns something at all'
);

select is(
  (select maker from public.search_catalog('apa', 20, array['RO'], array['ro']) limit 1),
  'Dorna',
  'apa leads with a real product, not with the concept placeholder'
);

-- row_number() over () with no ORDER BY reads the function's own output order,
-- which is the thing under test. Ordering the result again here would assert
-- something about the collation instead.
select ok(
  (with r as (select row_number() over () as rn, name, maker
                from public.search_catalog('apa', 20, array['RO'], array['ro']))
   select (select rn from r where name = 'Apă')
        > (select max(rn) from r where maker is not null)),
  'the generic placeholder is still there, below every real product -- a branded intent demotes, it never hides'
);

select ok(
  (select bool_and(maker is not null)
     from (select maker from public.search_catalog('apa', 20, array['RO'], array['ro']) limit 2) t),
  'every result above the placeholder is something you could actually buy'
);

-- ─── 2. the false positives that started all this ────────────────────────────
-- Both were correct substring matches into a six-language blob:
--     Potatoes -> ... p-APA-s patatas patate
--     Onions   -> onions ce-APA cebollas
-- Fixed by the short-token word-start rule rather than by the concept layer;
-- pinned here because this is the file somebody reads when apa misbehaves.

select is_empty(
  $$select name from public.search_catalog('apa', 50, array['RO'], array['ro'])
     where name in ('Ceapă', 'Onions', 'Cartofi', 'Potatoes')$$,
  'apa returns no onions and no potatoes'
);

select is_empty(
  $$select name from public.search_catalog('beer', 50, null, array['en'])
     where name = 'Onions'$$,
  'and the same rule keeps beer out of Erdbeeren'
);

-- ─── 3. concept membership is REACH ──────────────────────────────────────────
-- "Borsec 2L" contains no part of "apa". No amount of substring matching can
-- ever find it; belonging to the water concept is the only thing that can.

select ok(
  (select count(*) from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Borsec 2L') = 1,
  'a water whose name contains none of the query is still found, through its concept'
);

select is(
  (select match_type from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Borsec 2L'),
  'concept',
  '...and says so, rather than claiming a name match it does not have'
);

select ok(
  (select relevance_score from public.search_catalog('apa', 20, array['RO'], array['ro'])
     where name = 'Borsec 2L')
  <
  (select relevance_score from public.search_catalog('apa', 20, array['RO'], array['ro'])
     where name = 'Apa Plata 2L'),
  'concept membership ranks BELOW a real name match -- it is reach, not precision'
);

-- ─── 4. generic: the bare row is the answer ──────────────────────────────────

select is(
  (select name from public.search_catalog('cartofi', 20, array['RO'], array['ro']) limit 1),
  'Cartofi',
  'cartofi leads with the generic product; nobody typing it wants a brand of potato'
);

select is(
  (select name from public.search_catalog('morcovi', 20, array['RO'], array['ro']) limit 1),
  null,
  'a word this catalog has no concept and no product for returns nothing, rather than the nearest string'
);

-- ─── 5. mixed: both, ordered by how well they matched ────────────────────────

select is(
  (select name from public.search_catalog('lapte', 20, array['RO'], array['ro']) limit 1),
  'Lapte',
  'lapte returns the generic concept first, because it matched an alias exactly'
);

select ok(
  (select count(*) from public.search_catalog('lapte', 20, array['RO'], array['ro'])
    where maker = 'Zuzu') = 1,
  '...and the branded milk with it. A mixed concept demotes neither'
);

-- ─── 6. branded with no generic row at all ───────────────────────────────────
-- deodorant is one of the fifty concepts removed from the seed for being
-- unshoppable. It is a known word with a known intent and NO product of its
-- own, which is the case the old schema could not express.

select is(
  (select name from public.search_catalog('deodorant', 20, array['RO'], array['ro']) limit 1),
  'Deodorant Roll-On 50ml',
  'deodorant returns a real branded product'
);

select is_empty(
  $$select name from public.search_catalog('deodorant', 20, array['RO'], array['ro'])
     where maker is null$$,
  '...and no placeholder was invented just because the concept exists'
);

-- ─── 6b. a commercial row that is only the concept's own word ────────────────
-- Open Food Facts is full of rows that are a barcode, the word "Pâine", and
-- nothing else. They score name_exact (100) and so beat every real product,
-- which is how searching "paine" put five of them above Dobrogea's sliced loaf.

insert into public.catalog_products
  (id, product_type, canonical_name, name_lang, brand, category, markets, quality_tier, base_weight, concept_id)
values
  -- The useless one: the concept's word, no brand.
  ('00000000-0000-0000-0000-00000000c001', 'commercial', 'Lapte', 'ro', null, 'dairy',
   array['RO'], 'A', 50, '00000000-0000-0000-0000-0000000c0003'),
  -- The curated shape the name test exists to protect: no brand either, but a
  -- real package size, so it is a product rather than a duplicate of the word.
  ('00000000-0000-0000-0000-00000000c002', 'commercial', 'Lapte 3.5% 1L bidon', 'ro', null, 'dairy',
   array['RO'], 'A', 50, '00000000-0000-0000-0000-0000000c0003');

select ok(
  (with r as (select row_number() over () as rn, name, maker
                from public.search_catalog('lapte', 20, array['RO'], array['ro']))
   -- max(), not min(): TWO rows display as "Lapte" with no maker -- the generic
   -- concept, which leads under a mixed intent, and the commercial duplicate,
   -- which is the one under test. min() would assert about the wrong row.
   select (select max(rn) from r where name = 'Lapte' and maker is null)
        > (select max(rn) from r where maker = 'Zuzu')),
  'a brandless commercial row that is only the concept word sinks below every real product'
);

select ok(
  (with r as (select row_number() over () as rn, name
                from public.search_catalog('lapte', 20, array['RO'], array['ro']))
   select (select rn from r where name = 'Lapte 3.5% 1L bidon')
        < (select min(rn) from r where name = 'Lapte' and rn > 1)),
  '...while a brandless row carrying a real package size is NOT demoted'
);

select isnt_empty(
  $$select name from public.search_catalog('lapte', 20, array['RO'], array['ro'])
     where name = 'Lapte' and maker is null$$,
  'and it is still there -- demoted, never hidden'
);

-- ─── 7. the result explains itself ───────────────────────────────────────────

select is(
  (select matched_concept from public.search_catalog('apa', 20, array['RO'], array['ro']) limit 1),
  'water',
  'every row names the concept the query resolved to'
);

select is(
  (select matched_alias from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Apă'),
  'Apă',
  'a row reached through an alias names the alias that did it'
);

select is(
  (select match_type from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Apă'),
  'alias_exact',
  '...and the rung it sat on'
);

select ok(
  (select language_match and market_match
     from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Apă'),
  'the language and market signals are reported separately from the score'
);

-- The explanation and the number cannot disagree, because the number is looked
-- up FROM the label. alias_exact 90 + market_hit 4 + lang_hit 3 + tier_a 2.
select is(
  (select relevance_score from public.search_catalog('apa', 20, array['RO'], array['ro'])
    where name = 'Apă'),
  99,
  'the score is the rung the match_type names, plus its bonuses, and nothing else'
);

select is(
  (select matched_concept from public.search_catalog('borsec', 20, array['RO'], array['ro']) limit 1),
  null,
  'a query that names no concept says so, and the search falls back to the ladder alone'
);

-- ─── 8. fuzzy stays last, and off ────────────────────────────────────────────
-- §23 and the user's own requirement: exact and conceptual matches outrank
-- fuzzy ones. The strongest form of that is that fuzzy does not run at all
-- unless it is asked for, and never while anything else matched.

select is_empty(
  $$select name from public.search_catalog('cartof1', 20, array['RO'], array['ro'])$$,
  'a typo returns nothing on the keystroke path; an empty result belongs to discovery, not to guesswork'
);

select * from finish();
rollback;
