-- Every way an admin might narrow the catalog, and three columns 009 forgot to
-- return.
--
-- WHY THIS IS SERVER-SIDE AT ALL
--
-- catalog_admin_products() pages and reports an honest total. Filtering the
-- twenty-five rows a page happens to hold would narrow the page and leave the
-- total, the pager and the count above the table describing a different set --
-- "3 products" under a control that says 441. There is no version of
-- client-side filtering here that is not a lie about how much matched.
--
-- MARKET IS A HARD FILTER HERE, AND THAT IS THE OPPOSITE OF search_catalog()
--
-- 002 says of the markets column: "A RELEVANCE SIGNAL, NOT A FILTER -- demotes
-- a non-matching row rather than hiding it", because a shopper handed an empty
-- dropdown cannot tell "not sold near you" from "never heard of it". None of
-- that applies to somebody auditing the catalog: they asked which rows say RO
-- and the answer is the rows that say RO.
--
-- The consequence to keep in mind is the empty array. Empty means UNKNOWN, not
-- "sold nowhere", and a great many honest Open Food Facts records have no
-- country at all -- so p_market => 'RO' hides every row whose market is simply
-- unrecorded. That is why p_has_market is a separate argument rather than a
-- twelfth market code: "which rows claim Romania" and "which rows claim
-- nothing" are different questions and one of them cannot be spelled as a
-- country.
--
-- THE TRI-STATE BOOLEANS
--
-- p_has_* and p_earned are null for "do not ask", true for "must have", false
-- for "must not". Three states in one argument rather than two arguments,
-- because the alternative pairs (p_has_barcode, p_require_barcode) have a
-- fourth combination that means nothing and would have to be rejected anyway.
--
-- WHAT MOST OF THESE ARE FOR. Not browsing -- finding the rows that need work.
-- Commercial products with no brand are the shape the gate was tightened to
-- reject and the ones that predate it are still here; generics with no market
-- are seed rows nobody placed; A-tier rows with no image are mis-tiered. Each
-- of those is a question somebody was previously answering by eye, one page of
-- twenty-five at a time.

-- The argument list is different, so the old function has to go rather than be
-- replaced -- 010 hit this and the reasoning is unchanged: `create or replace`
-- with a different signature leaves BOTH resident, and PostgREST resolves by
-- argument name, so which one answers would depend on what the caller happened
-- to send.
drop function if exists public.catalog_admin_products(text, text, integer, integer);

create or replace function public.catalog_admin_products(
  p_query        text        default null,
  p_type         text        default null,
  p_market       text        default null,
  p_tier         text        default null,
  p_category     text        default null,
  p_source       text        default null,
  p_lang         text        default null,
  p_has_barcode  boolean     default null,
  p_has_brand    boolean     default null,
  p_has_image    boolean     default null,
  p_has_quantity boolean     default null,
  p_has_market   boolean     default null,
  p_earned       boolean     default null,
  p_added_since  timestamptz default null,
  p_limit        integer     default 25,
  p_offset       integer     default 0
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
  -- The three 009 declared nowhere and 010 then made editable.
  --
  -- This was not merely a thin row. CatalogFormDialog fills its form from
  -- whatever this function returns and submits EVERY field on save, under the
  -- convention that an empty string clears a column -- so a product with a size
  -- or an image arrived in the edit form with those boxes blank and lost both
  -- the moment anybody corrected its name. Returning them is the fix; the form
  -- was right.
  quantity       numeric,
  quantity_unit  text,
  image_url      text,
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

  -- Rejected by name rather than answered with nothing. A filter value this
  -- function cannot hold matches no row, and an empty table is exactly what a
  -- correct filter over a thin catalog also looks like -- so a typo in a market
  -- code would read as "we stock nothing there" for as long as nobody checked.
  if p_type is not null and p_type not in ('generic', 'commercial') then
    raise exception 'catalog_admin_products: p_type must be generic or commercial, got %', p_type
      using errcode = 'P0001', detail = 'bad_type';
  end if;

  if p_market is not null
     and p_market not in ('RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE') then
    raise exception 'catalog_admin_products: % is not a market this catalog can hold', p_market
      using errcode = 'P0001', detail = 'bad_market';
  end if;

  if p_tier is not null and p_tier not in ('A', 'B', 'C') then
    raise exception 'catalog_admin_products: p_tier must be A, B or C, got %', p_tier
      using errcode = 'P0001', detail = 'bad_tier';
  end if;

  if p_category is not null and p_category not in (
       'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
       'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
       'health', 'pet', 'home', 'other'
     ) then
    raise exception 'catalog_admin_products: % is not a category this catalog uses', p_category
      using errcode = 'P0001', detail = 'bad_category';
  end if;

  if p_source is not null and p_source not in (
       'curated', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'user', 'admin'
     ) then
    raise exception 'catalog_admin_products: % is not a provenance this catalog records', p_source
      using errcode = 'P0001', detail = 'bad_source';
  end if;

  if p_lang is not null and p_lang not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'catalog_admin_products: % is not a language this catalog names in', p_lang
      using errcode = 'P0001', detail = 'bad_lang';
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
      -- Containment rather than equality: markets is a set and a product sold
      -- in five countries matches each of them. Uses catalog_products_markets.
      and (p_market is null or p.markets @> array[p_market]::text[])
      and (p_tier is null or p.quality_tier = p_tier)
      and (p_category is null or p.category = p_category)
      and (p_lang is null or p.name_lang = p_lang)
      and (
        p_source is null
        or exists (
          select 1 from public.catalog_sources s
          where s.product_id = p.id and s.source_name = p_source
        )
      )
      and (
        p_has_barcode is null
        or exists (
          select 1 from public.catalog_identifiers i where i.product_id = p.id
        ) = p_has_barcode
      )
      -- A plain null check is enough for both, and only because 002 says so:
      -- catalog_products_brand_length refuses a brand that trims to nothing and
      -- catalog_products_image_url_check refuses an image that is not an https
      -- address. Absent those, '' would be a third state here -- present to the
      -- filter, blank on screen -- and each of these would need a trim.
      and (p_has_brand is null or (p.brand is not null) = p_has_brand)
      and (p_has_image is null or (p.image_url is not null) = p_has_image)
      -- The pair moves together under the check constraint, so either column
      -- answers this; quantity is the one somebody means by "size".
      and (p_has_quantity is null or (p.quantity is not null) = p_has_quantity)
      and (p_has_market is null or (cardinality(p.markets) > 0) = p_has_market)
      -- add_count is the earned half of popularity. False here means base_weight
      -- and nothing else: a product the catalog asserts is worth suggesting that
      -- no household has ever actually added.
      and (p_earned is null or (p.add_count > 0) = p_earned)
      and (p_added_since is null or p.created_at >= p_added_since)
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
    m.quantity,
    m.quantity_unit,
    m.image_url,
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

comment on function public.catalog_admin_products(
  text, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean,
  timestamptz, integer, integer
) is
  'Browse and filter the reference catalog. Admin only. Stable ordering and an '
  'honest total, unlike search_catalog() which ranks for a keystroke. Market is '
  'a hard filter here and an empty markets array means unknown, so p_has_market '
  'asks the question p_market cannot.';

revoke all on function public.catalog_admin_products(
  text, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean,
  timestamptz, integer, integer
) from public, anon;

grant execute on function public.catalog_admin_products(
  text, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean,
  timestamptz, integer, integer
) to authenticated;
