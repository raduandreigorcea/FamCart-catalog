-- ─── concepts ────────────────────────────────────────────────────────────────
-- What a person MEANS when they type a word, kept apart from what the catalog
-- can sell them.
--
-- ─── why this table has to exist ─────────────────────────────────────────────
--
-- Until this file, the catalog had no idea of a concept. A concept WAS a
-- generic product row: "water" existed because `catalog_products` held a row
-- named Water/Apă/Wasser, and it was that row's aliases that made the six
-- languages reach one thing. That conflation looks harmless and produced three
-- distinct failures, all of which are the same bug wearing different clothes.
--
--   1. A CONCEPT COULD NOT EXIST WITHOUT A PRODUCT. Fifty brandless concepts
--      (shampoo, deodorant, laundry detergent, coffee, beer, nappies) were
--      deliberately removed from the seed, because a list saying "Shampoo"
--      makes whoever is holding it guess. That judgement was right and it is
--      not reversed here. But deleting the product also deleted the only place
--      that knew `deodorant`, `desodorante` and `deodorante` are one idea. Those
--      three now resolve to nothing, miss locally, and arrive at discovery as
--      three unrelated cache keys that will never share an answer.
--
--   2. A GENERIC ROW ANSWERED FOR ITS WHOLE CATEGORY. `apa` matched the seed's
--      own row named Apă, which contains every word typed, so the local answer
--      was declared sufficient and discovery NEVER RAN — not once — for one of
--      the commonest words in the catalog's main language, while AQUA Carpatica
--      and Borsec sat one API call away.
--
--   3. THE OPPOSITE, once (2) was fixed by demanding six BRANDED rows: `cartofi`
--      now fires an external call on every keystroke, forever, because potatoes
--      have no brands and never will. There is no row count that is right for
--      both water and potatoes, because the difference between them is not a
--      quantity. It is a fact about the word.
--
-- ─── intent, which is that fact ──────────────────────────────────────────────
--
--   'generic'   the bare word is a thing you can buy. cartofi, morcovi, mere,
--               banane, rosii. A row with no brand is a COMPLETE answer, and
--               asking an external database for branded carrots is a waste of a
--               request nobody was waiting for.
--
--   'branded'   the bare word is a category, not a purchase. apa, deodorant,
--               salam, detergent, sampon, pasta de dinti. Somebody typing it is
--               choosing among commercial products, so a generic row is a
--               placeholder that answers nothing — it must never suppress
--               discovery and must never outrank a real product.
--
--   'mixed'     both readings are ordinary. lapte, paine, cafea, branza. You
--               might write "milk" on a list and mean any milk, or you might
--               mean Zuzu 1.5%. Rank both, prefer neither by rule.
--
-- INTENT BELONGS TO THE WORD, NOT TO THE ROW, and that is the whole reason this
-- is a new table rather than a column. `catalog_products.product_type` already
-- says whether a ROW is generic or commercial and it stays exactly as it was;
-- those are different questions and conflating them is what got us here. "Is
-- this row a concept or a product" and "should this word return concepts at
-- all" are orthogonal, and a schema that can only express the first cannot
-- answer the second at any row count.
--
-- ─── what this file deliberately does NOT do ─────────────────────────────────
--
-- It changes no ranking and no search behaviour. `search_catalog` is untouched
-- here and continues to work exactly as it does today, on a database where
-- these tables are empty. That is the point of landing it alone: a schema that
-- nothing reads yet cannot regress a dropdown, and the seed, the backfill and
-- the ranking each get to be verified against a base that is already proven.

