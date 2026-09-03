-- ─── the catalog ─────────────────────────────────────────────────────────────
-- Four tables and one folding rule.
--
--   catalog_products      one row per product the catalog is willing to offer
--   catalog_aliases       every other string that should reach that row
--   catalog_identifiers   GTINs and part numbers — the exact keys
--   catalog_sources       where each row came from, kept forever
--
-- The split is not tidiness. Each of the three satellites exists because
-- something about a product is genuinely one-to-many, and folding any of them
-- into a column would force a lossy choice:
--
--   * A product has a name in six languages. Storing one and overwriting it on
--     the next import loses the other five; storing them in a column loses which
--     language each is. `lapte`, `milk`, `lait`, `latte`, `leche` and `milch`
--     have to reach ONE row and that row has to come back readable.
--   * A product can carry several barcodes (a relabelled pack, a multipack, a
--     regional variant) and a barcode must never be guessed at. An exact key
--     belongs in a table with a unique index on it, not in a column that the
--     next import overwrites.
--   * Provenance is a licensing fact. Open Food Facts data is ODbL; knowing
--     which rows came from it is not optional, and a row can be corroborated by
--     more than one source.
--
-- WHAT THIS TABLE IS NOT. It is not a mirror of Open Food Facts. Nothing here
-- stores nutrition, ingredients, packaging codes or raw source payloads, and
-- nothing bulk-loads a dump into it. Rows arrive two ways: the curated seed in
-- catalog/seed/products.json, and single products discovered because a real
-- person searched for something the catalog did not know. That is the whole
-- growth mechanism, and the reason the row count is expected to stay small.

-- ─── the folding rule ────────────────────────────────────────────────────────
-- The one authority on what a product's matching key is.
--
-- Byte-for-byte the same fold as the app project's product_search_text() and as
-- normalizeSearchText() in src/lib/productSearch.ts: lowercase, strip
-- diacritics, collapse whitespace. Those two use NFD + \p{Diacritic}; unaccent
-- is dictionary-based and agrees with them across Latin text, which is all any
-- of the three ever sees.
--
-- Three copies of one rule is a real risk, and the reason it is three rather
-- than one is that they live in three runtimes: this database, the app database,
-- and the browser. The consequence of a drift is not a crash — it is a product
-- that can be inserted twice because the unique index folded it differently from
-- the search that was supposed to find it. test/catalog/normalize.test.js pins
-- the TypeScript copy against the cases below.
--
-- search_path includes extensions because unaccent/1 resolves its dictionary by
-- name through it.
create or replace function public.catalog_normalize(p_name text, p_brand text default null)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select lower(
    regexp_replace(
      btrim(extensions.unaccent(
        btrim(coalesce(p_name, '')) || coalesce(' ' || nullif(btrim(p_brand), ''), '')
      )),
      '\s+', ' ', 'g'
    )
  );
$$;

-- Internal. Everything that needs it is SECURITY DEFINER and owned by the same
-- role; a client calling it directly would learn the merge key, which is the one
-- thing a client must not be able to compute for itself.
revoke all on function public.catalog_normalize(text, text) from public, anon, authenticated;

