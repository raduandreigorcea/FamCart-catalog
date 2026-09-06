-- ─── the catalog ─────────────────────────────────────────────────────────────
-- Four tables and one folding rule.
--
--   catalog_retailers    the shops we read, and which country each sells in
--   catalog_products     one row per product identity — NO price, NO stock
--   catalog_identifiers  GTINs: the exact keys
--   catalog_listings     one row per (retailer, their id) — price, stock, URL
--
-- THE SPLIT BETWEEN PRODUCT AND LISTING IS THE WHOLE POINT OF THIS SCHEMA.
-- "Coca-Cola Zero 1.5L" is one thing; "Coca-Cola Zero 1.5L, 8.49 lei at Auchan,
-- in stock, seen 20 minutes ago" is another, and there is one of the first and
-- up to one per retailer of the second. Putting a price on the product would
-- mean the last scraper to run decides what everything costs, and a product
-- would go out of stock everywhere because one shop stopped listing it.
--
-- WHAT THIS IS NOT. It is not a catalog of products that exist in the world. A
-- row gets here because a configured retailer listed it, or because a fixture
-- put it here for a test. Nothing infers a product from a category, a concept or
-- a search that found nothing. The previous version of this schema did exactly
-- that, from Open Food Facts, and the result was a catalog full of things you
-- could not walk into a shop and buy.

-- ─── the folding rule ────────────────────────────────────────────────────────
-- The one authority on how two strings are compared.
--
-- Byte-for-byte the same fold as normalizeSearchText() in the app's
-- src/lib/productSearch.ts: strip diacritics, lowercase, collapse whitespace,
-- trim. The app uses NFD + \p{Diacritic}; unaccent is dictionary-based and
-- agrees with it across Latin text, which is all either side ever sees.
--
-- Three copies of one rule, in three runtimes — this database, the browser, and
-- the scraper's TypeScript — and the drift is pinned by test/fixtures/fold.json,
-- which holds what THIS function actually answered for a set of awkward strings.
-- That fixture caught ß→ss, ®→(r) and ½→" 1/2" (with a leading space) last time;
-- none of the three would ever have surfaced as an error.
--
-- search_path includes extensions because unaccent/1 resolves its dictionary by
-- name through it.
create or replace function public.catalog_normalize(p_text text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select btrim(regexp_replace(lower(extensions.unaccent(coalesce(p_text, ''))), '\s+', ' ', 'g'))
$$;

comment on function public.catalog_normalize(text) is
  'The fold: unaccent, lowercase, collapse whitespace, trim. Matches the app''s normalizeSearchText().';

-- ─── quantity, canonicalised ─────────────────────────────────────────────────
-- Part of the merge key, and the reason "Coca Cola Zero 1.5L" and "Coca Cola
-- Zero 500ml" can never be merged however similar their names look.
--
-- Everything reduces to a base unit so 1 kg and 1000 g are the same key, and
-- 0.5 l and 500 ml are the same key. A null quantity is its own value ('-')
-- rather than a wildcard: two products that both fail to state a size fold
-- together only if their NAMES also agree, which is the conservative answer.
-- A number as a key fragment: no trailing zeros, no trailing point, so 1500,
-- 1500.0 and 1500.000 are one value. to_char's FM mask strips the zeros but
-- leaves the point behind, which would make 'ml:1500.' and 'ml:1500' two
-- different products.
create or replace function public.catalog_number_key(p_value numeric)
returns text
language sql
immutable
as $fn$
  select rtrim(rtrim(trim(to_char(p_value, 'FM9999999990.999')), '0'), '.')
$fn$;

create or replace function public.catalog_canonical_quantity(p_quantity numeric, p_unit text)
returns text
language sql
immutable
as $fn$
  select case
    when p_quantity is null or p_unit is null then '-'
    when p_unit = 'kg'  then 'g:'   || public.catalog_number_key(p_quantity * 1000)
    when p_unit = 'g'   then 'g:'   || public.catalog_number_key(p_quantity)
    when p_unit = 'l'   then 'ml:'  || public.catalog_number_key(p_quantity * 1000)
    when p_unit = 'ml'  then 'ml:'  || public.catalog_number_key(p_quantity)
    when p_unit = 'buc' then 'buc:' || public.catalog_number_key(p_quantity)
    else '-'
  end
$fn$;

comment on function public.catalog_canonical_quantity(numeric, text) is
  'Quantity reduced to a base unit (g, ml, buc) as a key fragment; ''-'' when unknown.';

-- ─── the size token, removed from the name ───────────────────────────────────
-- "Lapte Zuzu 1.5 L" and "Lapte Zuzu, 1,5l" have to reach the same key, and the
-- quantity is already carried separately, so leaving it in the name would make
-- the key depend on how a particular shop punctuates a litre.
--
-- ONLY a number immediately followed by a unit word is removed. That is what
-- keeps "3.5%" (a fat content, no unit), "Pepsi 7Up" (no unit) and "Nr 5"
-- intact. Multipacks are removed as a whole ("6 x 0.5 L"), because the parsed
-- quantity already holds their product.
create or replace function public.catalog_strip_quantity(p_name text)
returns text
language sql
immutable
as $fn$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        -- approximation markers first, or the "1 kg" in "+/- 1 kg" is removed
        -- and the "+/-" is left stranded in the middle of the key.
        regexp_replace(coalesce(p_name, ''), '(\+/-|\+-|±|\mcca\M|\maprox\.?\M|\mca\.)', ' ', 'gi'),
        -- optional "N x" multipack prefix, then the amount, then the unit word
        '(\m\d+\s*[xX]\s*)?\d+([.,]\d+)?\s*(kg|kilograme|g|grame|gr|ml|mililitri|cl|l|litri|litru|buc|bucati|bucăți)\M',
        ' ', 'gi'),
      -- punctuation runs the removals leave behind, anywhere in the string
      '\s*[,;·/+-]+\s*(?=[,;·/+-]|$)|^\s*[,;·/+-]+\s*', ' ', 'g'),
    '\s+', ' ', 'g'))
