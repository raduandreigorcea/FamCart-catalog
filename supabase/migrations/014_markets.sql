-- ─── one catalog, several countries ──────────────────────────────────────────
-- Every retailer so far is Romanian, so "which country is this for" never had
-- to be asked of a product. The moment a second country's shop is read, two
-- things go wrong that nothing here would notice:
--
--   * A GTIN merges the same article across borders -- the same bottle of
--     water at Mega Image and at Esselunga is ONE product -- and a product
--     keeps the name of the listing that created it. A phone in Italy would be
--     offered "Apa plata Dorna 2L", a phone in Romania "Acqua naturale".
--   * search_catalog already filtered by market, but lookup_barcode and
--     catalog_shops_for did not. A scan in Italy would find a product only a
--     Romanian shop sells, and a list in Italy would wear Romanian shop badges.
--
-- So all three app-facing reads now take the market and answer for it: only
-- shops in that country, under the name a shop there uses. With no market they
-- behave exactly as before, which is what every call made today sends or gets.
--
-- NO COLUMN FOR "WHERE WAS THIS NAMED". It is worked out when asked (see
-- catalog_display_name) rather than stored, because storing it meant updating
-- every one of 107,000 products in one statement on an instance that already
-- swaps, while the nightly scrapers write to the same rows. The per-row cost at
-- query time is one short index lookup, and only when a market is sent.
--
-- search_catalog, lookup_barcode and catalog_shops_for LIVE HERE, ALONE. They
-- moved out of 009 and 005 rather than being restated, for the reason
-- migrations.test.ts gives.