-- ─── products ────────────────────────────────────────────────────────────────
create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),

  -- 'generic'    a shopping concept: Milk, Banana, Laundry Detergent, Batteries.
  --              No barcode, no brand, and none of that makes it low quality.
  -- 'commercial' a real product someone can pick off a shelf: Nutella 350g.
  --
  -- The two are scored by different rules (see quality_tier) because the same
  -- missing field means opposite things: a generic with no barcode is correct, a
  -- commercial one with neither barcode nor brand cannot be identified at all.
  product_type text not null,

  -- The name as the catalog states it, in name_lang. For a generic this is the
  -- English concept and every other language lives in catalog_aliases; for a
  -- commercial product it is the name the source published, untranslated,
  -- because a brand name is not a word to be translated.
  canonical_name text not null,
  name_lang      text not null,

  -- Reaches the app as `maker` and is shown as a subtitle. Null is ordinary: a
  -- banana has no brand.
  brand text,

  category text,

  -- Markets the product is actually sold in. A RELEVANCE SIGNAL, NOT A FILTER —
  -- search_catalog demotes a non-matching row rather than hiding it. A hard
  -- filter would give a household in a thin market an empty dropdown
  -- indistinguishable from "we have never heard of that product", which is the
  -- worst failure a search box has.
  --
  -- Empty means unknown, and unknown is not the same as "sold nowhere". Country
  -- metadata is missing from a great many honest Open Food Facts records and
  -- discarding them for it would throw away most of the useful ones.
  markets text[] not null default '{}',

  -- Package size, when the source stated it. Never inferred from the name and
  -- never invented: two rows whose quantities differ are two products
  -- (Pepsi Zero 500ml is not Pepsi Zero 2L), so a guess here silently merges or
  -- silently splits.
  quantity      numeric,
  quantity_unit text,

  image_url text,

  -- A = excellent, B = good, C = usable but incomplete. Anything that would
  -- score below C is not stored at all, so there is no REJECTED value here —
  -- rejection happens at the gate, before the insert, and is counted rather than
  -- persisted. Explained by catalog/supabase/functions/_shared/quality.ts, which is the authority; this
  -- column is its verdict cached for ranking.
  quality_tier text not null default 'C',

  -- popularity = base_weight + add_count, exactly as the app database computes
  -- it. base_weight is editorial (a curated staple outranks an obscure import on
  -- day one); add_count is earned, one tap at a time, by real people adding the
  -- product to a real list.
  base_weight integer not null default 0,
  add_count   integer not null default 0,
  popularity  integer generated always as (base_weight + add_count) stored,

  -- How many distinct sources have corroborated this row. Two sources agreeing
  -- is evidence; it is a ranking signal and never a merge criterion.
  source_count integer not null default 1,

  -- Derived, never supplied by a client. normalized_name is the merge key;
  -- search_blob is normalized_name plus every alias, and is the column
  -- autocomplete actually matches against. Both maintained by the triggers
  -- below — see catalog_refresh_search_blob() for why it takes two of them.
  normalized_name text not null default '',
  search_blob     text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── bounds that have to be restated ─────────────────────────────────────────
-- Everything inside the `create table if not exists` above is skipped on any
-- database this file has already run against, so a bound declared only there
-- reaches new databases and never production. These are the same constraints,
-- restated as statements that always run. Change them HERE; the copies above are
-- for a fresh clone's benefit and are the ones that get forgotten.

alter table public.catalog_products
  drop constraint if exists catalog_products_type_check;
alter table public.catalog_products
  add constraint catalog_products_type_check
  check (product_type in ('generic', 'commercial'));

-- 120 and 60 match the app database's product_catalog exactly. A discovered row
-- has to be able to travel: the app echoes a chosen product's name and maker
-- into its own catalog when a household contributes or a scan misses, and a
-- catalog row too long to fit there would fail that write instead of this one,
-- far from the cause.
alter table public.catalog_products
  drop constraint if exists catalog_products_name_length;
alter table public.catalog_products
  add constraint catalog_products_name_length
  check (char_length(btrim(canonical_name)) between 1 and 120);

alter table public.catalog_products
  drop constraint if exists catalog_products_brand_length;
alter table public.catalog_products
  add constraint catalog_products_brand_length
  check (brand is null or char_length(btrim(brand)) between 1 and 60);

-- The six languages FamCart's interface speaks. A name in a seventh cannot be
-- read by anybody using the app, so storing it as the canonical name would make
-- the product unfindable in practice while looking present in the table.
alter table public.catalog_products
  drop constraint if exists catalog_products_name_lang_check;
alter table public.catalog_products
  add constraint catalog_products_name_lang_check
  check (name_lang in ('en', 'de', 'es', 'ro', 'fr', 'it'));

-- ELEVEN CODES, NOT SIX, and the difference is load-bearing.
--
-- The specification names six primary markets (GB, DE, ES, RO, FR, IT) and the
-- seed covers those. But src/lib/region.ts derives a market from the phone's
-- timezone and can emit eleven — MD, AT, CH, BE and IE as well — and a market
-- code the app can send that this table can never hold matches no product at
-- all. A phone in Vienna would have the entire catalog demoted, which looks
-- exactly like a ranking bug and is in fact a missing string.
--
-- So the allowlist tracks what the APP CAN ASK FOR, not what the seed happens to
-- cover. If MARKETS in src/lib/region.ts ever grows, this list grows with it;
-- catalog/supabase/functions/_shared/markets.ts holds the TypeScript copy and test/catalog/markets.test.js
-- pins the two together.
alter table public.catalog_products
  drop constraint if exists catalog_products_markets_check;