$fn$;

comment on function public.catalog_strip_quantity(text) is
  'The product name with its size token removed, so the quantity is counted once (in the key) rather than twice.';

-- ─── the merge key ───────────────────────────────────────────────────────────
-- THIS IS THE DEDUPE RULE. The unique index on catalog_products.merge_key is
-- what actually enforces it; this function is what computes it.
--
-- brand | name-without-its-size | canonical size
--
-- Joined on '|', which the fold can never emit, so ("Zuzu", "Lapte") and
-- ("", "Zuzu Lapte") stay different products.
--
-- Deliberately NOT granted to any client role. A client that can compute the
-- merge key can craft a name that collides with an existing product, and every
-- writer here is security definer and computes it itself.
-- The fold, PLUS punctuation flattened to spaces.
--
-- catalog_normalize() is pinned to the app's normalizeSearchText() and must stay
-- that way -- the browser computes it to dedupe a dropdown. The merge key is a
-- different job with a different risk: it decides whether two shops are talking
-- about one product, and "Coca-Cola" versus "Coca Cola" is a punctuation
-- accident, not two brands. Nothing outside this database ever computes a merge
-- key, so it is free to be stricter than the fold it starts from.
create or replace function public.catalog_key_fold(p_text text)
returns text
language sql
immutable
set search_path = public, extensions
as $fn$
  select btrim(regexp_replace(
    regexp_replace(public.catalog_normalize(p_text), '[^a-z0-9%]+', ' ', 'g'),
    '\s+', ' ', 'g'))
$fn$;

create or replace function public.catalog_merge_key(
  p_brand    text,
  p_name     text,
  p_quantity numeric default null,
  p_unit     text default null
)
returns text
language sql
immutable
set search_path = public, extensions
as $fn$
  select public.catalog_key_fold(p_brand)
      || '|' || public.catalog_key_fold(public.catalog_strip_quantity(p_name))
      || '|' || public.catalog_canonical_quantity(p_quantity, p_unit)
$fn$;

comment on function public.catalog_merge_key(text, text, numeric, text) is
  'The identity of a product: folded brand, folded name without its size, canonical size.';

revoke all on function public.catalog_normalize(text) from public, anon, authenticated;
revoke all on function public.catalog_canonical_quantity(numeric, text) from public, anon, authenticated;
revoke all on function public.catalog_strip_quantity(text) from public, anon, authenticated;
revoke all on function public.catalog_key_fold(text) from public, anon, authenticated;
revoke all on function public.catalog_number_key(numeric) from public, anon, authenticated;
revoke all on function public.catalog_merge_key(text, text, numeric, text) from public, anon, authenticated;