-- ─── the name a country reads ────────────────────────────────────────────────
-- The product's own name, unless it was named in a country the caller is not
-- in -- then the wording of a shop in the caller's country.
--
-- "Named in" is the country of the listing that still uses the product's own
-- name, which is the listing that created it: an import sets canonical_name
-- from that listing's name and never renames. Failing that (an admin renamed
-- it, or that shop reworded it since), the earliest listing. The equality comes
-- FIRST because listings imported in one transaction share a first_seen_at, and
-- a tie broken by a random uuid would make the name flip between calls.
--
-- A product with no listings, or a caller with no market, gets the product's
-- own name: there is no other country to be in.
create or replace function public.catalog_display_name(
  p_product_id uuid,
  p_canonical  text,
  p_markets    text[]
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_named_in text;
  v_local    text;
begin
  if p_markets is null then
    return p_canonical;
  end if;

  select r.country into v_named_in
    from public.catalog_listings l
    join public.catalog_retailers r on r.id = l.retailer_id
   where l.product_id = p_product_id
   order by (l.retailer_name = p_canonical) desc, l.first_seen_at nulls last, l.id
   limit 1;

  if v_named_in is null or v_named_in = any (p_markets) then
    return p_canonical;
  end if;

  -- In stock before out, then the freshest, then a fixed order: the same list
  -- asked twice must read the same.
  select l.retailer_name into v_local
    from public.catalog_listings l
    join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
   where l.product_id = p_product_id
     and r.country = any (p_markets)
   order by l.available desc, l.last_seen_at desc, r.slug, l.external_id
   limit 1;

  return coalesce(v_local, p_canonical);
end;
$fn$;

comment on function public.catalog_display_name(uuid, text, text[]) is
  'The name a caller in these markets reads: the product''s own, unless it was named in another country.';

revoke all on function public.catalog_display_name(uuid, text, text[]) from public, anon, authenticated;

-- ─── search ──────────────────────────────────────────────────────────────────
-- The body is 009's, which made the trigram index reachable and gathers the
-- exact and prefix rungs by their own indexes before capping the pool -- see
-- the history there. What 014 changes is only the name: each row answers under
-- catalog_display_name, and the rungs compare the query against THAT name, so
-- "latte" typed in Italy is a name_prefix match on the Italian wording rather
-- than a blob match on a Romanian one.
--
-- The candidate pool is still gathered on the product's own name and its
-- search_blob. The blob already holds every shop's wording, so a product named
-- abroad is still found by the local words; it just enters through the blob
-- rather than the name indexes.
create or replace function public.search_catalog(
  p_query     text,
  p_limit     integer default 100,
  p_markets   text[] default null,
  p_langs     text[] default null,
  p_fuzzy     boolean default false,
  p_retailers text[] default null
)
returns table (
  name            text,
  maker           text,
  popularity      integer,
  quantity        numeric,
  quantity_unit   text,
  retailers       text[],
  min_price       numeric,
  currency        text,
  available       boolean,
  match_type      text,
  relevance_score integer
)
language plpgsql
security definer
stable
set search_path = public, extensions
as $fn$
declare
  v_query   text;
  v_tokens  text[];
  v_limit   integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_like    text;
  -- One '%token%' pattern per token, and the longest of them on its own. The
  -- second is the conjunct the trigram index answers; the first is the recheck.
  v_pats    text[];
  v_anchor  text;
  v_ids     uuid[];
begin
  -- p_langs is part of the signature and nothing else; naming it here keeps the
  -- "unused parameter" honest rather than looking like an oversight.
  perform p_langs;

  v_query := public.catalog_normalize(p_query);
  if v_query is null or char_length(v_query) < 2 then
    return;
  end if;

  v_like := public.catalog_like_escape(v_query);

  v_tokens := (
    select array_agg(t)
      from (select unnest(string_to_array(v_query, ' ')) as t limit 6) s
     where char_length(t) > 0
  );
  if v_tokens is null then
    return;
  end if;

  v_pats := (select array_agg('%' || public.catalog_like_escape(t) || '%') from unnest(v_tokens) t);
  v_anchor := (
    select '%' || public.catalog_like_escape(t) || '%'
      from unnest(v_tokens) t
     order by char_length(t) desc, t
     limit 1
  );

  -- Gathered as ids, in three passes, because a UNION of three cheap index
  -- lookups is a thing Postgres plans well and a three-way OR inside one scan is
  -- not. Each branch is parenthesised: an unparenthesised LIMIT in a set
  -- operation binds to the whole result, not to the branch it sits in.
  select array_agg(c.id) into v_ids
    from (
      (select p.id
         from public.catalog_products p
        where public.catalog_normalize(p.canonical_name) = v_query
        limit 50)
      union
      (select p.id
         from public.catalog_products p
        where public.catalog_normalize(p.canonical_name) like v_like || '%'
        limit 100)
      union
      -- Everything else, capped. Unordered on purpose: an ORDER BY here would
      -- force the whole match set to be materialised and sorted before the cap.
      (select p.id
         from public.catalog_products p
        where p.search_blob like v_anchor
          and p.search_blob like all (v_pats)
        limit 500)
    ) c;

  -- Opt-in, and a separate statement rather than a fourth branch: as a WHERE
  -- clause the parameter would be evaluated per row on every non-fuzzy call.
  if p_fuzzy then
    select array_cat(coalesce(v_ids, '{}'::uuid[]), coalesce(array_agg(f.id), '{}'::uuid[]))
      into v_ids
      from (
        select p.id
          from public.catalog_products p
         where extensions.word_similarity(v_query, p.search_blob) >= 0.42
         limit 500
      ) f;
  end if;

  if v_ids is null or array_length(v_ids, 1) is null then
    return;
  end if;

  return query
  with candidates as (
    select p.*,
           public.catalog_normalize(coalesce(p.brand, '')) as folded_brand
      from public.catalog_products p
     where p.id = any (v_ids)
  ),
  -- The market filter, and the reason it is a join rather than a where clause on
  -- the product: a product is buyable in a market if ANY enabled retailer there
  -- lists it, and the same product may be listed in several.
  shelf as (
    select c.id as product_id,
           array_agg(distinct r.slug order by r.slug) as shops,
           min(l.price) filter (where l.available) as cheapest,
           (array_agg(l.currency order by l.currency))[1] as shelf_currency,
           bool_or(l.available) as in_stock,
           count(distinct l.retailer_id) as retailer_count,
           -- The shop filter, as a flag rather than another where clause, so
           -- the other shops stay in `shops` and in `cheapest`.
           bool_or(r.slug = any (coalesce(p_retailers, '{}'))) as has_wanted
      from candidates c
      join public.catalog_listings l on l.product_id = c.id
      join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
     where p_markets is null or r.country = any (p_markets)
     group by c.id
  ),
  -- The name is chosen only for products that survived the shelf, so a product
  -- no shop in this market sells costs nothing here.
  named as (
    select c.*, s.shops, s.cheapest, s.shelf_currency, s.in_stock, s.retailer_count,
           public.catalog_display_name(c.id, c.canonical_name, p_markets) as display_name
      from candidates c
      join shelf s on s.product_id = c.id
     where p_retailers is null or s.has_wanted
  ),
  scored as (
    select
      n.display_name,
      n.brand,
      n.popularity,
      n.quantity,
      n.quantity_unit,
      n.shops,
      n.cheapest,
      n.shelf_currency,
      n.in_stock,
      case
        when public.catalog_normalize(n.display_name) = v_query                        then 'name_exact'
        when public.catalog_normalize(n.display_name) like v_like || '%'               then 'name_prefix'
        when n.folded_brand = v_query                                                  then 'brand_exact'
        when public.catalog_normalize(n.display_name) like all (v_pats)                then 'name_tokens'
        when n.folded_brand like v_like || '%'                                         then 'brand_prefix'
        when n.search_blob like all (v_pats)                                           then 'blob_tokens'
        when n.search_blob like '%' || v_like || '%'                                   then 'blob_substring'
        else 'fuzzy'
      end as match_kind,
      n.retailer_count
      from named n
  )
  select
    sc.display_name,
    sc.brand,
    sc.popularity,
    sc.quantity,
    sc.quantity_unit,
    sc.shops,
    sc.cheapest,
    sc.shelf_currency,
    sc.in_stock,
    sc.match_kind,
    (
      (public.catalog_search_weights() ->> sc.match_kind)::integer
      + case when sc.in_stock then (public.catalog_search_weights() ->> 'bonus_available')::integer else 0 end
      + case when sc.retailer_count > 1 then (public.catalog_search_weights() ->> 'bonus_multi_retailer')::integer else 0 end
      + case when sc.quantity is not null and v_query like '%' || public.catalog_number_key(sc.quantity) || '%'
             then (public.catalog_search_weights() ->> 'bonus_quantity')::integer else 0 end
    )::integer as score
    from scored sc
   order by score desc, sc.popularity desc, sc.display_name
   limit v_limit;
end;
$fn$;

comment on function public.search_catalog(text, integer, text[], text[], boolean, text[]) is
  'Autocomplete over the catalog. One row per product, named for the market. p_markets and p_retailers filter hard; p_langs is accepted and ignored.';

revoke all on function public.search_catalog(text, integer, text[], text[], boolean, text[]) from public, anon;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean, text[]) to authenticated;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean, text[]) to service_role;

