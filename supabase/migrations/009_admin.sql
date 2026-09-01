-- An admin surface for the reference catalog.
--
-- WHY RPCs RATHER THAN TABLE ACCESS
--
-- 002 ends with `revoke all on public.catalog_products from anon, authenticated`.
-- The SELECT policy above it is therefore unreachable on its own: a signed-in
-- token has a policy that would allow the read and no grant to perform it. Every
-- way into this table is a `security definer` function, and that is the design
-- rather than an oversight -- catalog_import_products() is the only writer and it
-- belongs to service_role alone.
--
-- A dashboard cannot hold a service-role key. So the choice is between shipping
-- one to a browser and adding functions here, and it is not a close call.
--
-- WHY ADMIN-AUTHORED ROWS ARE NOT 'curated'
--
-- This is the trap this file exists to avoid, and it is silent.
--
-- catalog_prune_curated() in 006 deletes every product whose only provenance is
-- `curated` and whose source_product_id is absent from the keep-list it is
-- handed -- which is built from the version-controlled seed. That is correct and
-- deliberate: it is what makes seed/ a real authority instead of half of one,
-- where adding an entry created a row and removing one left it behind forever.
--
-- A product added from the dashboard as 'curated' would have no entry in that
-- file, so the next `npm run catalog:seed -- --prune` would delete it without
-- anybody having asked. The row would simply be gone, and the run would report
-- it as an ordinary prune.
--
-- So these rows record source_name 'admin'. Prune joins on source_name =
-- 'curated' and never sees them. Two writers, two provenances, no overlap, and
-- provenance was already a first-class fact here because Open Food Facts is
-- ODbL and "where did this row come from" is a licensing question.
--
-- WHAT IS DERIVED AND MUST NOT BE PASSED IN
--
-- normalized_name and search_blob are set by the catalog_products_derive and
-- catalog_products_refresh_blob triggers on insert and on a rename. Nothing here
-- writes them; that is the whole reason those are triggers.
--
-- add_count is never writable, for the reason it is not writable in the app
-- database either: it is earned usage, half of the generated popularity column,
-- and bump_product_popularity() is the only thing entitled to move it.

-- ─── 'admin' becomes a provenance ────────────────────────────────────────────
-- catalog_sources.source_name is an allowlist, and it did not include this one.
-- Restated as an explicit drop-and-add rather than edited into 002, which is a
-- restatement already recorded as applied: a changed CHECK inside a
-- `create table if not exists` block reaches new databases only.
--
-- 'user' was the closest existing value and is the wrong one. It means a row a
-- household's own contribution corroborated; this means a row a person with
-- access to the dashboard wrote by hand. Provenance is a licensing fact here,
-- and collapsing two different origins into one value is exactly the kind of
-- thing that becomes unanswerable later.
alter table public.catalog_sources
  drop constraint if exists catalog_sources_name_check;
alter table public.catalog_sources
  add constraint catalog_sources_name_check
  check (source_name in (
    'curated', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'user', 'admin'
  ));