-- ─── retailers ───────────────────────────────────────────────────────────────
-- One row per shop we read. `country` is the market the app filters on, and it
-- is checked against exactly the eleven codes src/lib/region.ts can derive from
-- a phone's timezone. test/catalog/markets.test.js in the app repo pins the two
-- lists together, because neither repository can see both on its own.
--
-- `enabled` is how a scraper is turned off without deleting its data: the rows
-- stay, they simply stop being refreshed, and search can be told to skip them.
create table if not exists public.catalog_retailers (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  name       text not null,
  country    text not null,
  domain     text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.catalog_retailers is
  'The shops the catalog reads. One row per scraper in catalog/src/retailers/.';

-- Restated below the table rather than declared inside it: a constraint written
-- inside `create table if not exists` is skipped entirely on a database that
-- already has the table, so a changed bound would reach new databases only.
alter table public.catalog_retailers drop constraint if exists catalog_retailers_slug_key;
alter table public.catalog_retailers add constraint catalog_retailers_slug_key unique (slug);

alter table public.catalog_retailers drop constraint if exists catalog_retailers_slug_check;
alter table public.catalog_retailers add constraint catalog_retailers_slug_check
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 40);

alter table public.catalog_retailers drop constraint if exists catalog_retailers_country_check;
alter table public.catalog_retailers add constraint catalog_retailers_country_check
  check (country in ('RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE'));

alter table public.catalog_retailers drop constraint if exists catalog_retailers_name_check;
alter table public.catalog_retailers add constraint catalog_retailers_name_check
  check (char_length(btrim(name)) between 1 and 60);

alter table public.catalog_retailers drop constraint if exists catalog_retailers_domain_check;
alter table public.catalog_retailers add constraint catalog_retailers_domain_check
  check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$');

-- ─── products ────────────────────────────────────────────────────────────────
-- Identity, and nothing that changes by the hour.
--
-- add_count is EARNED: it is incremented only by bump_product_popularity(), when
-- a real person adds this product to a real list. No import may write it, which
-- is why it is a plain column that the importer's SQL never names — a re-import
-- that reset it would throw away the only signal here that came from a human.
--
-- listing_count is maintained by a trigger on catalog_listings rather than by
-- the importer, so it cannot drift when an import fails halfway.
--
-- popularity is generated from both: a product three retailers all stock ranks
-- above one only Lidl carries, before anybody has ever added either.
create table if not exists public.catalog_products (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  brand          text,
  quantity       numeric,
  quantity_unit  text,
  category       text,
  image_url      text,
  merge_key      text not null default '',
  search_blob    text not null default '',
  add_count      integer not null default 0,
  listing_count  integer not null default 0,
  popularity     integer generated always as (add_count + listing_count * 5) stored,
  first_seen_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.catalog_products is
  'One row per product identity. Never holds a price or a stock state — those belong to catalog_listings.';
comment on column public.catalog_products.add_count is
  'Earned by bump_product_popularity() only. No import ever writes this.';
comment on column public.catalog_products.merge_key is
  'catalog_merge_key(brand, canonical_name, quantity, quantity_unit). The unique index on it IS the dedupe rule.';

alter table public.catalog_products drop constraint if exists catalog_products_name_check;
alter table public.catalog_products add constraint catalog_products_name_check
  check (char_length(btrim(canonical_name)) between 1 and 200);

alter table public.catalog_products drop constraint if exists catalog_products_brand_check;
alter table public.catalog_products add constraint catalog_products_brand_check
  check (brand is null or char_length(btrim(brand)) between 1 and 80);

alter table public.catalog_products drop constraint if exists catalog_products_quantity_check;
alter table public.catalog_products add constraint catalog_products_quantity_check
  check (
    (quantity is null and quantity_unit is null)
    or (quantity is not null and quantity_unit is not null
        and quantity > 0 and quantity <= 1000000
        and quantity_unit in ('g', 'kg', 'ml', 'l', 'buc'))
  );

alter table public.catalog_products drop constraint if exists catalog_products_category_check;
alter table public.catalog_products add constraint catalog_products_category_check
  check (category is null or category in (
    'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen', 'snacks',
    'drinks', 'alcohol', 'baby', 'household', 'personal-care', 'health', 'pet',
    'home', 'other'
  ));

alter table public.catalog_products drop constraint if exists catalog_products_image_url_check;
alter table public.catalog_products add constraint catalog_products_image_url_check
  check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 500));