alter table public.catalog_products
  add constraint catalog_products_markets_check
  check (markets <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]);

-- A closed list, because a category is a search term in six languages (its
-- translations live in catalog_aliases as alias_type='category') and an open
-- string field would mean untranslated categories that quietly match nothing.
alter table public.catalog_products
  drop constraint if exists catalog_products_category_check;
alter table public.catalog_products
  add constraint catalog_products_category_check
  check (category is null or category in (
    'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
    'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
    'health', 'pet', 'home', 'other'
  ));

alter table public.catalog_products
  drop constraint if exists catalog_products_quality_tier_check;
alter table public.catalog_products
  add constraint catalog_products_quality_tier_check
  check (quality_tier in ('A', 'B', 'C'));

-- A quantity without a unit is a number nobody can read, and a unit without a
-- quantity is worse — "ml" alone would render as a package size that does not
-- exist. Either both or neither.
--
-- THE `is not null` TERMS ARE NOT DECORATION. Written as
-- `quantity > 0 and quantity_unit in (...)`, a row with a quantity and no unit
-- evaluates to `true and null` = null, and a check constraint accepts null —
-- it rejects only an explicit false. The constraint looked right, read right,
-- and let exactly the row it was written to stop straight through. pgTAP caught
-- it; nothing else would have.
alter table public.catalog_products
  drop constraint if exists catalog_products_quantity_check;
alter table public.catalog_products
  add constraint catalog_products_quantity_check
  check (
    (quantity is null and quantity_unit is null)
    or (
      quantity is not null and quantity_unit is not null
      and quantity > 0
      and quantity_unit in ('g', 'kg', 'ml', 'l', 'cl', 'piece')
    )
  );

alter table public.catalog_products
  drop constraint if exists catalog_products_weights_check;
alter table public.catalog_products
  add constraint catalog_products_weights_check
  check (base_weight between 0 and 1000000 and add_count >= 0 and source_count >= 1);

-- Only http(s), and only a length a URL column can hold. A javascript: or data:
-- URL out of an external source would end up in an <img src> in the app.
alter table public.catalog_products
  drop constraint if exists catalog_products_image_url_check;
alter table public.catalog_products
  add constraint catalog_products_image_url_check
  check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 500));

alter table public.catalog_products
  drop constraint if exists catalog_products_derived_length_check;
alter table public.catalog_products
  add constraint catalog_products_derived_length_check
  check (char_length(normalized_name) <= 200 and char_length(search_blob) <= 4000);

-- ─── the merge key ───────────────────────────────────────────────────────────
-- ONE product per folded "name brand". This index IS the conservative
-- deduplication rule for anything without a barcode, and it is deliberately
-- strict rather than clever: it collapses two spellings that differ only by
-- case, accent or spacing, and nothing else.
--
-- What it therefore does NOT do is merge "Pepsi Zero 500ml" with "Pepsi Zero
-- 2L", because those fold differently. That is the intended outcome (§14: two
-- materially different packages are two products), and it is why quantity is
-- carried inside canonical_name rather than only in the quantity column.
--
-- Anything the fold cannot separate but a human would — a genuine near-duplicate
-- with a different word order — stays as two rows until stronger evidence
-- (a shared GTIN) arrives. Two rows is a cosmetic problem; a wrong merge
-- destroys a product.
create unique index if not exists catalog_products_normalized_name_key
  on public.catalog_products (normalized_name);

-- What autocomplete drives from. gin_trgm_ops rather than a tsvector because the
-- queries are prefixes and fragments typed into a box mid-word ("bana", "usb c"),
-- which a lexeme index does not answer.
create index if not exists catalog_products_search_blob_trgm
  on public.catalog_products using gin (search_blob extensions.gin_trgm_ops);

create index if not exists catalog_products_popularity
  on public.catalog_products (popularity desc);