-- ─── concepts ────────────────────────────────────────────────────────────────
create table if not exists public.catalog_concepts (
  id uuid primary key default gen_random_uuid(),

  -- Stable, language-neutral, and the thing the seed file keys on. English-ish
  -- by convention because the seed is authored in English, but it is an
  -- IDENTIFIER rather than a name: nothing displays it and nothing searches it.
  -- The searchable strings all live in catalog_concept_terms, in six languages,
  -- precisely so that no language is privileged by the schema.
  slug text not null,

  -- 'generic' | 'branded' | 'mixed'. See the header.
  intent text not null,

  -- The same closed list as catalog_products.category, and closed for the same
  -- reason: a category is a search term in six languages, so an open string
  -- field means untranslated categories that quietly match nothing. Null is
  -- ordinary — a concept does not have to be shelved to be useful.
  category text,

  -- Editorial priority when two concepts answer to the same string. Not a
  -- product weight and never added to one: this decides WHICH CONCEPT a word
  -- resolves to, not where any product ranks. See catalog_concept_resolve().
  base_weight integer not null default 0,

  -- 'curated'    authored in catalog/seed/concepts.json by a person.
  -- 'discovered' minted automatically from a search that found real products
  --              for a word no concept claimed.
  --
  -- Nothing writes 'discovered' yet. The column exists now because the
  -- alternative is a second migration against a table the seed has already
  -- filled, and because a concept whose intent nobody chose must be
  -- distinguishable from one somebody did — an automatic guess should be
  -- correctable, and you cannot correct what you cannot find.
  origin text not null default 'curated',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── bounds that have to be restated ─────────────────────────────────────────
-- Everything inside the `create table if not exists` above is skipped on any
-- database this file has already run against, so a bound declared only there
-- reaches new databases and never production. Same rule as 002: change them
-- HERE.

alter table public.catalog_concepts
  drop constraint if exists catalog_concepts_intent_check;
alter table public.catalog_concepts
  add constraint catalog_concepts_intent_check
  check (intent in ('generic', 'branded', 'mixed'));

alter table public.catalog_concepts
  drop constraint if exists catalog_concepts_origin_check;
alter table public.catalog_concepts
  add constraint catalog_concepts_origin_check
  check (origin in ('curated', 'discovered'));

alter table public.catalog_concepts
  drop constraint if exists catalog_concepts_slug_check;
alter table public.catalog_concepts
  add constraint catalog_concepts_slug_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 1 and 80);

-- Byte-identical to catalog_products_category_check. Two copies of one list is
-- a real risk and the alternative is worse: a lookup table would put a join on
-- the hot path of every keystroke to enforce something a check constraint
-- enforces for free. schema.test.sql pins the two lists together.
alter table public.catalog_concepts
  drop constraint if exists catalog_concepts_category_check;
alter table public.catalog_concepts
  add constraint catalog_concepts_category_check
  check (category is null or category in (
    'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
    'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
    'health', 'pet', 'home', 'other'
  ));

alter table public.catalog_concepts
  drop constraint if exists catalog_concepts_weight_check;
alter table public.catalog_concepts
  add constraint catalog_concepts_weight_check
  check (base_weight between 0 and 1000000);

create unique index if not exists catalog_concepts_slug_key
  on public.catalog_concepts (slug);

comment on table public.catalog_concepts is
  'What a word MEANS, and whether the bare word is something you can buy. Separate from catalog_products on purpose: intent is a fact about the word, product_type is a fact about the row.';

-- ─── the strings that reach a concept ────────────────────────────────────────
-- Every spelling, in every language, that should resolve to one idea.
--
-- SEPARATE FROM catalog_aliases, and the distinction is the entire point of
-- this migration. An alias reaches a PRODUCT: "Milch" finds the row named Milk.
-- A term reaches a CONCEPT, which may have no product at all — `deodorant` has
-- to be a known word with a known intent on a database that holds not one
-- deodorant, because that is exactly the case where knowing what the word means
-- changes what we do about it (ask externally, and do not offer a placeholder).
--
--   'label'    the concept's name in one language. 'Apă' is the ro label of
--              water; 'Wasser' is the de label.
--   'synonym'  another way to say it in some language: "washing powder" for
--              laundry detergent, "sifon" for sparkling water.
create table if not exists public.catalog_concept_terms (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.catalog_concepts(id) on delete cascade,

  term text not null,
  -- Derived by the trigger below, never supplied. Same fold as everything else,
  -- because a term has to match a query that was folded by catalog_normalize.
  normalized_term text not null default '',

  -- Null where the term is language-neutral. Rare for a concept and left
  -- possible on purpose: a word like "wifi" is nobody's translation.
  lang text,
  term_type text not null default 'synonym',

  created_at timestamptz not null default now()
);