-- ─── barcode ─────────────────────────────────────────────────────────────────
-- The one lookup that goes nowhere near ranking: a GTIN is an exact key. The app
-- sends up to three candidate forms of a scanned code (as printed, zero-padded
-- 12 to 13, and stripped 13 to 12).
--
-- p_markets is APPENDED, with a default, so the app's current call -- p_codes
-- alone -- still resolves. With it, a scan finds only what an enabled shop in
-- that market lists, which is the rule search has followed since the rebuild.
create or replace function public.lookup_barcode(
  p_codes   text[],
  p_langs   text[] default null,
  p_markets text[] default null
)
returns table (name text, maker text, popularity integer)
language plpgsql
security definer
stable
set search_path = public, extensions
as $fn$
begin
  perform p_langs;
  if p_codes is null or array_length(p_codes, 1) is null then
    return;
  end if;

  return query
  select public.catalog_display_name(p.id, p.canonical_name, p_markets), p.brand, p.popularity
    from public.catalog_identifiers i
    join public.catalog_products p on p.id = i.product_id
   where i.identifier_type = 'gtin'
     and i.identifier_value = any (p_codes)
     and (p_markets is null or exists (
           select 1
             from public.catalog_listings l
             join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
            where l.product_id = p.id
              and r.country = any (p_markets)))
   order by p.popularity desc, p.canonical_name
   limit 1;