-- Market matching is an array containment test on every candidate row, so it
-- needs its own index or it becomes a sequential scan behind the trigram one.
create index if not exists catalog_products_markets
  on public.catalog_products using gin (markets);

-- ─── aliases ─────────────────────────────────────────────────────────────────
-- Every other string that should find this product.
--
--   'name'      the product's name in another language. A generic's Romanian
--               name is a row here, and it is what search_catalog returns to a
--               Romanian phone instead of the English canonical.
--   'synonym'   a different word for the same thing in one language:
--               "courgette"/"zucchini", "washing powder"/"laundry detergent".
--   'category'  the category's own name in a language, so "detergent" reaches
--               every cleaning product and not only the ones named that.
--
-- Aliases ADD reach; they never overwrite. The source's own value stays in
-- canonical_name whatever gets learned about the product later.
create table if not exists public.catalog_aliases (
  id         uuid not null default gen_random_uuid() primary key,
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  alias      text not null,
  -- Derived by the trigger below, never supplied.
  normalized_alias text not null default '',
  -- Null where the alias is language-neutral (a brand spelling, a model number).
  lang       text,
  alias_type text not null default 'synonym',
  created_at timestamptz not null default now()
);

alter table public.catalog_aliases
  drop constraint if exists catalog_aliases_type_check;
alter table public.catalog_aliases
  add constraint catalog_aliases_type_check
  check (alias_type in ('name', 'synonym', 'category'));

alter table public.catalog_aliases
  drop constraint if exists catalog_aliases_lang_check;
alter table public.catalog_aliases
  add constraint catalog_aliases_lang_check
  check (lang is null or lang in ('en', 'de', 'es', 'ro', 'fr', 'it'));

alter table public.catalog_aliases
  drop constraint if exists catalog_aliases_length_check;
alter table public.catalog_aliases
  add constraint catalog_aliases_length_check
  check (char_length(btrim(alias)) between 1 and 120);

-- A localized NAME is singular: one product has one Romanian name, and a second
-- one is a synonym, not a competing name. Enforced rather than trusted, because
-- search_catalog picks the localized name with a LIMIT 1 and would otherwise
-- return a different string on different days for the same query.
create unique index if not exists catalog_aliases_one_name_per_lang
  on public.catalog_aliases (product_id, lang)
  where alias_type = 'name';

-- NULLS NOT DISTINCT so a language-neutral alias cannot be added twice. This is
-- what makes re-running the seed importer idempotent for aliases.
create unique index if not exists catalog_aliases_unique
  on public.catalog_aliases (product_id, normalized_alias, lang) nulls not distinct;

-- ─── identifiers ─────────────────────────────────────────────────────────────
-- The exact keys. A barcode scan resolves here and nowhere else — §25: never
-- fuzzy-match a barcode.
create table if not exists public.catalog_identifiers (
  id              uuid not null default gen_random_uuid() primary key,
  product_id      uuid not null references public.catalog_products(id) on delete cascade,
  identifier_type text not null default 'gtin',
  identifier_value text not null,
  -- Which source asserted it. Two sources can assert the same GTIN for the same
  -- product; the second is corroboration and increments source_count rather than
  -- inserting a row.
  source     text not null,
  created_at timestamptz not null default now()
);

alter table public.catalog_identifiers
  drop constraint if exists catalog_identifiers_type_check;
alter table public.catalog_identifiers
  add constraint catalog_identifiers_type_check
  check (identifier_type in ('gtin', 'mpn'));

-- GTIN-8/12/13/14 as digits only. The app's barcodeCandidates() already expands
-- a scan into the equivalent lengths (a UPC-A read as EAN-13 with a leading
-- zero), so this column holds exactly what a scanner produces after that.
--
-- NEVER INVENTED (§4, §12). A checksum is not verified here on purpose: real
-- printed barcodes with bad check digits exist in Open Food Facts, and refusing
-- them would lose products a scanner will nonetheless read. Length and
-- digits-only is the honest bound.
alter table public.catalog_identifiers
  drop constraint if exists catalog_identifiers_value_check;