alter table public.catalog_products drop constraint if exists catalog_products_counts_check;
alter table public.catalog_products add constraint catalog_products_counts_check
  check (add_count >= 0 and listing_count >= 0);

alter table public.catalog_products drop constraint if exists catalog_products_derived_check;
alter table public.catalog_products add constraint catalog_products_derived_check
  check (char_length(merge_key) <= 500 and char_length(search_blob) <= 1000);

create unique index if not exists catalog_products_merge_key_idx on public.catalog_products (merge_key);
create index if not exists catalog_products_search_blob_trgm
  on public.catalog_products using gin (search_blob extensions.gin_trgm_ops);
create index if not exists catalog_products_popularity on public.catalog_products (popularity desc);

-- ─── identifiers ─────────────────────────────────────────────────────────────
-- GTINs, and the reason a barcode scan is an exact answer rather than a guess.
--
-- Unique GLOBALLY on (type, value), not per product: a GTIN identifies one
-- article in the world, so two products claiming the same code is a data error
-- worth refusing rather than a merge worth performing. The importer reports the
-- conflict and keeps both products; it never merges them on the strength of it.
create table if not exists public.catalog_identifiers (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references public.catalog_products(id) on delete cascade,
  identifier_type  text not null default 'gtin',
  identifier_value text not null,
  source           text not null,
  created_at       timestamptz not null default now()
);

comment on table public.catalog_identifiers is
  'GTINs, unique across the whole catalog. The exact key lookup_barcode() resolves through.';

alter table public.catalog_identifiers drop constraint if exists catalog_identifiers_type_check;
alter table public.catalog_identifiers add constraint catalog_identifiers_type_check
  check (identifier_type in ('gtin', 'mpn'));

alter table public.catalog_identifiers drop constraint if exists catalog_identifiers_value_check;
alter table public.catalog_identifiers add constraint catalog_identifiers_value_check
  check (
    (identifier_type = 'gtin' and identifier_value ~ '^[0-9]{8,14}$')
    or (identifier_type = 'mpn' and char_length(btrim(identifier_value)) between 1 and 60)
  );

create unique index if not exists catalog_identifiers_value_key
  on public.catalog_identifiers (identifier_type, identifier_value);
create index if not exists catalog_identifiers_product
  on public.catalog_identifiers (product_id);

-- ─── listings ────────────────────────────────────────────────────────────────
-- What a particular shop currently says about a particular product: what they
-- call it, what it costs, whether it is on the shelf, and when we last saw it.
--
-- (retailer_id, external_id) is unique and is the retailer's OWN id for the
-- thing. It identifies a LISTING, never a product across retailers — Auchan's
-- 199749 and Carrefour's 15513004 mean nothing to each other.
--
-- last_seen_at is the whole availability mechanism. A scrape stamps every row it
-- touched with the run's start time; anything older than that was not in the
-- run. It is NEVER deleted on that basis — "gone from the shelf" and "gone from
-- the catalog" are different facts and a shopping list wants to keep telling you
-- the product exists.
--
-- previous_price/last_price_at are a change signal, not a price history. A real
-- history is a table per observation and a retention policy, and nothing in the
-- app asks for one yet; adding it later costs a migration, and adding it now
-- would cost a row per product per run forever.
create table if not exists public.catalog_listings (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.catalog_products(id) on delete cascade,
  retailer_id       uuid not null references public.catalog_retailers(id) on delete cascade,
  external_id       text not null,
  retailer_name     text not null,
  retailer_brand    text,
  retailer_category text,
  price             numeric(12, 2),
  currency          text,
  available         boolean not null default true,
  product_url       text not null,
  image_url         text,
  previous_price    numeric(12, 2),
  last_price_at     timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.catalog_listings is
  'One row per (retailer, their product id). Price and availability live here and nowhere else.';
comment on column public.catalog_listings.last_seen_at is
  'Stamped with the scrape run''s started_at. Older than the last completed run means the retailer stopped listing it.';

alter table public.catalog_listings drop constraint if exists catalog_listings_retailer_external_key;
alter table public.catalog_listings add constraint catalog_listings_retailer_external_key
  unique (retailer_id, external_id);

alter table public.catalog_listings drop constraint if exists catalog_listings_external_id_check;
alter table public.catalog_listings add constraint catalog_listings_external_id_check
  check (char_length(btrim(external_id)) between 1 and 100);

alter table public.catalog_listings drop constraint if exists catalog_listings_name_check;
alter table public.catalog_listings add constraint catalog_listings_name_check
  check (char_length(btrim(retailer_name)) between 1 and 300);

alter table public.catalog_listings drop constraint if exists catalog_listings_price_check;
alter table public.catalog_listings add constraint catalog_listings_price_check
  check (price is null or (price >= 0 and price <= 1000000));

alter table public.catalog_listings drop constraint if exists catalog_listings_currency_check;
alter table public.catalog_listings add constraint catalog_listings_currency_check
  check (currency is null or currency ~ '^[A-Z]{3}$');

-- A price with no currency is a number nobody can spend.
alter table public.catalog_listings drop constraint if exists catalog_listings_price_currency_check;
alter table public.catalog_listings add constraint catalog_listings_price_currency_check
  check (price is null or currency is not null);

alter table public.catalog_listings drop constraint if exists catalog_listings_url_check;
alter table public.catalog_listings add constraint catalog_listings_url_check
  check (product_url ~ '^https://' and char_length(product_url) <= 1000);

alter table public.catalog_listings drop constraint if exists catalog_listings_image_check;
alter table public.catalog_listings add constraint catalog_listings_image_check
  check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 1000));

