-- ─── what the app calls ──────────────────────────────────────────────────────
-- Three functions, and their NAMES AND ARGUMENT NAMES ARE A CROSS-REPOSITORY
-- CONTRACT. PostgREST resolves an RPC by the argument names in the request body,
-- so renaming p_query, p_limit, p_markets, p_langs, p_codes, p_name or p_maker
-- breaks src/lib/productSuggestions.ts in the app repo with nothing here to warn
-- anybody. The app's CI runs this suite for exactly that reason.
--
-- The failure is also SILENT on the app's side: a 404 from PostgREST is caught,
-- the catalog leg of Promise.allSettled returns [], and suggestions quietly fall
-- back to the app database's own rows. Nobody sees an error; the dropdown just
-- gets worse.

-- ─── the weights, in one place ───────────────────────────────────────────────
-- Read by the admin dashboard so a ranking decision can be explained rather than
-- argued about.
--
-- THE RUNGS ARE TEN APART AND THE BONUSES ADD UP TO NINE. That is not tidiness:
-- it is what makes a bonus incapable of lifting a row over a better match. When
-- bonuses could cross a rung, "beer" answered with "Beef" -- a worse text match
-- that happened to be in stock at three shops. A bonus breaks ties inside a rung
-- and never leaves it.
create or replace function public.catalog_search_weights()
returns jsonb
language sql
immutable
as $fn$
  select jsonb_build_object(
    'name_exact',    100,
    'name_prefix',    80,
    'brand_exact',    70,
    'name_tokens',    60,
    'brand_prefix',   50,
    'blob_tokens',    30,
    'blob_substring', 20,
    'fuzzy',           5,
    'bonus_available', 5,
    'bonus_multi_retailer', 3,
    'bonus_quantity',  1
  )
$fn$;

comment on function public.catalog_search_weights() is
  'The ranking rungs and bonuses. Rungs are 10 apart; bonuses total 9, so a bonus can never cross a rung.';

revoke all on function public.catalog_search_weights() from public, anon;
grant execute on function public.catalog_search_weights() to authenticated;

