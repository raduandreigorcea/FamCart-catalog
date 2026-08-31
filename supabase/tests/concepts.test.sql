-- The concept layer: what a word means, and whether the bare word is buyable.
--
--   npx supabase --workdir catalog db reset    -- never skip this
--   npx supabase --workdir catalog test db
--
-- What these assert, in the order the schema builds them up:
--
--   1. The bounds hold. Intent is one of three values and nothing else, and a
--      concept's category list is BYTE-IDENTICAL to a product's — two copies of
--      one closed list is the risk this file exists to pin.
--   2. A term's folded form is the database's to compute, never the caller's,
--      and one concept cannot hold the same folded string twice. That is what
--      makes the seed importer safe to re-run.
--   3. Two concepts CAN hold the same string. `prune` is fresh plums in Romanian
--      and dried plums in English, and a global unique index would make the seed
--      unloadable — so collisions are legal and resolution breaks the tie by
--      language.
--   4. Resolution is EXACT. `champu` resolves to nothing rather than to the
--      mushroom concept, because applying a wrong intent to a whole search is
--      worse than applying none.
--   5. Deleting a concept never deletes a product. It is an editorial act on a
--      word; the products it was attached to keep existing, unattributed.
--   6. Reads are for signed-in users; anon reaches nothing and no client role
--      can write a concept into existence.
--
-- Everything runs inside a rolled-back transaction, so it leaves no rows.

begin;
select plan(35);

-- Start from an empty concept layer whatever this database holds, for the same
-- reason schema.test.sql does: the suite has to be correct even when run after
-- a seed. Products first — they reference concepts.
delete from public.catalog_products;
delete from public.catalog_concepts;

-- ─── 1. bounds ───────────────────────────────────────────────────────────────

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent) values ('water', 'commercial')$$,
  '23514', null,
  'intent is one of generic, branded, mixed — and "commercial" is a product_type, not an intent'
);

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent, origin) values ('water', 'branded', 'guessed')$$,
  '23514', null,
  'origin is curated or discovered; an unreviewed third state would hide automatic guesses'
);

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent) values ('Laundry Detergent', 'branded')$$,
  '23514', null,
  'a slug is kebab-case and language-neutral; a display name in it would invite searching on it'
);

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent, category) values ('water', 'branded', 'beverages')$$,
  '23514', null,
  'a category comes from the closed list; an open one means untranslated shelves that match nothing'
);

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent, base_weight) values ('water', 'branded', -1)$$,
  '23514', null,
  'editorial weight cannot be negative'
);

-- ─── the pin ─────────────────────────────────────────────────────────────────
-- Two copies of one closed list, in two tables. A lookup table would remove the
-- duplication and put a join on the hot path of every keystroke; this assertion
-- is the cheaper way to keep them honest, and it fails the moment somebody adds
-- a category to one table and forgets the other.
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'catalog_concepts_category_check'),
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'catalog_products_category_check'),
  'the concept category list is byte-identical to the product category list'
);

-- ─── fixtures ────────────────────────────────────────────────────────────────

insert into public.catalog_concepts (id, slug, intent, category, base_weight) values
  ('00000000-0000-0000-0000-0000000c0001', 'water',       'branded', 'drinks',  100),
  ('00000000-0000-0000-0000-0000000c0002', 'potato',      'generic', 'produce', 100),
  ('00000000-0000-0000-0000-0000000c0003', 'milk',        'mixed',   'dairy',   100),
  ('00000000-0000-0000-0000-0000000c0004', 'plum-fresh',  'generic', 'produce',  50),
  ('00000000-0000-0000-0000-0000000c0005', 'plum-dried',  'generic', 'pantry',   50),
  ('00000000-0000-0000-0000-0000000c0006', 'mushroom',    'generic', 'produce',  50),
  ('00000000-0000-0000-0000-0000000c0007', 'sparkling-water', 'branded', 'drinks', 40);

select throws_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang, term_type)
    values ('00000000-0000-0000-0000-0000000c0001', 'Apă', 'ro', 'nickname')$$,
  '23514', null,
  'a term is a label or a synonym; nothing else reaches a concept'
);

select throws_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang)
    values ('00000000-0000-0000-0000-0000000c0001', 'Vand', 'nl')$$,
  '23514', null,
  'a term is in one of the six languages the interface speaks, or in none'
);

