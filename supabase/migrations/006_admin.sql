-- ─── the admin surface ───────────────────────────────────────────────────────
-- Everything the dashboard at raduandreigorcea/FamCart-admin can do to this
-- project. EVERYTHING HERE IS AN RPC and that is not a style choice: 002 revokes
-- all table privileges from `authenticated`, so there is no table access to fall
-- back on even for an admin, and these functions are the entire surface.
--
-- The filter vocabulary changed with the schema and there was no honest way to
-- keep it. p_type, p_lang, p_tier and p_source described a catalog of curated
-- concepts imported from Open Food Facts; there are no concepts, no per-language
-- names, no quality tiers and no external sources any more. What a product HAS
-- now is retailers, listings, prices and a stock state, so that is what you can
-- filter on. admin/src/lib/data/catalog.ts moves with it.

-- ─── browse ──────────────────────────────────────────────────────────────────
-- catalog_admin_products LIVES IN 013, ALONE, with its comment and its grants.
-- It was defined here first, and its body folded every product's listings
-- before paging 25 of them -- 5.7 seconds on the real catalog, and a statement
-- timeout on the dashboard. 013 pages first and folds only the page.
--
-- The definition did not stay here as well, for the reason migrations.test.ts
-- gives: two files restating one function is a race whose winner is whichever
-- was pushed last, and the loss is silent.

-- ─── create ──────────────────────────────────────────────────────────────────
-- A product created here has NO listing, which means no retailer sells it. That
-- is a legitimate thing to want -- correcting a name before a scrape catches up,
-- or holding a product the scrapers cannot see -- and the dashboard shows it as
-- such. It also means it will never be swept, because a sweep only touches
-- listings.
create or replace function public.catalog_admin_create_product(
  p_name          text,
  p_brand         text    default null,
  p_category      text    default null,
  p_quantity      numeric default null,
  p_quantity_unit text    default null,
  p_barcode       text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_id  uuid;
  v_key text;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) < 1 or char_length(p_name) > 200 then
    raise exception 'name must be 1-200 characters' using errcode = 'P0001', detail = 'bad_name';
  end if;
  if p_barcode is not null and p_barcode !~ '^[0-9]{8,14}$' then
    raise exception 'barcode must be 8-14 digits' using errcode = 'P0001', detail = 'bad_barcode';
  end if;

  v_key := public.catalog_merge_key(p_brand, p_name, p_quantity, p_quantity_unit);
  if exists (select 1 from public.catalog_products where merge_key = v_key) then
    raise exception 'a product with this identity already exists'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;
  if p_barcode is not null and exists (
    select 1 from public.catalog_identifiers where identifier_type = 'gtin' and identifier_value = p_barcode
  ) then
    raise exception 'that barcode belongs to another product'
      using errcode = 'P0001', detail = 'duplicate_barcode';
  end if;

  insert into public.catalog_products
    (canonical_name, brand, category, quantity, quantity_unit)
  values (p_name, nullif(btrim(coalesce(p_brand, '')), ''), p_category, p_quantity, p_quantity_unit)
  returning id into v_id;

  if p_barcode is not null then
    insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
    values (v_id, 'gtin', p_barcode, 'admin');
  end if;

  return v_id;
end;
$fn$;

comment on function public.catalog_admin_create_product(text, text, text, numeric, text, text) is
  'Create a product by hand. It has no listing until a retailer is seen carrying it.';

-- ─── update ──────────────────────────────────────────────────────────────────
-- ONE CONVENTION: null leaves a column alone, '' clears it, anything else sets
-- it. The dashboard submits every field of its form on every save, so without
-- that distinction correcting a name would clear the size -- which
-- is a bug the previous version of this function actually shipped.
create or replace function public.catalog_admin_update_product(
  p_id            uuid,
  p_name          text    default null,
  p_brand         text    default null,
  p_category      text    default null,
  p_quantity      numeric default null,
  p_quantity_unit text    default null,
  p_barcode       text    default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_before public.catalog_products%rowtype;
  v_name   text;
  v_key    text;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select * into v_before from public.catalog_products where id = p_id;
  if not found then
    raise exception 'no such product' using errcode = 'P0001', detail = 'not_found';
  end if;

  v_name := case when p_name is null then v_before.canonical_name else btrim(p_name) end;
  if char_length(v_name) < 1 or char_length(v_name) > 200 then
    raise exception 'name must be 1-200 characters' using errcode = 'P0001', detail = 'bad_name';
  end if;

  v_key := public.catalog_merge_key(
    case when p_brand is null then v_before.brand else nullif(btrim(p_brand), '') end,
    v_name,
    case when p_quantity is null then v_before.quantity else p_quantity end,
    case when p_quantity_unit is null then v_before.quantity_unit else nullif(btrim(p_quantity_unit), '') end
  );
  if exists (select 1 from public.catalog_products where merge_key = v_key and id <> p_id) then
    raise exception 'another product already has this identity'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  update public.catalog_products
     set canonical_name = v_name,
         brand          = case when p_brand is null then brand
                               else nullif(btrim(p_brand), '') end,
         category       = case when p_category is null then category
                               when btrim(p_category) = '' then null
                               else p_category end,
         quantity       = case when p_quantity is null then quantity else p_quantity end,
         quantity_unit  = case when p_quantity_unit is null then quantity_unit
                               else nullif(btrim(p_quantity_unit), '') end
   where id = p_id;

  if p_barcode is not null then
    delete from public.catalog_identifiers
     where product_id = p_id and identifier_type = 'gtin' and source = 'admin';
    if btrim(p_barcode) <> '' then
      if p_barcode !~ '^[0-9]{8,14}$' then
        raise exception 'barcode must be 8-14 digits' using errcode = 'P0001', detail = 'bad_barcode';
      end if;
      insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
      values (p_id, 'gtin', p_barcode, 'admin')
      on conflict (identifier_type, identifier_value) do nothing;
    end if;
  end if;
end;
$fn$;

comment on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text) is
  'Correct a product. null leaves a column alone, '''' clears it, anything else sets it.';

-- ─── delete ──────────────────────────────────────────────────────────────────
-- Heavier than it looks: the product, its barcodes and every retailer's listing
-- of it go together, for both projects that read this catalog, immediately. The
-- next scrape will simply put it back, which is usually the right answer to
-- "this row is wrong" and is worth saying out loud in the dialog that asks.
create or replace function public.catalog_admin_delete_product(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  delete from public.catalog_products where id = p_id;
end;
$fn$;

comment on function public.catalog_admin_delete_product(uuid) is
  'Delete a product and everything hanging off it. The next scrape may recreate it.';

-- ─── health ──────────────────────────────────────────────────────────────────
-- catalog_stats is NOT defined here any more. It moved to 020_stats_cache.sql,
-- which counts into a cache on a schedule instead of on every call (the old
-- body timed out under a running scrape). Do not restate it in this file:
-- re-pushing 006 would put the counting body back. test/migrations.test.ts
-- refuses a function defined in two files.

revoke all on function public.catalog_admin_create_product(text, text, text, numeric, text, text) from public, anon;
revoke all on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text) from public, anon;
revoke all on function public.catalog_admin_delete_product(uuid) from public, anon;

grant execute on function public.catalog_admin_create_product(text, text, text, numeric, text, text) to authenticated;
grant execute on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text) to authenticated;
grant execute on function public.catalog_admin_delete_product(uuid) to authenticated;
