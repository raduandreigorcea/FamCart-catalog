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
create or replace function public.catalog_admin_products(
  p_query        text        default null,
  p_retailer     text        default null,
  p_category     text        default null,
  p_has_barcode  boolean     default null,
  p_has_brand    boolean     default null,
  p_has_image    boolean     default null,
  p_has_quantity boolean     default null,
  p_has_listing  boolean     default null,
  p_available    boolean     default null,
  p_earned       boolean     default null,
  p_added_since  timestamptz default null,
  p_limit        integer     default 25,
  p_offset       integer     default 0
)
returns table (
  id             uuid,
  canonical_name text,
  brand          text,
  category       text,
  quantity       numeric,
  quantity_unit  text,
  image_url      text,
  add_count      integer,
  listing_count  integer,
  popularity     integer,
  retailers      text[],
  barcodes       text[],
  min_price      numeric,
  currency       text,
  available      boolean,
  merge_key      text,
  first_seen_at  timestamptz,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_query  text := nullif(public.catalog_normalize(p_query), '');
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  -- A bad filter VALUE is a bug in the caller, not an empty result. Returning
  -- nothing for a typo'd category would look exactly like a category with no
  -- products in it.
  if p_retailer is not null and not exists (select 1 from public.catalog_retailers where slug = p_retailer) then
    raise exception 'unknown retailer: %', p_retailer using errcode = 'P0001', detail = 'bad_retailer';
  end if;
  if p_category is not null and p_category not in (
    'produce','dairy','bakery','meat','fish','pantry','frozen','snacks','drinks',
    'alcohol','baby','household','personal-care','health','pet','home','other'
  ) then
    raise exception 'unknown category: %', p_category using errcode = 'P0001', detail = 'bad_category';
  end if;

  return query
  with facts as (
    select p.id as product_id,
           array_remove(array_agg(distinct r.slug), null) as retailers,
           min(l.price) filter (where l.available) as min_price,
           (array_agg(l.currency order by l.currency) filter (where l.currency is not null))[1] as currency,
           coalesce(bool_or(l.available), false) as available
      from public.catalog_products p
      left join public.catalog_listings l on l.product_id = p.id
      left join public.catalog_retailers r on r.id = l.retailer_id
     group by p.id
  ),
  codes as (
    select i.product_id, array_agg(i.identifier_value order by i.identifier_value) as barcodes
      from public.catalog_identifiers i
     where i.identifier_type = 'gtin'
     group by i.product_id
  ),
  filtered as (
    select p.*, f.retailers, f.min_price, f.currency, f.available,
           coalesce(c.barcodes, '{}'::text[]) as barcodes
      from public.catalog_products p
      join facts f on f.product_id = p.id
      left join codes c on c.product_id = p.id
     where (v_query is null or p.search_blob like '%' ||
             replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%')
       and (p_retailer     is null or p_retailer = any (f.retailers))
       and (p_category     is null or p.category = p_category)
       and (p_has_barcode  is null or (c.barcodes is not null) = p_has_barcode)
       and (p_has_brand    is null or (p.brand is not null) = p_has_brand)
       and (p_has_image    is null or (p.image_url is not null) = p_has_image)
       and (p_has_quantity is null or (p.quantity is not null) = p_has_quantity)
       and (p_has_listing  is null or (p.listing_count > 0) = p_has_listing)
       and (p_available    is null or f.available = p_available)
       and (p_earned       is null or (p.add_count > 0) = p_earned)
       and (p_added_since  is null or p.first_seen_at >= p_added_since)
  )
  select f.id, f.canonical_name, f.brand, f.category, f.quantity, f.quantity_unit,
         f.image_url, f.add_count, f.listing_count, f.popularity,
         f.retailers, f.barcodes, f.min_price, f.currency, f.available,
         f.merge_key, f.first_seen_at,
         count(*) over () as total_count
    from filtered f
   order by f.popularity desc, f.canonical_name asc, f.id asc
   limit v_limit offset v_offset;
end;
$fn$;

comment on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) is
  'Admin browse over products, with their listings folded in. total_count follows the filter, not the table.';

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
  p_barcode       text    default null,
  p_image_url     text    default null
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
    (canonical_name, brand, category, quantity, quantity_unit, image_url)
  values (p_name, nullif(btrim(coalesce(p_brand, '')), ''), p_category, p_quantity, p_quantity_unit,
          nullif(btrim(coalesce(p_image_url, '')), ''))
  returning id into v_id;

  if p_barcode is not null then
    insert into public.catalog_identifiers (product_id, identifier_type, identifier_value, source)
    values (v_id, 'gtin', p_barcode, 'admin');
  end if;

  return v_id;
end;
$fn$;

comment on function public.catalog_admin_create_product(text, text, text, numeric, text, text, text) is
  'Create a product by hand. It has no listing until a retailer is seen carrying it.';

-- ─── update ──────────────────────────────────────────────────────────────────
-- ONE CONVENTION: null leaves a column alone, '' clears it, anything else sets
-- it. The dashboard submits every field of its form on every save, so without
-- that distinction correcting a name would clear the size and the image -- which
-- is a bug the previous version of this function actually shipped.
create or replace function public.catalog_admin_update_product(
  p_id            uuid,
  p_name          text    default null,
  p_brand         text    default null,
  p_category      text    default null,
  p_quantity      numeric default null,
  p_quantity_unit text    default null,
  p_image_url     text    default null,
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
                               else nullif(btrim(p_quantity_unit), '') end,
         image_url      = case when p_image_url is null then image_url
                               else nullif(btrim(p_image_url), '') end
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

comment on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text, text) is
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
-- THE "A SCRAPER STARTED RETURNING ZERO" ALARM.
--
-- The catalog can rot in a way no error reports: a retailer changes their markup
-- or their API, the scraper keeps completing, and the numbers quietly fall. So
-- every retailer's last run is reported next to the one before it, with the
-- delta, and the runs that refused to sweep say why. That is the difference
-- between noticing in a day and noticing when somebody complains that search
-- got worse.
create or replace function public.catalog_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_out jsonb;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'products',      (select count(*) from public.catalog_products),
    'listings',      (select count(*) from public.catalog_listings),
    'unavailable',   (select count(*) from public.catalog_listings where not available),
    'identifiers',   (select count(*) from public.catalog_identifiers),
    'with_barcode',  (select count(distinct product_id) from public.catalog_identifiers),
    'with_price',    (select count(distinct product_id) from public.catalog_listings where price is not null),
    'earned',        (select count(*) from public.catalog_products where add_count > 0),
    'orphans',       (select count(*) from public.catalog_products where listing_count = 0),
    'retailers', (
      select coalesce(jsonb_agg(x order by x ->> 'slug'), '[]'::jsonb) from (
        select jsonb_build_object(
          'slug', r.slug,
          'country', r.country,
          'enabled', r.enabled,
          'listings',    (select count(*) from public.catalog_listings l where l.retailer_id = r.id),
          'available',   (select count(*) from public.catalog_listings l where l.retailer_id = r.id and l.available),
          'last_run',    to_jsonb(last_run.*),
          'previous_valid', prev.products_valid,
          -- The number worth looking at: this run against the one before it.
          'delta', case when prev.products_valid is null or last_run.products_valid is null
                        then null else last_run.products_valid - prev.products_valid end
        ) as x
          from public.catalog_retailers r
          left join lateral (
            select s.status, s.started_at, s.finished_at, s.products_found, s.products_valid,
                   s.products_rejected, s.inserted, s.updated, s.unchanged,
                   s.marked_unavailable, s.error_count, s.error
              from public.catalog_scrape_runs s
             where s.retailer_id = r.id
             order by s.started_at desc limit 1
          ) last_run on true
          left join lateral (
            select s.products_valid
              from public.catalog_scrape_runs s
             where s.retailer_id = r.id and s.status = 'completed'
             order by s.started_at desc offset 1 limit 1
          ) prev on true
      ) t
    )
  ) into v_out;

  return v_out;
end;
$fn$;

comment on function public.catalog_stats() is
  'Catalog and per-retailer scrape health. The place a scraper that started returning nothing becomes visible.';

revoke all on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) from public, anon;
revoke all on function public.catalog_admin_create_product(text, text, text, numeric, text, text, text) from public, anon;
revoke all on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text, text) from public, anon;
revoke all on function public.catalog_admin_delete_product(uuid) from public, anon;
revoke all on function public.catalog_stats() from public, anon;

grant execute on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) to authenticated;
grant execute on function public.catalog_admin_create_product(text, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.catalog_admin_update_product(uuid, text, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.catalog_admin_delete_product(uuid) to authenticated;
grant execute on function public.catalog_stats() to authenticated;
