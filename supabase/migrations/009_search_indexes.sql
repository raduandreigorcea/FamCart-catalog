-- ─── the folded columns, indexed ─────────────────────────────────────────────
-- Everything here was fast at 444 products and is a full table scan at 100,000.
-- Nothing about the QUERIES was wrong; there was simply no index that matched
-- what they ask for, so Postgres read every row and ran unaccent on it.
--
-- The measured cost before this file, against 121,151 products and 147,725
-- listings: catalog_shops_for 3.4s for one name and 3.4s for forty, which is
-- the signature of a scan that never looks at its input. bump_product_popularity
-- the same. Both are on the path of an ordinary shopping list.
--
-- catalog_normalize() is declared immutable, which is what makes an index on it
-- legal. That declaration is a small lie -- unaccent resolves through a
-- dictionary that a superuser could reload -- and it is a lie this schema has
-- already told: catalog_products.merge_key carries a unique index and is built
-- out of the same fold. Reloading the dictionary means reindexing, and nothing
-- here reloads it.

-- The product's own name, folded. Read by catalog_shops_for, by
-- bump_product_popularity's second lookup, and by the exact and prefix rungs of
-- search_catalog.
--
-- TWO INDEXES ON ONE EXPRESSION, and the second is not redundant. The default
-- operator class answers `=` and nothing else: `like 'lapte%'` needs
-- text_pattern_ops, because in any collation but C the btree ordering is not the
-- byte ordering a prefix match walks.
create index if not exists catalog_products_name_folded
  on public.catalog_products (public.catalog_normalize(canonical_name));
create index if not exists catalog_products_name_folded_prefix
  on public.catalog_products (public.catalog_normalize(canonical_name) text_pattern_ops);

-- The wording a SHOP used, folded. The second half of catalog_shops_for and of
-- bump_product_popularity: the name on a shopping list was very often picked out
-- of a dropdown showing a retailer's own spelling rather than ours.
create index if not exists catalog_listings_retailer_name_folded
  on public.catalog_listings (public.catalog_normalize(retailer_name));

-- The merge key WITHOUT its size segment.
--
-- bump_product_popularity asks "is there a product whose merge key is the one
-- this name and maker would produce, at that product's own size" -- and phrased
-- that way the size is unknowable, so the old query compared against an
-- expression built from each row's own quantity and could use no index at all.
--
-- The size segment is redundant in that comparison: a row's merge_key is built
-- by catalog_products_derive() from that same row's quantity, so the third
-- segment matches by construction and only the first two decide anything. Both
-- folds strip '|' (catalog_key_fold keeps [a-z0-9%] and spaces;
-- catalog_canonical_quantity emits digits, letters and '-'), so a merge key has
-- exactly three segments and split_part cannot mis-slice one.
create index if not exists catalog_products_merge_identity
  on public.catalog_products (split_part(merge_key, '|', 1), split_part(merge_key, '|', 2));