-- ─── reading, for a dashboard ────────────────────────────────────────────────
-- search_catalog() is not usable for this. It is the keystroke path: it ranks by
-- relevance, demotes by market and language, caps hard, and deliberately never
-- returns an empty list. An admin browsing the catalog wants the opposite -- a
-- stable order, an honest total, and the rows that match and only those.
create or replace function public.catalog_admin_products(
  p_query  text    default null,
  p_type   text    default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id             uuid,
  product_type   text,
  canonical_name text,
  name_lang      text,
  brand          text,
  category       text,
  markets        text[],
  quality_tier   text,
  base_weight    integer,
  add_count      integer,
  popularity     integer,
  source_count   integer,
  sources        text[],
  barcodes       text[],
  alias_count    bigint,
  created_at     timestamptz,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_query text    := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  if p_type is not null and p_type not in ('generic', 'commercial') then
    raise exception 'catalog_admin_products: p_type must be generic or commercial, got %', p_type
      using errcode = 'P0001';
  end if;

  return query
  with matched as (
    select p.*
    from public.catalog_products p
    where (p_type is null or p.product_type = p_type)
      -- search_blob is what the keystroke path matches on, so an admin looking
      -- for a product finds it by the same words a shopper would -- including
      -- its aliases, which is the point of the blob.
      and (
        v_query is null
        or p.search_blob like '%' || public.catalog_normalize(v_query) || '%'
        or exists (
          select 1 from public.catalog_identifiers i
          where i.product_id = p.id and i.identifier_value = v_query
        )
      )
  ),
  counted as (select count(*) as n from matched)
  select
    m.id,
    m.product_type,
    m.canonical_name,
    m.name_lang,
    m.brand,
    m.category,
    m.markets,
    m.quality_tier,
    m.base_weight,
    m.add_count,
    m.popularity,
    m.source_count,
    coalesce(
      (select array_agg(distinct s.source_name order by s.source_name)
       from public.catalog_sources s where s.product_id = m.id),
      '{}'::text[]
    ) as sources,
    coalesce(
      (select array_agg(i.identifier_value order by i.identifier_value)
       from public.catalog_identifiers i where i.product_id = m.id),
      '{}'::text[]
    ) as barcodes,
    (select count(*) from public.catalog_aliases a where a.product_id = m.id) as alias_count,
    m.created_at,
    counted.n
  from matched m, counted
  -- Stable and predictable, not relevance. An admin paging through a list needs
  -- page 2 to hold what page 2 held a moment ago.
  order by m.popularity desc, m.canonical_name asc, m.id asc
  limit v_limit
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.catalog_admin_products(text, text, integer, integer) is
  'Browse the reference catalog. Admin only. Stable ordering and an honest '
  'total, unlike search_catalog() which ranks for a keystroke.';

revoke all on function public.catalog_admin_products(text, text, integer, integer)
  from public, anon;
grant execute on function public.catalog_admin_products(text, text, integer, integer)
  to authenticated;

-- ─── create ──────────────────────────────────────────────────────────────────
create or replace function public.catalog_admin_create_product(
  p_name         text,
  p_type         text default 'generic',
  p_lang         text default 'en',
  p_brand        text default null,
  p_category     text default null,
  p_markets      text[] default '{}',
  p_barcode      text default null,
  p_base_weight  integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_brand   text := nullif(btrim(coalesce(p_brand, '')), '');
  v_barcode text := nullif(btrim(coalesce(p_barcode, '')), '');
  v_norm    text;
  v_id      uuid;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if coalesce(p_type, '') not in ('generic', 'commercial') then
    raise exception 'A product is either generic or commercial.'
      using errcode = 'P0001', detail = 'bad_type';
  end if;

  -- The six the app can render. A name in a seventh is unreadable to every user
  -- of this app, which is what name_lang exists to prevent.
  if coalesce(p_lang, '') not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'The name language must be one of en, de, es, ro, fr, it.'
      using errcode = 'P0001', detail = 'bad_lang';
  end if;

  if not (coalesce(p_markets, '{}') <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]) then
    raise exception 'One of those markets is not a market this catalog can hold.'
      using errcode = 'P0001', detail = 'bad_markets';
  end if;

  v_norm := public.catalog_normalize(v_name || case when v_brand is null then '' else ' ' || v_brand end);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  -- normalized_name is unique, and that index IS the dedupe rule for the whole
  -- catalog. Checked here so the message names the situation rather than the
  -- index.
  if exists (select 1 from public.catalog_products where normalized_name = v_norm) then
    raise exception 'The catalog already holds a product that normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  -- The unique index is on (identifier_type, identifier_value), and a scan
  -- resolves through it and nowhere else, so a collision here is the difference
  -- between two products and one unscannable one.
  if v_barcode is not null and exists (
    select 1 from public.catalog_identifiers
    where identifier_type = 'gtin' and identifier_value = v_barcode
  ) then
    raise exception 'Another product already claims that barcode.'
      using errcode = 'P0001', detail = 'duplicate_barcode';
  end if;

  insert into public.catalog_products
    (product_type, canonical_name, name_lang, brand, category, markets,
     base_weight, add_count, source_count)
  values
    (p_type, v_name, p_lang, v_brand, p_category, coalesce(p_markets, '{}'),
     greatest(coalesce(p_base_weight, 0), 0), 0, 1)
  returning id into v_id;

  -- 'admin', never 'curated'. See the header: prune would take a curated row
  -- that the seed file does not name, and it would take it silently.
  insert into public.catalog_sources (product_id, source_name, source_product_id)
  values (v_id, 'admin', v_id::text);

  if v_barcode is not null then
    -- The check constraint wants 8 to 14 digits for a gtin, so a malformed code
    -- is refused with a sentence rather than as a constraint violation.
    if v_barcode !~ '^[0-9]{8,14}$' then
      raise exception 'A barcode must be 8 to 14 digits.'
        using errcode = 'P0001', detail = 'bad_barcode';
    end if;

    insert into public.catalog_identifiers
      (product_id, identifier_type, identifier_value, source)
    values (v_id, 'gtin', v_barcode, 'admin');
  end if;

  return v_id;
end;
$$;

comment on function public.catalog_admin_create_product(text, text, text, text, text, text[], text, integer) is
  'Add a product to the reference catalog. Admin only. Recorded with source '
  'admin rather than curated, so catalog_prune_curated() never removes it.';

revoke all on function public.catalog_admin_create_product(text, text, text, text, text, text[], text, integer)
  from public, anon;
grant execute on function public.catalog_admin_create_product(text, text, text, text, text, text[], text, integer)
  to authenticated;

-- ─── update ──────────────────────────────────────────────────────────────────
create or replace function public.catalog_admin_update_product(
  p_id          uuid,
  p_name        text,
  p_type        text,
  p_lang        text,
  p_brand       text default null,
  p_category    text default null,
  p_markets     text[] default null,
  p_base_weight integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_brand text := nullif(btrim(coalesce(p_brand, '')), '');
  v_norm  text;
  v_row   public.catalog_products%rowtype;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.catalog_products where id = p_id;
  if not found then
    raise exception 'That product no longer exists.'
      using errcode = 'P0001', detail = 'not_found';
  end if;

  if v_name = '' or char_length(v_name) > 120 then
    raise exception 'A product name is required and must be at most 120 characters.'
      using errcode = 'P0001', detail = 'bad_name';
  end if;

  if coalesce(p_type, '') not in ('generic', 'commercial') then
    raise exception 'A product is either generic or commercial.'
      using errcode = 'P0001', detail = 'bad_type';
  end if;

  if coalesce(p_lang, '') not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'The name language must be one of en, de, es, ro, fr, it.'
      using errcode = 'P0001', detail = 'bad_lang';
  end if;

  if p_markets is not null and not (p_markets <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]) then
    raise exception 'One of those markets is not a market this catalog can hold.'
      using errcode = 'P0001', detail = 'bad_markets';
  end if;

  v_norm := public.catalog_normalize(v_name || case when v_brand is null then '' else ' ' || v_brand end);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  -- Excluding this row, or renaming a product to a different spelling of its own
  -- name would report the product as its own duplicate.
  if exists (
    select 1 from public.catalog_products
    where normalized_name = v_norm and id <> p_id
  ) then
    raise exception 'Another product already normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  -- add_count, source_count and normalized_name are all left alone: the first is
  -- earned, the second is a count of corroborating sources rather than an
  -- opinion, and the third is derived by the trigger from what is written below.
  update public.catalog_products
  set canonical_name = v_name,
      product_type   = p_type,
      name_lang      = p_lang,
      brand          = v_brand,
      category       = p_category,
      markets        = coalesce(p_markets, markets),
      base_weight    = greatest(coalesce(p_base_weight, base_weight), 0)
  where id = p_id;
end;
$$;

comment on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer) is
  'Correct a reference product. Admin only. Leaves add_count, source_count and '
  'the derived columns alone.';

