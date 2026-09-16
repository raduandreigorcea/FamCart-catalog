-- ─── the admin browse, paged before it is folded ─────────────────────────────
-- catalog_admin_products LIVES HERE, ALONE. It was defined in 006 and moved
-- rather than restated, for the reason migrations.test.ts gives: two files
-- defining one function is a race whose winner is whichever was pushed last.
--
-- WHAT WAS WRONG. The dashboard's product table asks for 25 rows, and the 006
-- body folded EVERY product's listings first -- a group-by of 107,774 products
-- against 123,780 listings -- then filtered, counted and sorted all of it to
-- keep those 25. Measured on 2026-09-13: 5.3-5.7 seconds warm, spilling ~35 MB
-- to temp files on a 2 MB work_mem. Through PostgREST, on an instance that
-- stalls while it swaps, that crossed the 8s statement timeout on the
-- `authenticated` role, and the dashboard said "Could not load this table".
--
-- WHAT CHANGED. The order of work, not the answer:
--   1. filter on the product row alone, turning the three filters that need
--      another table (retailer, barcode, stock) into EXISTS probes on their
--      product_id indexes;
--   2. count that, and take the page from it;
--   3. fold listings and barcodes for the page's rows only.
-- Same signature, same columns, same filter meanings, same order. Measured on
-- the same data: 134ms with no filter, the case that was failing.
--
-- total_count still follows the filter rather than the table, which is what the
-- dashboard's pager reads, and it is now the one piece of work proportional to
-- the catalog: a count over one narrow row per matching product.
create or replace function public.catalog_admin_products(
  p_query        text        default null,
  p_retailer     text        default null,
  p_category     text        default null,
  p_has_barcode  boolean     default null,
  p_has_brand    boolean     default null,
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
  v_limit       integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset      integer := greatest(coalesce(p_offset, 0), 0);
  v_query       text := nullif(public.catalog_normalize(p_query), '');
  v_retailer_id uuid;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  -- A bad filter VALUE is a bug in the caller, not an empty result. Returning
  -- nothing for a typo'd category would look exactly like a category with no
  -- products in it.
  if p_retailer is not null then
    select r.id into v_retailer_id from public.catalog_retailers r where r.slug = p_retailer;
    if v_retailer_id is null then
      raise exception 'unknown retailer: %', p_retailer using errcode = 'P0001', detail = 'bad_retailer';
    end if;
  end if;
  if p_category is not null and p_category not in (
    'produce','dairy','bakery','meat','fish','pantry','frozen','snacks','drinks',
    'alcohol','baby','household','personal-care','health','pet','home','other'
  ) then
    raise exception 'unknown category: %', p_category using errcode = 'P0001', detail = 'bad_category';
  end if;

  return query
  with filtered as (
    -- One narrow row per matching product: all the count and the sort need.
    select p.id, p.popularity, p.canonical_name
      from public.catalog_products p
     where (v_query is null or p.search_blob like '%' || public.catalog_like_escape(v_query) || '%')
       and (p_category     is null or p.category = p_category)
       and (p_has_brand    is null or (p.brand is not null) = p_has_brand)
       and (p_has_quantity is null or (p.quantity is not null) = p_has_quantity)
       and (p_has_listing  is null or (p.listing_count > 0) = p_has_listing)
       and (p_earned       is null or (p.add_count > 0) = p_earned)
       and (p_added_since  is null or p.first_seen_at >= p_added_since)
       -- Any listing at that shop, in stock or not: the same question 006 asked
       -- with `p_retailer = any (retailers)`.
       and (v_retailer_id  is null or exists (
             select 1 from public.catalog_listings l
              where l.product_id = p.id and l.retailer_id = v_retailer_id))
       and (p_has_barcode  is null or exists (
             select 1 from public.catalog_identifiers i
              where i.product_id = p.id and i.identifier_type = 'gtin') = p_has_barcode)
       -- A product with no listings is not available, as it was in 006, where
       -- the fold coalesced an empty bool_or to false.
       and (p_available    is null or exists (
             select 1 from public.catalog_listings l
              where l.product_id = p.id and l.available) = p_available)
  ),
  total as (
    select count(*) as n from filtered
  ),
  page as (
    select f.id
      from filtered f
     order by f.popularity desc, f.canonical_name asc, f.id asc
     limit v_limit offset v_offset
  )
  select p.id, p.canonical_name, p.brand, p.category, p.quantity, p.quantity_unit,
         p.add_count, p.listing_count, p.popularity,
         coalesce(fx.retailers, '{}'::text[]), coalesce(c.barcodes, '{}'::text[]),
         fx.min_price, fx.currency, fx.available,
         p.merge_key, p.first_seen_at,
         t.n
    from page pg_row
    join public.catalog_products p on p.id = pg_row.id
    cross join total t
    left join lateral (
      select array_remove(array_agg(distinct r.slug), null) as retailers,
             min(l.price) filter (where l.available) as min_price,
             (array_agg(l.currency order by l.currency) filter (where l.currency is not null))[1] as currency,
             coalesce(bool_or(l.available), false) as available
        from public.catalog_listings l
        left join public.catalog_retailers r on r.id = l.retailer_id
       where l.product_id = p.id
    ) fx on true
    left join lateral (
      select array_agg(i.identifier_value order by i.identifier_value) as barcodes
        from public.catalog_identifiers i
       where i.product_id = p.id and i.identifier_type = 'gtin'
    ) c on true
   order by p.popularity desc, p.canonical_name asc, p.id asc;
end;
$fn$;

comment on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) is
  'Admin browse over products, with their listings folded in. total_count follows the filter, not the table.';

revoke all on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) from public, anon;
grant execute on function public.catalog_admin_products(text, text, text, boolean, boolean, boolean, boolean, boolean, boolean, timestamptz, integer, integer) to authenticated;