-- ─── LIKE metacharacters are data ────────────────────────────────────────────
-- Pulled out of search_catalog, where the same three nested replaces were
-- written five times. A user typing "100%" must search for a hundred percent,
-- not for "anything"; a user typing "cafea_" must not match "cafea3".
create or replace function public.catalog_like_escape(p_text text)
returns text
language sql
immutable
as $fn$
  select replace(replace(replace(coalesce(p_text, ''), '\', '\\'), '%', '\%'), '_', '\_')
$fn$;

comment on function public.catalog_like_escape(text) is
  'Escape a string for use inside a LIKE pattern. The default backslash escape.';

revoke all on function public.catalog_like_escape(text) from public, anon, authenticated;

-- ─── search, with the trigram index actually reachable ───────────────────────
-- Same signature, same rungs, same weights. What changes is how the candidate
-- pool is gathered.
--
-- WHY THE OLD SHAPE COULD NOT USE THE INDEX. The candidates were selected with
-- three OR'd branches: the whole query as a substring, every token as a
-- substring, and the fuzzy match. The second is a correlated sublink and the
-- third is a parameter Postgres cannot fold, and an OR is only indexable when
-- EVERY branch is. So the gin_trgm index on search_blob -- which has been there
-- since 002 and is exactly the right index -- was never opened, and every
-- keystroke read all 100,000 rows.
--
-- WHY DROPPING THE FIRST BRANCH CHANGES NOTHING. It was already contained in the
-- second: v_query is the tokens joined by single spaces, so a blob holding the
-- whole query holds each of its tokens. Branch one OR branch two is branch two.
--
-- WHAT MAKES THE REST INDEXABLE. The longest token becomes a plain top-level
-- AND, on its own, in its own conjunct -- that is the one the planner can hand
-- to the trigram index. The remaining tokens stay as a recheck, and pick the
-- longest because a trigram index has nothing to say about a token under three
-- characters and the longest token is the most selective one available.
--
-- THE CAP CAN NO LONGER DROP AN EXACT MATCH, and that was a real defect rather
-- than a consequence of this change. `limit 500` over a scan takes 500 rows in
-- whatever order the heap yields them; a query matching 3,000 products kept an
-- arbitrary 500 and ranked those, so the name_exact and name_prefix rungs -- the
-- top two, the ones the weights exist to guarantee -- could be thrown away
-- before the ranking ever ran. They are now gathered first, by their own
-- indexes, and unioned with the capped pool.
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
      -- The top rung, by the equality index.
      (select p.id
         from public.catalog_products p
        where public.catalog_normalize(p.canonical_name) = v_query
        limit 50)
      union
      -- The second rung, by the text_pattern_ops index.
      (select p.id
         from public.catalog_products p
        where public.catalog_normalize(p.canonical_name) like v_like || '%'
        limit 100)
      union
      -- Everything else, capped. Unordered on purpose: an ORDER BY here would
      -- force the whole match set to be materialised and sorted before the cap,
      -- which for a two-character query is every row in the table. The two rungs
      -- that must not be lost are already gathered above.
      (select p.id
         from public.catalog_products p
        where p.search_blob like v_anchor
          and p.search_blob like all (v_pats)
        limit 500)
    ) c;

  -- Opt-in, and a separate statement rather than a fourth branch: p_fuzzy is a
  -- parameter, so as a WHERE clause it would sit in the plan being evaluated per
  -- row on every non-fuzzy call, which is every call the app makes.
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
    -- The two folds every rung below tests against, computed once per candidate
    -- rather than five times. unaccent is a dictionary lookup, and this used to
    -- run it about 2,500 times per keystroke.
    select p.*,
           public.catalog_normalize(p.canonical_name) as folded_name,
           public.catalog_normalize(coalesce(p.brand, '')) as folded_brand
      from public.catalog_products p
     where p.id = any (v_ids)
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
           count(distinct l.retailer_id) as retailer_count,
           -- The shop filter, as a flag rather than another where clause. It
           -- has to be computed over the WHOLE shelf: narrowing the rows first
           -- would drop the other shops out of `retailers` and out of
           -- `min_price`, and those stay whole on purpose (see the header of 005).
           bool_or(r.slug = any (coalesce(p_retailers, '{}'))) as has_wanted
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
        when c.folded_name = v_query                                                  then 'name_exact'
        when c.folded_name like v_like || '%'                                         then 'name_prefix'
        when c.folded_brand = v_query                                                 then 'brand_exact'
        when c.folded_name like all (v_pats)                                          then 'name_tokens'
        when c.folded_brand like v_like || '%'                                        then 'brand_prefix'
        when c.search_blob like all (v_pats)                                          then 'blob_tokens'
        when c.search_blob like '%' || v_like || '%'                                  then 'blob_substring'
        else 'fuzzy'
      end as match_type,
      s.retailer_count
      from candidates c
      join shelf s on s.product_id = c.id
     where p_retailers is null or s.has_wanted
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

-- The five-argument version, dropped rather than left alongside. `create or
-- replace` does not replace a function whose argument list changed -- it adds an
-- OVERLOAD -- and PostgREST resolves an RPC by the argument names in the body,
-- so two candidates matching the same body is an ambiguity it answers with a
-- 300, not a choice. The app would see that as the catalog being down.
drop function if exists public.search_catalog(text, integer, text[], text[], boolean);

comment on function public.search_catalog(text, integer, text[], text[], boolean, text[]) is
  'Autocomplete over the catalog. One row per product. p_markets and p_retailers filter hard; p_langs is accepted and ignored.';

revoke all on function public.search_catalog(text, integer, text[], text[], boolean, text[]) from public, anon;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean, text[]) to authenticated;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean, text[]) to service_role;