-- Water, in all six. This is the thing that could not exist before: the concept
-- is BRANDED, so no generic product named "Water" needs to exist for these six
-- strings to mean one thing.
insert into public.catalog_concept_terms (concept_id, term, lang, term_type) values
  ('00000000-0000-0000-0000-0000000c0001', 'Water',  'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Apă',    'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Wasser', 'de', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Eau',    'fr', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Acqua',  'it', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Agua',   'es', 'label');

insert into public.catalog_concept_terms (concept_id, term, lang, term_type) values
  ('00000000-0000-0000-0000-0000000c0004', 'Prune',      'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0005', 'Prune',      'en', 'label'),
  ('00000000-0000-0000-0000-0000000c0006', 'Champignon', 'fr', 'label'),
  ('00000000-0000-0000-0000-0000000c0007', 'Sifon',      'ro', 'label'),
  ('00000000-0000-0000-0000-0000000c0001', 'Sifon',      'ro', 'synonym');

-- ─── 2. derived, and the caller does not get a say ───────────────────────────

select is(
  (select normalized_term from public.catalog_concept_terms
    where concept_id = '00000000-0000-0000-0000-0000000c0001' and lang = 'ro' and term_type = 'label'),
  'apa',
  'a term folds through catalog_normalize: "Apă" is stored matchable as "apa"'
);

insert into public.catalog_concept_terms (concept_id, term, lang, normalized_term)
values ('00000000-0000-0000-0000-0000000c0002', 'Cartofi', 'ro', 'ANYTHING I LIKE');

select is(
  (select normalized_term from public.catalog_concept_terms
    where concept_id = '00000000-0000-0000-0000-0000000c0002' and lang = 'ro'),
  'cartofi',
  'the fold is the database''s to compute; a supplied normalized_term is overwritten'
);

select throws_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang)
    values ('00000000-0000-0000-0000-0000000c0001', 'apa', 'ro')$$,
  '23505', null,
  'one concept holds a folded string once, so re-running the seed adds nothing'
);

select lives_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang)
    values ('00000000-0000-0000-0000-0000000c0003', 'Apa', 'ro')$$,
  'a DIFFERENT concept may hold the same string; collisions across languages are real and legal'
);

-- ─── the language is part of a term's identity ───────────────────────────────
-- Keyed on (concept_id, normalized_term) alone, a concept spelled the same in
-- every language collapses to one row and then cannot win resolution's language
-- tie-break. Mozzarella, Broccoli, Vodka and Prosciutto are all one string in
-- all six; `prosciutto` is the one where it bites, because Italian genuinely
-- means ham by it and every other language means the cured product.
select lives_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang, term_type)
    values ('00000000-0000-0000-0000-0000000c0006', 'Champignon', 'de', 'label')$$,
  'one concept keeps the same string once PER LANGUAGE, so a name spelled alike everywhere still answers for each'
);

select is(
  (select count(*) from public.catalog_concept_terms
    where concept_id = '00000000-0000-0000-0000-0000000c0006' and normalized_term = 'champignon'),
  2::bigint,
  '...both rows survive, where a language-blind key would have kept one'
);

-- Undo that one so it cannot skew the resolution assertions below.
delete from public.catalog_concept_terms
 where concept_id = '00000000-0000-0000-0000-0000000c0003' and normalized_term = 'apa';

-- ─── 3. resolution ───────────────────────────────────────────────────────────

select is(
  public.catalog_concept_resolve('apa', 'ro'),
  '00000000-0000-0000-0000-0000000c0001'::uuid,
  'apa resolves to water'
);

select is(
  (select count(distinct public.catalog_concept_resolve(t, null))
     from unnest(array['water', 'apa', 'wasser', 'eau', 'acqua', 'agua']) as t),
  1::bigint,
  'all six languages resolve to ONE concept — the thing that stopped working when the generic row was removed'
);

select is(
  public.catalog_concept_resolve('  APĂ  ', 'ro'),
  '00000000-0000-0000-0000-0000000c0001'::uuid,
  'the query is folded the same way the term was: case, diacritics and padding do not matter'
);

select is(
  public.catalog_concept_resolve('chorizo', 'en'),
  null,
  'a word no concept claims resolves to nothing, and the search falls back to what it does today'
);

select is(
  public.catalog_concept_resolve('', 'en'),
  null,
  'an empty query resolves to nothing rather than to whatever sorts first'
);