alter table public.catalog_identifiers
  add constraint catalog_identifiers_value_check
  check (
    (identifier_type = 'gtin' and identifier_value ~ '^[0-9]{8,14}$')
    or (identifier_type = 'mpn' and char_length(btrim(identifier_value)) between 1 and 60)
  );

-- A GTIN names ONE product, globally. This unique index is the strong match of
-- §15: an import carrying a known barcode updates that product and can never
-- create a second row for it.
create unique index if not exists catalog_identifiers_value_key
  on public.catalog_identifiers (identifier_type, identifier_value);

create index if not exists catalog_identifiers_product
  on public.catalog_identifiers (product_id);

-- ─── a concept has no barcode ────────────────────────────────────────────────
-- 'Feta' is what somebody writes on a shopping list. The pack they pick up has
-- a code on it; the word does not. Nineteen generic rows in the live catalog
-- had collected one anyway, 'Feta' eleven of them, and the route in was not a
-- mistake anybody made by hand:
--
--   catalog_import_products() in 003 resolves identity by GTIN and then by
--   folded name (§12). Open Food Facts holds real packs named exactly 'Feta',
--   'Parmesan' and 'Spaghetti', so those fold onto the curated concept. THE
--   MERGE IS RIGHT -- a second row called 'Feta' would be a duplicate of the
--   concept -- but the identifier arriving with it is not, because
--   lookup_barcode() resolves through this table and nowhere else. Eleven
--   different feta packs all scanned as the word 'Feta', which is the answer
--   the shopper already had.
--
-- Enforced here rather than restated in each writer. There are three (the
-- importer in 003, and the admin's create and update in 009), all of them
-- reachable with a barcode and a type, and a rule copied into three places is a
-- rule that will hold in two of them.
--
-- 003 still skips the identifier for a generic row instead of relying on this,
-- and that is not redundant: an exception there is caught by the per-row handler
-- and costs the whole row, so the concept would lose the merge as well as the
-- code. Import drops the code quietly; a person typing one into the admin form
-- gets told why.
--
-- GTINs ONLY, and this table holds part numbers too. A concept has no
-- manufacturer, so it has no part number either, but no writer sets one and no
-- reader resolves through one: lookup_barcode() reads gtin rows and nothing
-- else, which is where the whole harm was. Widening this later is a one-word
-- change; guessing wide now would refuse rows nobody has ever written.

-- ─── the strays ──────────────────────────────────────────────────────────────
-- Runs on every reset and every repaired push, and is a no-op once there is
-- nothing left to clear. The products keep everything else the merge gave them.
delete from public.catalog_identifiers ci
using public.catalog_products p
where p.id = ci.product_id
  and p.product_type = 'generic'
  and ci.identifier_type = 'gtin';

-- ─── no identifier may point at a concept ────────────────────────────────────
create or replace function public.catalog_identifiers_not_generic()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.identifier_type = 'gtin' and exists (
    select 1 from public.catalog_products p
    where p.id = new.product_id and p.product_type = 'generic'
  ) then
    raise exception 'A generic product is a concept, so it cannot carry a barcode.'
      using errcode = 'P0001', detail = 'generic_has_no_barcode';
  end if;
  return new;
end;
$$;

drop trigger if exists catalog_identifiers_not_generic on public.catalog_identifiers;
create trigger catalog_identifiers_not_generic
  before insert or update of product_id on public.catalog_identifiers
  for each row execute function public.catalog_identifiers_not_generic();

-- ─── nor may a product turn generic while it holds one ───────────────────────
-- The other half of the same rule, and the half that is easy to forget: without
-- it the invariant is only true of rows that never changed type.
--
-- It refuses rather than deleting the codes, because turning a product into a
-- concept is a judgement and the barcode is the evidence against it. The admin
-- form clears the field as part of the same save, so the two arrive together
-- and the update in 009 applies the barcode before the type, so the code is
-- already gone by the time this fires.
create or replace function public.catalog_products_not_generic_with_identifier()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.product_type = 'generic'
     and exists (
       select 1 from public.catalog_identifiers i
       where i.product_id = new.id and i.identifier_type = 'gtin'
     )
  then
    raise exception 'That product has a barcode, so it cannot become generic. Clear the barcode first.'
      using errcode = 'P0001', detail = 'generic_has_no_barcode';
  end if;
  return new;
end;
$$;

drop trigger if exists catalog_products_not_generic_with_identifier on public.catalog_products;
create trigger catalog_products_not_generic_with_identifier
  before update of product_type on public.catalog_products
  for each row when (new.product_type = 'generic' and old.product_type is distinct from 'generic')
  execute function public.catalog_products_not_generic_with_identifier();

-- ─── provenance ──────────────────────────────────────────────────────────────
-- Where each row came from, kept for as long as the row exists.
--
-- Not bookkeeping. Open Food Facts data is ODbL-licensed, so which rows came
-- from it is a legal fact about this table; and a source that turns out to be
-- wrong has to be revertible without touching the rows it never wrote.
create table if not exists public.catalog_sources (
  id                uuid not null default gen_random_uuid() primary key,
  product_id        uuid not null references public.catalog_products(id) on delete cascade,
  source_name       text not null,
  -- The row's identity in the upstream catalog: an OFF barcode, a seed slug.
  -- What makes a re-import update rather than duplicate.
  source_product_id text,
  source_url        text,
  source_updated_at timestamptz,
  imported_at       timestamptz not null default now()
);

alter table public.catalog_sources
  drop constraint if exists catalog_sources_name_check;
alter table public.catalog_sources
  add constraint catalog_sources_name_check
  check (source_name in (
    'curated', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'user'
  ));

alter table public.catalog_sources
  drop constraint if exists catalog_sources_url_check;
alter table public.catalog_sources
  add constraint catalog_sources_url_check
  check (source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 500));