-- ─── search ──────────────────────────────────────────────────────────────────
-- ONE ROW PER PRODUCT, not per listing. The app renders a dropdown of names and
-- makers and dedupes on exactly those two fields; three rows for one product
-- because three shops carry it would be three identical lines.
--
-- p_markets FILTERS, and this is a reversal of the old catalog's rule. Back then
-- market came from Open Food Facts country tags, which were unreliable enough
-- that treating them as fact produced empty dropdowns; the rule was to demote.
-- A retailer listing is not a tag. Auchan Romania stocking something is a hard
-- fact about where you can buy it, and offering it to a phone in Germany is
-- offering a shop they cannot reach. They get nothing from here and the app
-- falls back to its own product_catalog, which is the correct answer.
--
-- p_langs is ACCEPTED AND IGNORED. Every retailer here is Romanian and every
-- product name is Romanian; there is no second language to prefer. It stays in
-- the signature because the app sends it and because dropping an argument is
-- the same silent break as renaming one.
--
-- p_fuzzy is opt-in and the app never sends it. Removing the guessing from the
-- keystroke path is deliberate: an empty result now means "no shop we read lists
-- this", which is TRUE and useful, where the old catalog's empty result meant
-- "you may have typed it wrong" and answered `beer` with `Beef` and `toothpaste`
-- with `Toothbrush`. No threshold fixes that -- sampoo/Sampon and champu/
-- Champignon both score 0.714 -- so the fallback moved behind a flag instead.
create or replace function public.search_catalog(
  p_query   text,
  p_limit   integer default 100,
  p_markets text[] default null,
  p_langs   text[] default null,
  p_fuzzy   boolean default false
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
begin
  -- p_langs is part of the signature and nothing else; naming it here keeps the
  -- "unused parameter" honest rather than looking like an oversight.
  perform p_langs;

  v_query := public.catalog_normalize(p_query);
  if v_query is null or char_length(v_query) < 2 then
    return;
  end if;

  -- LIKE metacharacters are DATA. A user typing "100%" must search for a
  -- hundred percent, not for "anything".
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  v_tokens := (
    select array_agg(t)
      from (select unnest(string_to_array(v_query, ' ')) as t limit 6) s
     where char_length(t) > 0
  );

  return query
  with candidates as (
    select p.*
      from public.catalog_products p
     where p.search_blob like '%' || v_like || '%'
        or (
          v_tokens is not null
          and (select bool_and(p.search_blob like '%' ||
                 replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%')
                 from unnest(v_tokens) tok)
        )
        or (p_fuzzy and extensions.word_similarity(v_query, p.search_blob) >= 0.42)
     limit 500
  ),
  -- The market filter, and the reason it is a join rather than a where clause on
  -- the product: a product is buyable in a market if ANY enabled retailer there
  -- lists it, and the same product may be listed in several.
  shelf as (
    select c.id as product_id,
           array_agg(distinct r.slug order by r.slug) as retailers,
           min(l.price) filter (where l.available) as min_price,
           (array_agg(l.currency order by l.currency))[1] as currency,
           bool_or(l.available) as available,
           count(distinct l.retailer_id) as retailer_count
      from candidates c
      join public.catalog_listings l on l.product_id = c.id
      join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
     where p_markets is null or r.country = any (p_markets)
     group by c.id
  ),
  scored as (
    select
      c.canonical_name,
      c.brand,
      c.popularity,
      c.quantity,
      c.quantity_unit,
      s.retailers,
      s.min_price,
      s.currency,
      s.available,
      case
        when public.catalog_normalize(c.canonical_name) = v_query                     then 'name_exact'
        when public.catalog_normalize(c.canonical_name) like v_like || '%'            then 'name_prefix'
        when public.catalog_normalize(coalesce(c.brand, '')) = v_query                then 'brand_exact'
        when v_tokens is not null and (select bool_and(public.catalog_normalize(c.canonical_name) like '%' ||
               replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%')
               from unnest(v_tokens) tok)                                             then 'name_tokens'
        when public.catalog_normalize(coalesce(c.brand, '')) like v_like || '%'       then 'brand_prefix'
        when v_tokens is not null and (select bool_and(c.search_blob like '%' ||
               replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%')
               from unnest(v_tokens) tok)                                             then 'blob_tokens'
        when c.search_blob like '%' || v_like || '%'                                  then 'blob_substring'
        else 'fuzzy'
      end as match_type,
      s.retailer_count
      from candidates c
      join shelf s on s.product_id = c.id
  )
  select
    sc.canonical_name,
    sc.brand,
    sc.popularity,
    sc.quantity,
    sc.quantity_unit,
    sc.retailers,
    sc.min_price,
    sc.currency,
    sc.available,
    sc.match_type,
    (
      (public.catalog_search_weights() ->> sc.match_type)::integer
      + case when sc.available then (public.catalog_search_weights() ->> 'bonus_available')::integer else 0 end
      + case when sc.retailer_count > 1 then (public.catalog_search_weights() ->> 'bonus_multi_retailer')::integer else 0 end
      + case when sc.quantity is not null and v_query like '%' || public.catalog_number_key(sc.quantity) || '%'
             then (public.catalog_search_weights() ->> 'bonus_quantity')::integer else 0 end
    )::integer as relevance_score
    from scored sc
   order by relevance_score desc, sc.popularity desc, sc.canonical_name
   limit v_limit;
end;
$fn$;

comment on function public.search_catalog(text, integer, text[], text[], boolean) is
  'Autocomplete over the catalog. One row per product. p_markets filters hard; p_langs is accepted and ignored.';

revoke all on function public.search_catalog(text, integer, text[], text[], boolean) from public, anon;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean) to authenticated;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean) to service_role;

-- ─── barcode ─────────────────────────────────────────────────────────────────
-- The one lookup that goes nowhere near ranking: a GTIN is an exact key and
-- there is nothing to guess at. The app sends up to three candidate forms of a
-- scanned code (as printed, zero-padded 12 to 13, and stripped 13 to 12) because
-- the same article is filed under different lengths in different places.
create or replace function public.lookup_barcode(p_codes text[], p_langs text[] default null)
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
  select p.canonical_name, p.brand, p.popularity
    from public.catalog_identifiers i
    join public.catalog_products p on p.id = i.product_id
   where i.identifier_type = 'gtin'
     and i.identifier_value = any (p_codes)
   order by p.popularity desc, p.canonical_name
   limit 1;
end;
$fn$;

comment on function public.lookup_barcode(text[], text[]) is
  'Exact GTIN lookup for a scanned barcode. p_langs is accepted and ignored.';

revoke all on function public.lookup_barcode(text[], text[]) from public, anon;
grant execute on function public.lookup_barcode(text[], text[]) to authenticated;
grant execute on function public.lookup_barcode(text[], text[]) to service_role;

-- ─── popularity ──────────────────────────────────────────────────────────────
-- The only number in this schema that a human writes, and the only reason a
-- catalog assembled by machines ends up ordered the way people actually shop.
--
-- Rate limited per user per hour. Not because anybody is expected to attack it,
-- but because the app calls it fire-and-forget and swallows the result: a bug
-- that called it in a loop would be invisible from the client side and would
-- quietly rewrite the ranking for everybody.
create table if not exists public.catalog_bump_limits (
  user_id      text not null,
  window_start timestamptz not null,
  bumps        integer not null default 0,
  primary key (user_id, window_start)
);

comment on table public.catalog_bump_limits is
  'Per-user hourly ceiling on popularity bumps. No policy: nothing but the bump function may read it.';

alter table public.catalog_bump_limits enable row level security;
revoke all on public.catalog_bump_limits from anon, authenticated;

create or replace function public.bump_product_popularity(p_name text, p_maker text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_user   text := public.requesting_user_id();
  v_window timestamptz := date_trunc('hour', now());
  v_bumps  integer;
  v_id     uuid;
begin
  if v_user is null then
    return;
  end if;

  insert into public.catalog_bump_limits (user_id, window_start, bumps)
  values (v_user, v_window, 1)
  on conflict (user_id, window_start) do update set bumps = public.catalog_bump_limits.bumps + 1
  returning bumps into v_bumps;

  if v_bumps > 120 then
    return;
  end if;

  -- Resolution goes through the merge key first, so a bump from any spelling
  -- that folds the same finds the row -- which matters because the name the user
  -- saw came from search_catalog and may have been a retailer's wording.
  select p.id into v_id
    from public.catalog_products p
   where p.merge_key = public.catalog_merge_key(p_maker, p_name, p.quantity, p.quantity_unit)
   order by p.popularity desc
   limit 1;

  -- Then the name as written, for a product whose quantity we never parsed.
  if v_id is null then
    select p.id into v_id
      from public.catalog_products p
     where public.catalog_normalize(p.canonical_name) = public.catalog_normalize(p_name)
       and (p_maker is null or public.catalog_normalize(coalesce(p.brand, '')) = public.catalog_normalize(p_maker))
     order by p.popularity desc
     limit 1;
  end if;

  -- Finally the words a retailer used, which is what the dropdown may have shown.
  if v_id is null then
    select l.product_id into v_id
      from public.catalog_listings l
     where public.catalog_normalize(l.retailer_name) = public.catalog_normalize(p_name)
     order by l.last_seen_at desc
     limit 1;
  end if;

  if v_id is not null then
    update public.catalog_products set add_count = add_count + 1 where id = v_id;
  end if;
end;
$fn$;

comment on function public.bump_product_popularity(text, text) is
  'Record that somebody added this product to a list. Capped at 120 per user per hour. Never called by the scraper.';

revoke all on function public.bump_product_popularity(text, text) from public, anon;
grant execute on function public.bump_product_popularity(text, text) to authenticated;