select is(
  public.catalog_concept_resolve(null, null),
  null,
  'a null query resolves to nothing'
);

-- ─── THE ONE THAT MATTERS MOST ───────────────────────────────────────────────
-- `champu` scores 0.714 against Champignon on word_similarity, which is exactly
-- why the fuzzy search was taken off the keystroke path. Resolving it here
-- would be worse than that bug ever was: a wrong concept applies a wrong INTENT
-- to the entire search, reordering every result with confidence. A miss simply
-- falls back to today's behaviour.
select is(
  public.catalog_concept_resolve('champu', 'es'),
  null,
  'resolution is exact: champu does not become the mushroom concept'
);

select is(
  public.catalog_concept_resolve('prune', 'ro'),
  '00000000-0000-0000-0000-0000000c0004'::uuid,
  'a colliding string resolves by the searcher''s language: prune is fresh plums in Romanian'
);

select is(
  public.catalog_concept_resolve('prune', 'en'),
  '00000000-0000-0000-0000-0000000c0005'::uuid,
  '...and dried plums in English, from the same row set'
);

select is(
  public.catalog_concept_resolve('sifon', 'ro'),
  '00000000-0000-0000-0000-0000000c0007'::uuid,
  'a concept''s own label beats another concept''s synonym for the same string'
);

-- ─── 4. products belong to concepts, and survive them ────────────────────────

insert into public.catalog_products (id, product_type, canonical_name, name_lang, brand, concept_id)
values
  ('00000000-0000-0000-0000-00000000b001', 'commercial', 'Apa Plata 2L', 'ro', 'Dorna',
   '00000000-0000-0000-0000-0000000c0001'),
  ('00000000-0000-0000-0000-00000000b002', 'generic', 'Potatoes', 'en', null,
   '00000000-0000-0000-0000-0000000c0002');

select is(
  (select concept_id from public.catalog_products
    where id = '00000000-0000-0000-0000-00000000b001'),
  '00000000-0000-0000-0000-0000000c0001'::uuid,
  'a product carries the concept the search that found it resolved to'
);

select throws_ok(
  $$update public.catalog_products
      set concept_id = '00000000-0000-0000-0000-0000000cffff'
    where id = '00000000-0000-0000-0000-00000000b001'$$,
  '23503', null,
  'a product cannot point at a concept that does not exist'
);

delete from public.catalog_concepts where id = '00000000-0000-0000-0000-0000000c0001';

select is(
  (select count(*) from public.catalog_products
    where id = '00000000-0000-0000-0000-00000000b001'),
  1::bigint,
  'DELETING A CONCEPT NEVER DELETES A PRODUCT — losing an attribution is recoverable, losing the row is not'
);

select is(
  (select concept_id from public.catalog_products
    where id = '00000000-0000-0000-0000-00000000b001'),
  null,
  '...the attribution is simply cleared'
);

select is(
  (select count(*) from public.catalog_concept_terms
    where concept_id = '00000000-0000-0000-0000-0000000c0001'),
  0::bigint,
  'its terms go with it, because a term with no concept reaches nothing'
);

-- ─── 5. who may read and write ───────────────────────────────────────────────

set local role anon;

select throws_ok(
  $$select count(*) from public.catalog_concepts$$,
  '42501', null,
  'a signed-out request cannot read concepts at all — it fails at the grant, before RLS'
);

select throws_ok(
  $$select count(*) from public.catalog_concept_terms$$,
  '42501', null,
  'nor terms'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select ok(
  (select count(*) from public.catalog_concepts) > 0,
  'a signed-in user can read concepts; the admin dashboard reviews intent through this'
);

select ok(
  (select count(*) from public.catalog_concept_terms) > 0,
  'and the terms that reach them'
);

select throws_ok(
  $$insert into public.catalog_concepts (slug, intent) values ('injected', 'generic')$$,
  '42501', null,
  'a signed-in user cannot mint a concept; intent is editorial and arrives by seed or by review'
);

select throws_ok(
  $$insert into public.catalog_concept_terms (concept_id, term, lang)
    values ('00000000-0000-0000-0000-0000000c0002', 'injected', 'en')$$,
  '42501', null,
  'nor attach a string to one, which would silently redirect everybody else''s search'
);

reset role;

select * from finish();
rollback;