alter table public.catalog_concept_terms
  drop constraint if exists catalog_concept_terms_type_check;
alter table public.catalog_concept_terms
  add constraint catalog_concept_terms_type_check
  check (term_type in ('label', 'synonym'));

alter table public.catalog_concept_terms
  drop constraint if exists catalog_concept_terms_lang_check;
alter table public.catalog_concept_terms
  add constraint catalog_concept_terms_lang_check
  check (lang is null or lang in ('en', 'de', 'es', 'ro', 'fr', 'it'));

alter table public.catalog_concept_terms
  drop constraint if exists catalog_concept_terms_length_check;
alter table public.catalog_concept_terms
  add constraint catalog_concept_terms_length_check
  check (char_length(btrim(term)) between 1 and 120);

alter table public.catalog_concept_terms
  drop constraint if exists catalog_concept_terms_normalized_length_check;
alter table public.catalog_concept_terms
  add constraint catalog_concept_terms_normalized_length_check
  check (char_length(normalized_term) <= 200);

-- One concept holds one folded string PER LANGUAGE, so re-running the seed adds
-- nothing. This is the dedupe rule for terms and the reason the importer can be
-- as careless as it likes about repeats.
--
-- ─── why the language is part of the key ─────────────────────────────────────
-- The obvious index is (concept_id, normalized_term), and it collapses a
-- concept whose name is spelled the same everywhere down to a single row —
-- Mozzarella, Broccoli, Vodka, Prosciutto are one string in all six languages.
-- That looks like a harmless saving and it silently breaks resolution's most
-- important tie-break.
--
-- `prosciutto` is the case that found it. It is the Italian word for ham, so
-- the `ham` concept carries it as its it label; it is ALSO a specific cured
-- product that English and Romanian borrowed, which is its own concept. With
-- the language collapsed, the borrowed concept kept only its en row, so a
-- Romanian searching `prosciutto` matched no term in ro, fell through to
-- editorial weight, and got ham. Keeping one row per language lets each
-- language answer for itself, which is the entire job of the first sort key.
--
-- coalesce() rather than `nulls not distinct`: a language-neutral term has a
-- null lang, and a plain unique index treats two nulls as distinct, so the same
-- neutral string would insert twice and the importer's `on conflict` would
-- never fire.
create unique index if not exists catalog_concept_terms_unique
  on public.catalog_concept_terms (concept_id, normalized_term, coalesce(lang, ''));

-- ─── NOT unique globally, and that is deliberate ─────────────────────────────
-- The obvious index here is `unique (normalized_term)`, and it would be wrong.
-- Six languages collide on real words:
--
--     'prune'   ro: fresh plums          en: dried plums     (two concepts)
--     'mora'    es/it: blackberry                            (one concept)
--     'salsa'   es/it: sauce                                 (one concept)
--
-- A global unique index makes the first case unloadable — the seed simply fails
-- — and the fix would be to silently drop one language's word, which is the
-- worse outcome: a Romanian searching `prune` would resolve to dried plums and
-- never know why. So collisions are ALLOWED and resolved deterministically, by
-- language first. See catalog_concept_resolve().
create index if not exists catalog_concept_terms_normalized
  on public.catalog_concept_terms (normalized_term);

create index if not exists catalog_concept_terms_concept
  on public.catalog_concept_terms (concept_id);