revoke all on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer)
  from public, anon;
grant execute on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer)
  to authenticated;

-- ─── delete ──────────────────────────────────────────────────────────────────
-- Heavier than the app database's equivalent and worth pausing over. This
-- catalog is shared LIVE by production and development at once, so a delete here
-- takes the product away from every household of both, immediately. Its aliases,
-- identifiers and provenance go with it: all three tables are
-- `on delete cascade`, which is right -- an alias for a product that no longer
-- exists is a search hit leading nowhere.
--
-- Still a hard delete rather than a soft one. Nothing outside this project
-- references these rows: the app stores what a household typed, as text, and
-- resolves suggestions by querying rather than by holding an id.
create or replace function public.catalog_admin_delete_product(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.catalog_products%rowtype;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select * into v_row from public.catalog_products where id = p_id;

  -- Idempotent: a second click, or two admins on one row, is not an error worth
  -- showing anybody.
  if not found then
    return;
  end if;

  delete from public.catalog_products where id = p_id;
end;
$$;

comment on function public.catalog_admin_delete_product(uuid) is
  'Remove a product from the reference catalog. Admin only, idempotent. '
  'Cascades to its aliases, identifiers and provenance, and takes effect for '
  'production and development at once because they share this project.';

revoke all on function public.catalog_admin_delete_product(uuid) from public, anon;
grant execute on function public.catalog_admin_delete_product(uuid) to authenticated;