create index if not exists catalog_listings_product on public.catalog_listings (product_id);
-- The sweep's index: "everything this retailer has not been seen with since X".
create index if not exists catalog_listings_retailer_seen
  on public.catalog_listings (retailer_id, last_seen_at);
create index if not exists catalog_listings_available
  on public.catalog_listings (product_id) where available;

-- ─── derived columns ─────────────────────────────────────────────────────────
-- merge_key is computed here rather than by whatever wrote the row, so there is
-- exactly one place that decides what a product's identity is. An importer that
-- computed it itself would be a second authority, and the two would drift on the
-- first refactor.
create or replace function public.catalog_products_derive()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $fn$
begin
  new.canonical_name := btrim(new.canonical_name);
  new.brand := nullif(btrim(coalesce(new.brand, '')), '');
  new.merge_key := public.catalog_merge_key(new.brand, new.canonical_name, new.quantity, new.quantity_unit);
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists catalog_products_derive on public.catalog_products;
create trigger catalog_products_derive
  before insert or update on public.catalog_products
  for each row execute function public.catalog_products_derive();

-- ─── what text finds a product ───────────────────────────────────────────────
-- The product's own name and brand, PLUS every distinct name its retailers use
-- for it.
--
-- That last part is why this is a separate function driven by listings rather
-- than a column derived from the product alone. Two shops rarely write a product
-- the same way -- Carrefour says "Lapte UHT pentru cafea Zuzu Barista 3.5% 1L",
-- Auchan might say "Lapte Zuzu Barista UHT 3.5%, 1 l" -- and when a GTIN merges
-- those into one product, the losing spelling would otherwise become unfindable.
-- Somebody searching the words they read on the Carrefour shelf must still get
-- the row. This is the alias table the old schema had, except every entry in it
-- was earned by a shop actually using the words.
--
-- Truncated to fit the length bound rather than allowed to fail the check: a
-- product listed by many retailers must not become unwritable.
create or replace function public.catalog_refresh_search_blob(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_blob text;
begin
  select left(regexp_replace(btrim(
           public.catalog_normalize(p.canonical_name)
           || ' ' || public.catalog_normalize(coalesce(p.brand, ''))
           || ' ' || coalesce((
                select string_agg(distinct public.catalog_normalize(l.retailer_name), ' ')
                from public.catalog_listings l
                where l.product_id = p.id
              ), '')
         ), '\s+', ' ', 'g'), 1000)
    into v_blob
    from public.catalog_products p
   where p.id = p_product_id;

  if v_blob is not null then
    update public.catalog_products
       set search_blob = v_blob
     where id = p_product_id
       and search_blob is distinct from v_blob;
  end if;
end;
$fn$;

create or replace function public.catalog_products_refresh_blob()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.catalog_refresh_search_blob(new.id);
  return null;
end;
$fn$;

drop trigger if exists catalog_products_blob_insert on public.catalog_products;
create trigger catalog_products_blob_insert
  after insert on public.catalog_products
  for each row execute function public.catalog_products_refresh_blob();

drop trigger if exists catalog_products_blob_rename on public.catalog_products;
create trigger catalog_products_blob_rename
  after update of canonical_name, brand on public.catalog_products
  for each row execute function public.catalog_products_refresh_blob();

-- ─── listing_count, and the blob that follows a listing ──────────────────────
-- Maintained by a trigger, not by the importer. An import that fails halfway
-- must not leave a product claiming four retailers stock it; the count follows
-- the rows that actually exist, whatever wrote them.
create or replace function public.catalog_listings_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ids uuid[];
  v_id  uuid;
begin
  v_ids := array_remove(array[
    case when tg_op <> 'INSERT' then old.product_id else null end,
    case when tg_op <> 'DELETE' then new.product_id else null end
  ], null);

  foreach v_id in array v_ids loop
    update public.catalog_products p
       set listing_count = (select count(*) from public.catalog_listings l where l.product_id = p.id)
     where p.id = v_id;
    perform public.catalog_refresh_search_blob(v_id);
  end loop;
  return null;
end;
$fn$;

drop trigger if exists catalog_listings_after_change on public.catalog_listings;
create trigger catalog_listings_after_change
  after insert or delete or update of product_id, retailer_name on public.catalog_listings
  for each row execute function public.catalog_listings_after_change();

create or replace function public.catalog_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists catalog_listings_touch on public.catalog_listings;
create trigger catalog_listings_touch
  before insert or update on public.catalog_listings
  for each row execute function public.catalog_touch_updated_at();

drop trigger if exists catalog_retailers_touch on public.catalog_retailers;
create trigger catalog_retailers_touch
  before insert or update on public.catalog_retailers
  for each row execute function public.catalog_touch_updated_at();

-- ─── who may read what ───────────────────────────────────────────────────────
-- Signed-in users read the catalog. NOBODY writes it from a client: every write
-- path in this schema is a security definer function granted to service_role
-- alone, so there is no table-level insert or update to fall back on even for an
-- admin.
alter table public.catalog_retailers   enable row level security;
alter table public.catalog_products    enable row level security;
alter table public.catalog_identifiers enable row level security;
alter table public.catalog_listings    enable row level security;

drop policy if exists "signed-in users can read retailers" on public.catalog_retailers;
create policy "signed-in users can read retailers"
  on public.catalog_retailers for select to authenticated using (true);

drop policy if exists "signed-in users can read products" on public.catalog_products;
create policy "signed-in users can read products"
  on public.catalog_products for select to authenticated using (true);

drop policy if exists "signed-in users can read identifiers" on public.catalog_identifiers;
create policy "signed-in users can read identifiers"
  on public.catalog_identifiers for select to authenticated using (true);

drop policy if exists "signed-in users can read listings" on public.catalog_listings;
create policy "signed-in users can read listings"
  on public.catalog_listings for select to authenticated using (true);

revoke all on public.catalog_retailers   from anon, authenticated;
revoke all on public.catalog_products    from anon, authenticated;
revoke all on public.catalog_identifiers from anon, authenticated;
revoke all on public.catalog_listings    from anon, authenticated;

grant select on public.catalog_retailers   to authenticated;
grant select on public.catalog_products    to authenticated;
grant select on public.catalog_identifiers to authenticated;
grant select on public.catalog_listings    to authenticated;

-- ─── the retailers themselves ────────────────────────────────────────────────
-- Data, in a migration, on purpose: a scraper with no retailer row cannot import
-- anything, and a fresh database that needed a separate seed step to be usable
-- would be a database somebody forgets to seed. Three rows, matching
-- catalog/src/core/registry.ts, which the app's test/catalog/markets.test.js
-- pins against src/lib/region.ts.
--
-- Kaufland and Mega Image are deliberately ABSENT rather than present-and-
-- disabled: neither has a scraper, and a row here is a claim that data can
-- arrive. docs/retailers.md records what was probed and why.
insert into public.catalog_retailers (slug, name, country, domain) values
  ('auchan',    'Auchan',    'RO', 'auchan.ro'),
  ('carrefour', 'Carrefour', 'RO', 'carrefour.ro'),
  ('lidl',      'Lidl',      'RO', 'lidl.ro')
on conflict (slug) do update
  set name = excluded.name, country = excluded.country, domain = excluded.domain;