comment on table public.catalog_concept_terms is
  'Every string in every language that resolves to a concept. Distinct from catalog_aliases, which reaches a product: a concept can have terms and no products at all, which is precisely the case that matters.';

-- ─── derived, and why these triggers are definer ─────────────────────────────
-- catalog_normalize() is executable by nobody but its owner — a client that can
-- compute the merge key can craft a name that collides with an existing
-- product — so a trigger running with the caller's rights dies with "permission
-- denied for function catalog_normalize" on every insert. Same reasoning, and
-- the same shape, as catalog_aliases_derive() in 002.
create or replace function public.catalog_concept_terms_derive()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  new.normalized_term := public.catalog_normalize(new.term, null);
  return new;
end;
$$;

drop trigger if exists catalog_concept_terms_derive on public.catalog_concept_terms;
create trigger catalog_concept_terms_derive
  before insert or update on public.catalog_concept_terms
  for each row execute function public.catalog_concept_terms_derive();

create or replace function public.catalog_concepts_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists catalog_concepts_touch on public.catalog_concepts;
create trigger catalog_concepts_touch
  before insert or update on public.catalog_concepts
  for each row execute function public.catalog_concepts_touch();

-- ─── which concept a product belongs to ──────────────────────────────────────
-- Nullable, and expected to stay null for most discovered rows.
--
-- HOW A PRODUCT GETS ONE, in descending order of confidence, and there is no
-- fourth way:
--
--   1. The seed states it. A generic row IS its own concept; a curated
--      commercial row can name one.
--   2. Discovery attributes it. The query that found the row already resolved
--      to a concept, so the attribution is free and it is EVIDENCE rather than
--      a guess: somebody typed `apa`, this product came back and passed the
--      relevance filter, therefore it is a water.
--   3. An admin corrects it.
--
-- NEVER INFERRED FROM THE NAME. Deciding that "Lapte de migdale" belongs to the
-- milk concept because the string starts with "lapte" is exactly the confident
-- wrong merge §15 forbids, and it would be unpickable afterwards.
--
-- `on delete set null` and not cascade. Deleting a concept is an editorial act;
-- it must never take products with it. Losing an attribution costs ranking
-- reach and is recoverable — losing the products is not.
alter table public.catalog_products
  add column if not exists concept_id uuid;

alter table public.catalog_products
  drop constraint if exists catalog_products_concept_fk;
alter table public.catalog_products
  add constraint catalog_products_concept_fk
  foreign key (concept_id) references public.catalog_concepts(id) on delete set null;

create index if not exists catalog_products_concept
  on public.catalog_products (concept_id);

-- ─── resolution ──────────────────────────────────────────────────────────────
-- One folded string, in one language, to at most one concept.
--
-- EXACT MATCH ONLY, and this is the single most important line in the file. A
-- fuzzy concept resolution would reintroduce the failure that took the fuzzy
-- search off the keystroke path: `champu` scores 0.714 against Champignon and
-- `sampoo` scores 0.714 against Sampon, so no threshold separates "a typo for a
-- concept" from "a real word that resembles one". Resolving `champu` to the
-- mushroom concept would then apply the WRONG INTENT to the whole search, which
-- is worse than not resolving at all: a miss here simply falls back to today's
-- behaviour, while a wrong hit reorders the dropdown with confidence.
--
-- SECURITY DEFINER because it calls catalog_normalize(), which is revoked from
-- every client role. It returns a uuid and never the folded string, so it
-- leaks nothing a client could use to compute a merge key.
--
-- The tie-break, when a string genuinely belongs to two concepts:
--
--   1. a term in the SEARCHER'S OWN LANGUAGE wins. This is the `prune` case,
--      and it is the only rule that gets it right for both people.
--   2. then a language-neutral term, which is a deliberate claim on the word
--      rather than an accident of one language.
--   3. then a label over a synonym: a concept's own name beats another
--      concept's nickname for something else.
--   4. then editorial weight, then slug, so the answer is stable rather than
--      whatever the planner returned first. A resolution that changes between
--      two identical calls would be untestable.
create or replace function public.catalog_concept_resolve(
  p_query text,
  p_lang  text default null
)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.id
  from public.catalog_concept_terms t
  join public.catalog_concepts c on c.id = t.concept_id
  where t.normalized_term = public.catalog_normalize(coalesce(p_query, ''), null)
    and public.catalog_normalize(coalesce(p_query, ''), null) <> ''
  order by
    (p_lang is not null and t.lang = p_lang) desc,
    (t.lang is null)                         desc,
    (t.term_type = 'label')                  desc,
    c.base_weight                            desc,
    c.slug
  limit 1;
