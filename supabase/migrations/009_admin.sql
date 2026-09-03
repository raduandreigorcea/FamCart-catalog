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
--
-- ONE CONVENTION FOR EVERY ARGUMENT of create and update, because the
-- alternative is remembering which fields behave which way:
--
--   null           leave this column exactly as it is
--   '' (empty)     clear it to null
--   anything else  set it
--
-- That is why the numeric and array arguments are not simply nullable: `null`
-- had to keep meaning "not mentioned" for all of them, or an update that omitted
-- a field would quietly erase it. Quantity and its unit move together, since the
-- check constraint requires both or neither, and clearing the unit clears the
-- pair.
--
-- THE BARCODE IS EDITABLE, AND WITHHOLDING IT WAS THE FIRST ANSWER
--
-- A scan resolves through catalog_identifiers and nowhere else, so moving a code
-- silently sends every future scan of it to a different product. That risk is
-- real and it has not gone away; what changed is who decides. The answer is not
-- to withhold the field but to make the dangerous version of it impossible: a
-- code already claimed by another product is refused by name, the format is
-- checked before the constraint can fire, and clearing is distinguishable from
-- leaving alone so that a caller that simply does not mention the barcode cannot
-- wipe one.
--
-- A GENERIC PRODUCT HAS NO BARCODE AT ALL, which is enforced in 002 next to the
-- identifiers table rather than here. Create and update need no rule of their
-- own for it: the trigger refuses the pairing whichever writer offers it.

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


-- A CHANGED ARGUMENT LIST MEANS THE OLD FUNCTION HAS TO GO rather than be
-- replaced. `create or replace` with a different signature leaves both
-- resident, and PostgREST resolves an RPC by the argument names in the body, so
-- which one answered would depend on what the caller happened to send. This
-- file's browse and update functions have both grown their arguments since they
-- were first written, so each is preceded by a drop of what it used to be. On a
-- fresh database both drops are no-ops; on one that ran an earlier version they
-- are the whole point.
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

