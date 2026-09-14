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

-- ─── search and the shop badges ──────────────────────────────────────────────
-- search_catalog and catalog_shops_for LIVE IN 014, ALONE, with their comments
-- and grants. 009 rewrote both -- the trigram index made reachable, the exact
-- and prefix rungs gathered before the cap, and a fixed tiebreak on the badge
-- lookup -- and 014 made both answer per country. They moved rather than being
-- restated, for the reason migrations.test.ts gives.

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