-- ─── which shops carry these, made deterministic ─────────────────────────────
-- The body is 008's, with one column added to the ORDER BY.
--
-- `distinct on (folded)` keeps whichever row sorts first, and the sort key was
-- (folded, popularity desc, canonical_name). Three products with the same folded
-- name, the same popularity and the same wording tie on all of it, and which one
-- wins then depends on the order the rows arrive in -- which is the plan, which
-- the indexes above have just changed. It showed up as the same shopping list
-- reporting a different maker for a product after this migration, with the same
-- name and the same shops.
--
-- The id is arbitrary as a tiebreak, but arbitrary and FIXED is the property
-- that matters: the badge under a list row must not change because the planner
-- changed its mind.
create or replace function public.catalog_shops_for(p_names text[])
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
    -- Capped, and folded once here rather than per row of a join. A list is
    -- normally under fifty items; the cap is against a caller that sends its
    -- whole history.
    select distinct public.catalog_normalize(n) as folded
      from unnest(p_names[1:200]) as n
     where public.catalog_normalize(n) <> ''
  ),
  matched as (
    -- The product's own name. Answered by catalog_products_name_folded.
    select a.folded, p.id
      from asked a
      join public.catalog_products p
        on public.catalog_normalize(p.canonical_name) = a.folded
    union
    -- Or the name a shop used for it, which is what the dropdown showed.
    -- Answered by catalog_listings_retailer_name_folded.
    select a.folded, l.product_id
      from asked a
      join public.catalog_listings l
        on public.catalog_normalize(l.retailer_name) = a.folded
  ),
  best as (
    -- One product per asked name. Popularity breaks a tie the same way search
    -- does, so the answer here agrees with the row the person actually saw.
    select distinct on (m.folded) m.folded, m.id
      from matched m
      join public.catalog_products p on p.id = m.id
     order by m.folded, p.popularity desc, p.canonical_name, p.id
  )
  select p.canonical_name,
         p.brand,
         coalesce(
           (select array_agg(distinct r.slug order by r.slug)
              from public.catalog_listings l
              join public.catalog_retailers r on r.id = l.retailer_id and r.enabled
             where l.product_id = p.id),
           '{}'::text[]
         )
    from best b
    join public.catalog_products p on p.id = b.id;
end;
$fn$;

comment on function public.catalog_shops_for(text[]) is
  'Which shops carry each of these products, by name. One call for a whole shopping list.';

revoke all on function public.catalog_shops_for(text[]) from public, anon;
grant execute on function public.catalog_shops_for(text[]) to authenticated;
grant execute on function public.catalog_shops_for(text[]) to service_role;

-- ─── the popularity bump, off the sequential scan ────────────────────────────
-- Only the first lookup changes, and only in how it is phrased. See the comment
-- on catalog_products_merge_identity above for why comparing the first two
-- segments is the same question as comparing the whole key.
--
-- It is worth fixing even though the app calls it fire-and-forget and ignores
-- the answer: unwatched or not, it was a full scan of the products table every
-- time anybody put anything on a shopping list, on the same small instance the
-- next keystroke has to search.
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
   where split_part(p.merge_key, '|', 1) = public.catalog_key_fold(p_maker)
     and split_part(p.merge_key, '|', 2) = public.catalog_key_fold(public.catalog_strip_quantity(p_name))
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