-- One row per (source, upstream id). Re-running an import updates rather than
-- appends, which is half of what makes §26's idempotency requirement true; the
-- other half is the normalized_name unique index above.
create unique index if not exists catalog_sources_upstream_key
  on public.catalog_sources (source_name, source_product_id)
  where source_product_id is not null;

create index if not exists catalog_sources_product
  on public.catalog_sources (product_id);

-- ─── derived columns ─────────────────────────────────────────────────────────
-- normalized_name and search_blob are computed by the database and by nothing
-- else. A client-supplied matching key becomes EVERYONE's matching key the
-- moment a discovered product is saved, so neither column is writable in
-- practice: the before-trigger overwrites whatever was passed.

-- SECURITY DEFINER, and the reason is the revoke above. catalog_normalize() is
-- executable by nobody but this function's owner, so a trigger running with the
-- caller's rights -- service_role during a seed, the discovery function's role
-- during a save -- dies with "permission denied for function
-- catalog_normalize" on every single insert. Granting EXECUTE to those roles
-- instead would put the merge key back in reach of anything holding a key,
-- which is the thing the revoke exists to prevent. The app project's writers
-- are SECURITY DEFINER for exactly this reason.
create or replace function public.catalog_products_derive()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  new.normalized_name := public.catalog_normalize(new.canonical_name, new.brand);
  new.updated_at := now();
  -- On insert the aliases do not exist yet (they reference this row), so the
  -- blob starts as the name alone and the after-trigger widens it. On update it
  -- is left alone, which is what stops catalog_refresh_search_blob()'s own
  -- UPDATE from being undone by the trigger it fires.
  if tg_op = 'INSERT' then
    new.search_blob := new.normalized_name;
  end if;
  return new;
end;
$$;

drop trigger if exists catalog_products_derive on public.catalog_products;
create trigger catalog_products_derive
  before insert or update on public.catalog_products
  for each row execute function public.catalog_products_derive();