end;
$fn$;

-- The two-argument version, dropped rather than left beside this one: an
-- overload is an ambiguity PostgREST answers with a 300, which the app reads as
-- the catalog being down.
drop function if exists public.lookup_barcode(text[], text[]);

comment on function public.lookup_barcode(text[], text[], text[]) is
  'Exact GTIN lookup for a scanned barcode, named and filtered for the market. p_langs is accepted and ignored.';

revoke all on function public.lookup_barcode(text[], text[], text[]) from public, anon;
grant execute on function public.lookup_barcode(text[], text[], text[]) to authenticated;
grant execute on function public.lookup_barcode(text[], text[], text[]) to service_role;

-- ─── which shops carry these ─────────────────────────────────────────────────
-- The body is 009's: one call for a whole shopping list, matching the product's
-- own name or any shop's wording, one product per asked name with a fixed
-- tiebreak so a badge never changes because the planner did.
--
-- With a market, the badges are that country's shops only, a product no shop
-- there sells is left out BEFORE the one-per-name choice (so a same-named
-- product that is sold here wins), and the row answers under the market's name
-- -- which is the name the list row carries, since it came out of the same
-- search. The app keys badges by that name, so answering under the product's
-- own name abroad would leave every badge without its row.
create or replace function public.catalog_shops_for(p_names text[], p_markets text[] default null)
returns table (name text, maker text, retailers text[])
language plpgsql
security definer
stable
set search_path = public, extensions
as $fn$
begin
  if p_names is null or array_length(p_names, 1) is null then
    return;
  end if;

  return query
  with asked as (
    select distinct public.catalog_normalize(n) as folded
      from unnest(p_names[1:200]) as n
     where public.catalog_normalize(n) <> ''
  ),
  matched as (
    select a.folded, p.id
      from asked a
      join public.catalog_products p
        on public.catalog_normalize(p.canonical_name) = a.folded
    union
    select a.folded, l.product_id
      from asked a
      join public.catalog_listings l
        on public.catalog_normalize(l.retailer_name) = a.folded
  ),
  shelved as (
    select m.folded, m.id,
           (select array_agg(distinct r.slug order by r.slug)
              from public.catalog_listings l
              join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
             where l.product_id = m.id
               and (p_markets is null or r.country = any (p_markets))) as shops
      from matched m
  ),
  best as (
    select distinct on (s.folded) s.folded, s.id, s.shops
      from shelved s
      join public.catalog_products p on p.id = s.id
     where p_markets is null or s.shops is not null
     order by s.folded, p.popularity desc, p.canonical_name, p.id
  )
  select public.catalog_display_name(p.id, p.canonical_name, p_markets),
         p.brand,
         coalesce(b.shops, '{}'::text[])
    from best b
    join public.catalog_products p on p.id = b.id;
end;
$fn$;

drop function if exists public.catalog_shops_for(text[]);

comment on function public.catalog_shops_for(text[], text[]) is
  'Which shops carry each of these products, by name, for the market. One call for a whole shopping list.';

revoke all on function public.catalog_shops_for(text[], text[]) from public, anon;
grant execute on function public.catalog_shops_for(text[], text[]) to authenticated;
grant execute on function public.catalog_shops_for(text[], text[]) to service_role;