-- ─── create ──────────────────────────────────────────────────────────────────
-- ONE RULE FOR THE MERGE KEY. An earlier version of this function built the
-- normalised name by concatenating the name and brand itself and passing the
-- result to the one-argument catalog_normalize(). That happens to agree with
-- catalog_normalize(name, brand) today, because the two-argument form joins them
-- with a single space -- but it is a second copy of a rule that the
-- catalog_products_derive trigger owns, and the two would part company silently
-- the first time that join changed. The pre-check would then pass and the unique
-- index would fire, which is the raw 23505 the check exists to avoid.
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

  if coalesce(p_lang, '') not in ('en', 'de', 'es', 'ro', 'fr', 'it') then
    raise exception 'The name language must be one of en, de, es, ro, fr, it.'
      using errcode = 'P0001', detail = 'bad_lang';
  end if;

  if not (coalesce(p_markets, '{}') <@ array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']::text[]) then
    raise exception 'One of those markets is not a market this catalog can hold.'
      using errcode = 'P0001', detail = 'bad_markets';
  end if;

  if nullif(btrim(coalesce(p_category, '')), '') is not null
     and btrim(p_category) not in (
       'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
       'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
       'health', 'pet', 'home', 'other'
     ) then
    raise exception 'That is not a category this catalog uses.'
      using errcode = 'P0001', detail = 'bad_category';
  end if;

  -- The trigger's own rule, called rather than reproduced.
  v_norm := public.catalog_normalize(v_name, v_brand);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  if exists (select 1 from public.catalog_products where normalized_name = v_norm) then
    raise exception 'The catalog already holds a product that normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  if v_barcode is not null then
    if v_barcode !~ '^[0-9]{8,14}$' then
      raise exception 'A barcode must be 8 to 14 digits.'
        using errcode = 'P0001', detail = 'bad_barcode';
    end if;

    if exists (
      select 1 from public.catalog_identifiers
      where identifier_type = 'gtin' and identifier_value = v_barcode
    ) then
      raise exception 'Another product already claims that barcode.'
        using errcode = 'P0001', detail = 'duplicate_barcode';
    end if;
  end if;

  insert into public.catalog_products
    (product_type, canonical_name, name_lang, brand, category, markets,
     base_weight, add_count, source_count)
  values
    (p_type, v_name, p_lang, v_brand,
     nullif(btrim(coalesce(p_category, '')), ''), coalesce(p_markets, '{}'),
     greatest(coalesce(p_base_weight, 0), 0), 0, 1)
  returning id into v_id;

  insert into public.catalog_sources (product_id, source_name, source_product_id)
  values (v_id, 'admin', v_id::text);

  if v_barcode is not null then
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
-- The second of the two drops described above: this function was eight
-- arguments before the barcode, the quantity pair, the image and the tier
-- became editable.
drop function if exists public.catalog_admin_update_product(
  uuid, text, text, text, text, text, text[], integer
);

create or replace function public.catalog_admin_update_product(
  p_id            uuid,
  p_name          text,
  p_type          text,
  p_lang          text,
  p_brand         text    default null,
  p_category      text    default null,
  p_markets       text[]  default null,
  p_base_weight   integer default null,
  p_barcode       text    default null,
  p_quantity      numeric default null,
  p_quantity_unit text    default null,
  p_image_url     text    default null,
  p_quality_tier  text    default null
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
  v_code  text;
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

  -- The seventeen the check constraint accepts. Checked here so a category the
  -- dashboard offers but the constraint refuses is a sentence rather than a
  -- constraint violation naming a table.
  if nullif(btrim(coalesce(p_category, '')), '') is not null
     and btrim(p_category) not in (
       'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen',
       'snacks', 'drinks', 'alcohol', 'baby', 'household', 'personal-care',
       'health', 'pet', 'home', 'other'
     ) then
    raise exception 'That is not a category this catalog uses.'
      using errcode = 'P0001', detail = 'bad_category';
  end if;

  if nullif(btrim(coalesce(p_quality_tier, '')), '') is not null
     and upper(btrim(p_quality_tier)) not in ('A', 'B', 'C') then
    raise exception 'A record tier is A, B or C.'
      using errcode = 'P0001', detail = 'bad_quality_tier';
  end if;

  -- Both or neither, and a positive number, because that is what the check
  -- constraint says and a half-filled pair is the easy mistake here.
  if nullif(btrim(coalesce(p_quantity_unit, '')), '') is not null then
    if btrim(p_quantity_unit) not in ('g', 'kg', 'ml', 'l', 'cl', 'piece') then
      raise exception 'A quantity unit is one of g, kg, ml, l, cl or piece.'
        using errcode = 'P0001', detail = 'bad_quantity_unit';
    end if;
    if p_quantity is null or p_quantity <= 0 then
      raise exception 'A quantity needs a number greater than zero to go with its unit.'
        using errcode = 'P0001', detail = 'bad_quantity';
    end if;
  end if;

  if nullif(btrim(coalesce(p_image_url, '')), '') is not null
     and (btrim(p_image_url) !~ '^https://' or char_length(btrim(p_image_url)) > 500) then
    raise exception 'An image address must start with https:// and be under 500 characters.'
      using errcode = 'P0001', detail = 'bad_image_url';
  end if;

  v_norm := public.catalog_normalize(v_name, v_brand);
  if v_norm = '' then
    raise exception 'That name does not reduce to a usable key.'
      using errcode = 'P0001', detail = 'bad_normalized_name';
  end if;

  if exists (
    select 1 from public.catalog_products
    where normalized_name = v_norm and id <> p_id
  ) then
    raise exception 'Another product already normalises to that name.'
      using errcode = 'P0001', detail = 'duplicate_name';
  end if;

  -- ─── the barcode ───────────────────────────────────────────────────────────
  -- Only touched when it was mentioned. See the header: a caller that does not
  -- send one must not be able to remove one.
  if p_barcode is not null then
    v_code := nullif(btrim(p_barcode), '');

    if v_code is null then
      -- Explicitly emptied: the product becomes unscannable, which is a real
      -- thing to want when a code turns out to belong to something else.
      delete from public.catalog_identifiers
      where product_id = p_id and identifier_type = 'gtin';
    else
      if v_code !~ '^[0-9]{8,14}$' then
        raise exception 'A barcode must be 8 to 14 digits.'
          using errcode = 'P0001', detail = 'bad_barcode';
      end if;

      -- The check that makes this safe to offer at all. Without it, one product
      -- takes another's code and every scan of it lands on the wrong thing.
      if exists (
        select 1 from public.catalog_identifiers
        where identifier_type = 'gtin'
          and identifier_value = v_code
          and product_id <> p_id
      ) then
        raise exception 'Another product already claims that barcode.'
          using errcode = 'P0001', detail = 'duplicate_barcode';
      end if;

      delete from public.catalog_identifiers
      where product_id = p_id and identifier_type = 'gtin' and identifier_value <> v_code;

      insert into public.catalog_identifiers
        (product_id, identifier_type, identifier_value, source)
      values (p_id, 'gtin', v_code, 'admin')
      on conflict (identifier_type, identifier_value) do nothing;
    end if;
  end if;

  -- add_count, source_count and the derived columns stay out of this, as in 009.
  update public.catalog_products
  set canonical_name = v_name,
      product_type   = p_type,
      name_lang      = p_lang,
      brand          = v_brand,
      category       = case
                         when p_category is null then category
                         when btrim(p_category) = '' then null
                         else btrim(p_category)
                       end,
      markets        = coalesce(p_markets, markets),
      base_weight    = greatest(coalesce(p_base_weight, base_weight), 0),
      quality_tier   = case
                         when nullif(btrim(coalesce(p_quality_tier, '')), '') is null
                           then quality_tier
                         else upper(btrim(p_quality_tier))
                       end,
      -- The pair moves together: clearing the unit clears the number with it,
      -- because the constraint refuses one without the other.
      quantity       = case
                         when p_quantity_unit is null then quantity
                         when btrim(p_quantity_unit) = '' then null
                         else p_quantity
                       end,
      quantity_unit  = case
                         when p_quantity_unit is null then quantity_unit
                         when btrim(p_quantity_unit) = '' then null
                         else btrim(p_quantity_unit)
                       end,
      image_url      = case
                         when p_image_url is null then image_url
                         when btrim(p_image_url) = '' then null
                         else btrim(p_image_url)
                       end
  where id = p_id;
end;
$$;

comment on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text) is
  'Correct every editable column of a reference product, the barcode included. '
  'Admin only. null leaves a column alone, an empty string clears it. Leaves '
  'add_count, source_count and the derived columns untouched.';

revoke all on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text)
  from public, anon;
grant execute on function public.catalog_admin_update_product(uuid, text, text, text, text, text, text[], integer, text, numeric, text, text, text)
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