-- Recompute one product's search_blob from its name and every alias it has.
--
-- WHY THIS IS A SEPARATE PASS. The blob spans two tables, and neither one's
-- trigger can see the other at the right moment: a product's before-trigger runs
-- before its aliases exist, and an alias's trigger runs after the product's has
-- finished. So both call this, and this owns the column.
--
-- The `is distinct from` guard is what makes that safe to call from a trigger on
-- catalog_products itself — the UPDATE is a no-op when nothing changed, and it
-- names neither canonical_name nor brand, so the column-scoped after-trigger
-- below does not re-fire on it.
create or replace function public.catalog_refresh_search_blob(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_blob text;
begin
  select btrim(
           p.normalized_name || coalesce(
             ' ' || (
               select string_agg(distinct a.normalized_alias, ' ')
               from public.catalog_aliases a
               where a.product_id = p.id
                 and a.normalized_alias <> ''
             ), ''
           )
         )
    into v_blob
  from public.catalog_products p
  where p.id = p_product_id;

  if v_blob is null then
    return;
  end if;

  -- Bounded rather than rejected. A product accumulating hundreds of aliases is
  -- a real possibility once discovery runs, and failing the write would lose the
  -- product over an alias nobody asked for. Truncation loses reach for the
  -- last-added alias only, and the constraint above still holds.
  v_blob := left(v_blob, 4000);

  update public.catalog_products
     set search_blob = v_blob
   where id = p_product_id
     and search_blob is distinct from v_blob;
end;
$$;

create or replace function public.catalog_products_refresh_blob()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.catalog_refresh_search_blob(new.id);
  return null;
end;
$$;

drop trigger if exists catalog_products_refresh_blob on public.catalog_products;
create trigger catalog_products_refresh_blob
  after insert on public.catalog_products
  for each row execute function public.catalog_products_refresh_blob();

-- Column-scoped, so the blob-only UPDATE above never reaches it.
drop trigger if exists catalog_products_rename_refresh_blob on public.catalog_products;
create trigger catalog_products_rename_refresh_blob
  after update of canonical_name, brand on public.catalog_products
  for each row execute function public.catalog_products_refresh_blob();

create or replace function public.catalog_aliases_derive()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  new.normalized_alias := public.catalog_normalize(new.alias, null);
  return new;
end;
$$;

drop trigger if exists catalog_aliases_derive on public.catalog_aliases;
create trigger catalog_aliases_derive
  before insert or update on public.catalog_aliases
  for each row execute function public.catalog_aliases_derive();

create or replace function public.catalog_aliases_refresh_blob()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.catalog_refresh_search_blob(coalesce(new.product_id, old.product_id));
  return null;
end;
$$;

drop trigger if exists catalog_aliases_refresh_blob on public.catalog_aliases;
create trigger catalog_aliases_refresh_blob
  after insert or update or delete on public.catalog_aliases
  for each row execute function public.catalog_aliases_refresh_blob();

-- ─── who may read this ───────────────────────────────────────────────────────
-- Signed in, and read-only. There is no client write path to any of these tables
-- and there is not meant to be: rows arrive from the seed importer (service
-- role) and from the discovery function (service role, behind the quality gate).
--
-- Two gates, as always. The grants below open the first; RLS decides the rows.
-- Both are needed — a table with RLS on and no policy is invisible, and a policy
-- with no grant fails with "permission denied" before RLS is consulted.

alter table public.catalog_products    enable row level security;
alter table public.catalog_aliases     enable row level security;
alter table public.catalog_identifiers enable row level security;
alter table public.catalog_sources     enable row level security;

drop policy if exists "signed-in users can read the catalog" on public.catalog_products;
create policy "signed-in users can read the catalog"
  on public.catalog_products for select to authenticated using (true);

drop policy if exists "signed-in users can read aliases" on public.catalog_aliases;
create policy "signed-in users can read aliases"
  on public.catalog_aliases for select to authenticated using (true);

drop policy if exists "signed-in users can read identifiers" on public.catalog_identifiers;
create policy "signed-in users can read identifiers"
  on public.catalog_identifiers for select to authenticated using (true);

-- Provenance is admin-only. It is the one table here that says something about
-- how the catalog is built rather than about a product, and the app has no use
-- for it.
drop policy if exists "admins can read provenance" on public.catalog_sources;
create policy "admins can read provenance"
  on public.catalog_sources for select to authenticated using (public.catalog_is_admin());

revoke all on public.catalog_products    from anon, authenticated;
revoke all on public.catalog_aliases     from anon, authenticated;
revoke all on public.catalog_identifiers from anon, authenticated;
revoke all on public.catalog_sources     from anon, authenticated;

grant select on public.catalog_products    to authenticated;
grant select on public.catalog_aliases     to authenticated;
grant select on public.catalog_identifiers to authenticated;
grant select on public.catalog_sources     to authenticated;