$$;

comment on function public.catalog_concept_resolve(text, text) is
  'Fold a query and return the concept it names, or null. Exact match only: a fuzzy resolution would apply the wrong intent to a whole search, which is worse than resolving nothing.';

revoke all on function public.catalog_concept_resolve(text, text) from public, anon;
grant execute on function public.catalog_concept_resolve(text, text) to authenticated;
grant execute on function public.catalog_concept_resolve(text, text) to service_role;

-- ─── who may read this ───────────────────────────────────────────────────────
-- Signed in, read-only, exactly like catalog_products. There is no client write
-- path and there is not meant to be: concepts arrive from the seed importer
-- (service role) and, later, from discovery (service role).
--
-- Two gates. The grants open the first; RLS decides the rows. A table with RLS
-- on and no policy is invisible, and a policy with no grant fails with
-- "permission denied" before RLS is consulted.
--
-- Readable rather than definer-only because the admin dashboard has to be able
-- to list concepts and their intent to review them, and because a concept is
-- editorial data about words. It says nothing about any person and nothing
-- about how the catalog is built.
alter table public.catalog_concepts      enable row level security;
alter table public.catalog_concept_terms enable row level security;

drop policy if exists "signed-in users can read concepts" on public.catalog_concepts;
create policy "signed-in users can read concepts"
  on public.catalog_concepts for select to authenticated using (true);

drop policy if exists "signed-in users can read concept terms" on public.catalog_concept_terms;
create policy "signed-in users can read concept terms"
  on public.catalog_concept_terms for select to authenticated using (true);

revoke all on public.catalog_concepts      from anon, authenticated;
revoke all on public.catalog_concept_terms from anon, authenticated;

grant select on public.catalog_concepts      to authenticated;
grant select on public.catalog_concept_terms to authenticated;

-- ─── the whole concept, in one round trip ────────────────────────────────────
-- catalog_concept_resolve() answers "which concept", which is all the ranking
-- needs because it is already inside the database and can join. The DISCOVERY
-- function is not: it is a Deno process deciding, before it calls anything
-- external, whether it should call anything external at all. It needs the
-- intent and it needs the id, and asking for them separately would be two
-- network round trips on the one path where somebody is waiting.
--
-- Returns zero rows rather than a row of nulls when nothing resolves, so the
-- caller distinguishes "no concept" from "a concept with no category" without
-- inspecting fields.
create or replace function public.catalog_concept_lookup(
  p_query text,
  p_lang  text default null
)
returns table (id uuid, slug text, intent text, category text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.id, c.slug, c.intent, c.category
  from public.catalog_concepts c
  where c.id = public.catalog_concept_resolve(p_query, p_lang);
$$;

comment on function public.catalog_concept_lookup(text, text) is
  'Resolve a query to its concept and return the intent with it. For the discovery function, which decides whether to make an external call at all.';

revoke all on function public.catalog_concept_lookup(text, text) from public, anon;
grant execute on function public.catalog_concept_lookup(text, text) to authenticated;
grant execute on function public.catalog_concept_lookup(text, text) to service_role;
