-- ─── what the app actually calls ─────────────────────────────────────────────
-- Three functions, and they are a CONTRACT rather than an implementation
-- detail. src/lib/productSuggestions.ts calls all three by name over PostgREST,
-- with these argument names and expecting these column names back:
--
--   search_catalog(p_query, p_limit, p_markets, p_langs) -> (name, maker, popularity)
--   lookup_barcode(p_codes)                              -> (name, maker, popularity)
--   bump_product_popularity(p_name, p_maker)             -> void
--
-- PostgREST resolves an RPC by the argument NAMES in the request body, so
-- renaming one here breaks the app with nothing in this repository to warn you.
-- The app owns none of this schema, exactly as it owns none of Clerk's; what it
-- owns is the shape of these three calls.
--
-- `maker` rather than `brand`, and `name` rather than `canonical_name`, because
-- that is what the app database's own search_catalog() returns and the client
-- merges the two result sets into one list. Two column names for one concept
-- would mean the merge silently dropped half its rows.
--
-- ─── the ranking, and why it is a ladder rather than a score ─────────────────
--
-- Spec §17 asks for an explainable order and explicitly not "an opaque 100 point
-- system". So the order is decided in two separate steps that never mix:
--
--   1. WHERE the query matched. This is a ladder of mutually exclusive rungs —
--      an exact name beats an exact alias beats a prefix beats a token match
--      beats a brand beats a category. A row sits on exactly one rung and you
--      can always say which.
--   2. Everything else — market, language, data quality — as small bonuses that
--      are DELIBERATELY SMALLER THAN THE GAP BETWEEN TWO RUNGS. A nearby,
--      readable, high-quality row can never overtake a row that matched better.
--      Relevance is not tradeable against location.
--
-- Popularity is not in the score at all. It is the tie-break, one ORDER BY key
-- below it, because §23 is explicit: popularity must never override exact
-- relevance. Folded into the score it would dominate immediately — add_count is
-- unbounded and the rungs are ten points apart.
--
-- THE PROBLEM THIS SOLVES, concretely. Every product carries its category's name
-- in six languages so that a query for a shelf ("lactate", "Getränke") fills the
-- dropdown. The cost is that "milch" matches the blob of all fifteen dairy
-- products through "Milchprodukte", and before this ranking existed a search for
-- milk returned Eggs first. Milk's German alias puts it on rung 90; Eggs matched
-- through a category name alone and sits on rung 10. Widening reach and ordering
-- results are two different jobs, and this file is the second one.

-- ─── the weights ─────────────────────────────────────────────────────────────
-- Declared once, here, as the only place any of these numbers appear.
--
-- NOT A SETTINGS TABLE, though §17 asks for configurable weights. A table would
-- add a read to the hot path of every keystroke, and — the real objection — it
-- would let the ranking change without a code review or a test run. A migration
-- is the right amount of friction for "which product comes first". Changing a
-- number here and running the pgTAP suite tells you immediately what moved.
create or replace function public.catalog_search_weights()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    -- The ladder. Ten apart, so no combination of bonuses can cross a rung.
    'name_exact',    100,  -- the query IS this product's name
    'alias_exact',    90,  -- ...or one of its names in another language
    'name_prefix',    80,  -- "bana" -> "Banana"
    'alias_prefix',   70,  -- "bana" -> "Banane"
    'name_tokens',    60,  -- every word is in the name, in any order
    'brand_match',    50,  -- "persil" -> everything Persil makes
    'alias_tokens',   40,  -- every word is in one of its other names
    'blob_only',      10,  -- matched through a category name and nothing else
    'fuzzy',           5,  -- nothing matched at all; this is the closest thing

    -- The bonuses. Sum to at most 9, which is less than 10 on purpose.
    'market_hit',      4,  -- sold where the searcher is
    'market_unknown',  2,  -- nobody has said where it is sold; not the same as "nowhere"
    'lang_hit',        3,  -- has a name the searcher can read
    'tier_a',          2,
    'tier_b',          1
  );
$$;

comment on function public.catalog_search_weights() is
  'The search ranking, in one place. Read by search_catalog(); exposed so the admin dashboard can show why a result ordered as it did.';

revoke all on function public.catalog_search_weights() from public, anon;
grant execute on function public.catalog_search_weights() to authenticated;

-- ─── search ──────────────────────────────────────────────────────────────────
-- SECURITY DEFINER, and not for the writes — this only reads. Tokenizing the
-- query means calling catalog_normalize(), and EXECUTE on that is revoked from
-- every client role because a client that can compute the merge key can craft a
-- name that collides with an existing product's. Definer keeps the fold inside
-- the database.
--
-- The cost of definer is that RLS does not run inside the body. That costs
-- nothing here: every row in this catalog is readable by every signed-in user,
-- so there is no row-level decision to lose. It would matter a great deal in the
-- app database, where the same function is scoped to a household.
-- Dropped first because the argument list changes, and `create or replace`
-- cannot add a parameter. A four-argument call still binds to this: PostgREST
-- resolves an RPC by the argument names in the body, so the app is unaffected.
drop function if exists public.search_catalog(text, integer, text[], text[]);

create or replace function public.search_catalog(
  p_query   text,
  p_limit   integer default 100,
  p_markets text[] default null,
  p_langs   text[] default null,
  p_fuzzy   boolean default false
)
returns table (name text, maker text, popularity integer)
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  -- Bounded so a pasted paragraph cannot become a hundred-way AND. Six is
  -- already far more words than anyone types into an add-item box.
  max_tokens     constant integer := 6;
  -- How many blob matches are scored. A cap is needed because the scoring joins
  -- the alias table per row, and a one-token query against a growing catalog
  -- would otherwise score everything. Ordered by popularity, so what falls off
  -- the end is the least-used tail — and the exact matches are pulled in
  -- separately below precisely so this cap can never hide one.
  max_candidates constant integer := 500;

  w         jsonb   := public.catalog_search_weights();
  v_limit   integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_query   text;
  v_patterns text[];
  v_primary text;
  v_rest    text[];
  v_prefix  text;
  v_lang    text := nullif(p_langs[1], '');
begin
  -- Fold the query exactly as the stored names were folded, so "Apă" and "apa"
  -- are one search. There is one authority for that fold and this is a caller
  -- of it, not a second copy.
  v_query := public.catalog_normalize(coalesce(p_query, ''), null);
  if v_query = '' then
    return;
  end if;

  -- Escaping matters even after folding. catalog_normalize lowercases and strips
  -- accents but leaves % and _ alone, so without this a typed underscore matches
  -- any character and a typed % matches the entire catalog.
  select array_agg(
           '%' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           order by char_length(tok) desc
         )
    into v_patterns
  from (
    select tok
    from regexp_split_to_table(v_query, '\s+') as tok
    where tok <> ''
    limit max_tokens
  ) t;

  if v_patterns is null then
    return;
  end if;

  -- Longest token first: it is the most selective and the one the trigram index
  -- drives from. The rest filter what it returns. Written as one indexable LIKE
  -- plus a quantified ALL rather than an AND chain built by string
  -- concatenation, so no SQL is assembled from user input at all.
  v_primary := v_patterns[1];
  v_rest    := v_patterns[2:];
  v_prefix  := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with candidates as (
    -- Exact matches first and WITHOUT the cap. A product whose name is exactly
    -- what was typed has to be in the result even if five hundred more popular
    -- rows also mention the word — which is the one thing max_candidates could
    -- otherwise take away, and the failure would look like the catalog simply
    -- not having the product.
    select p.id from public.catalog_products p where p.normalized_name = v_query
    union
    select a.product_id from public.catalog_aliases a where a.normalized_alias = v_query
    union
    (
      select p.id
      from public.catalog_products p
      where p.search_blob like v_primary
        and p.search_blob like all (v_rest)
      order by p.popularity desc
      limit max_candidates
    )
  ),
  facts as (
    select
      p.id,
      p.canonical_name,
      p.brand,
      p.popularity,
      p.markets,
      p.quality_tier,
      -- The name without the brand. normalized_name has the brand folded into
      -- it (it is the merge key), so "pepsi zero 500ml" would never equal
      -- "pepsi zero 500ml pepsi" and an exact search for a product's own name
      -- would miss it.
      public.catalog_normalize(p.canonical_name, null) as name_only,
      public.catalog_normalize(p.brand, null)          as brand_only,
      al.alias_exact,
      al.alias_prefix,
      al.alias_tokens,
      al.reads_it,
      -- CAN THIS PERSON READ THIS PRODUCT'S NAME? Two ways to qualify: the name
      -- is natively in their language (a Romanian shop line), or the product
      -- carries an explicit name in it (a generic concept, translated six ways).
      -- A null language means the question was not asked, and everything passes.
      (v_lang is null or p.name_lang = v_lang or coalesce(al.reads_it, false)) as readable,
      -- The name to hand back: this searcher's language if the product has one,
      -- the canonical otherwise. This is what the aliases table is FOR — a
      -- Romanian phone asked for "lapte" and should not be told "Milk".
      coalesce(loc.alias, p.canonical_name) as display_name
    from candidates c
    join public.catalog_products p on p.id = c.id
    left join lateral (
      select
        -- Only real names and synonyms count as a match on the product. A
        -- category name is how the row was REACHED, never why it is relevant.
        bool_or(a.alias_type in ('name', 'synonym') and a.normalized_alias = v_query)     as alias_exact,
        bool_or(a.alias_type in ('name', 'synonym') and a.normalized_alias like v_prefix) as alias_prefix,
        bool_or(a.alias_type in ('name', 'synonym')
                and a.normalized_alias like v_primary
                and a.normalized_alias like all (v_rest))                                 as alias_tokens,
        -- Language relevance: does this product have a name the searcher reads?
        bool_or(a.alias_type = 'name' and a.lang = v_lang)                                as reads_it
      from public.catalog_aliases a
      where a.product_id = p.id
    ) al on true
    left join lateral (
      select a.alias
      from public.catalog_aliases a
      where a.product_id = p.id and a.alias_type = 'name' and a.lang = v_lang
      limit 1
    ) loc on true
  ),
  scored as (
    select
      f.display_name,
      f.brand,
      f.popularity,
      f.readable,
      (
        case
          when f.name_only = v_query or f.name_only || ' ' || coalesce(f.brand_only, '') = v_query
            then (w->>'name_exact')::int
          when f.alias_exact                                   then (w->>'alias_exact')::int
          when f.name_only like v_prefix                       then (w->>'name_prefix')::int
          when f.alias_prefix                                  then (w->>'alias_prefix')::int
          when f.name_only like v_primary
               and f.name_only like all (v_rest)               then (w->>'name_tokens')::int
          when f.brand_only is not null
               and (f.brand_only = v_query
                    or f.brand_only like v_prefix)             then (w->>'brand_match')::int
          when f.alias_tokens                                  then (w->>'alias_tokens')::int
          -- Reached through a category name and nothing else. Still returned —
          -- a shelf query is a real query — but never above a product that was
          -- actually named.
          else (w->>'blob_only')::int
        end
        +
        -- MARKET DEMOTES, IT NEVER FILTERS. A hard filter would give a household
        -- in a thin market an empty dropdown indistinguishable from "we have
        -- never heard of that product", which is the worst failure a search box
        -- has. An unknown market scores between a hit and a miss, because
        -- missing country metadata is extremely common in honest external data
        -- and is not evidence that the product is unavailable.
        case
          when p_markets is null or cardinality(p_markets) = 0 then 0
          when f.markets && p_markets                          then (w->>'market_hit')::int
          when cardinality(f.markets) = 0                      then (w->>'market_unknown')::int
          else 0
        end
        +
        case when v_lang is not null and f.reads_it then (w->>'lang_hit')::int else 0 end
        +
        case f.quality_tier
          when 'A' then (w->>'tier_a')::int
          when 'B' then (w->>'tier_b')::int
          else 0
        end
      ) as score
    from facts f
  )
  -- ─── language FILTERS, where market only demotes ─────────────────────────
  --
  -- The asymmetry is deliberate and not an inconsistency. Market says whether
  -- you could BUY a thing; language says whether you can READ it. A product sold
  -- in the next country is still a useful suggestion -- you might find it, or a
  -- local equivalent -- but "Pâte à tartiner aux noisettes et au cacao" offered
  -- to somebody using the app in Romanian is not a suggestion at all. It is
  -- noise they have to read past.
  --
  -- Every row in the curated seed is readable in all six languages, so this
  -- changes nothing about the seed. It exists for what DISCOVERY brings back:
  -- Open Food Facts files a product under whatever language its record was
  -- written in, and those arrive with no translation at all.
  --
  -- ...BUT NEVER DOWN TO AN EMPTY DROPDOWN, which is the rule this whole file is
  -- built around. A hard filter would break it: brand-and-size names like
  -- "Nutella 400g" or "Pepsi Zero 500ml" are readable by anyone and still carry
  -- whatever language the source filed them under, so filtering them
  -- unconditionally would hide exactly the products people search for by name.
  --
  -- So the filter yields when it would leave nothing. The subquery asks whether
  -- ANY match was readable -- not whether any survived the limit -- so the
  -- fallback triggers on "we have nothing you can read for this word", which is
  -- precisely when a foreign name beats an empty list.
  select s.display_name, s.brand, s.popularity
  from scored s
  where s.readable or not exists (select 1 from scored r where r.readable)
  -- Popularity is the TIE-BREAK, not part of the score. §23: it must never
  -- override exact relevance, and folded into the score it would — add_count is
  -- unbounded and the rungs are ten apart.
  order by s.score desc, s.popularity desc, s.display_name
  limit v_limit;

  -- ─── rung 6: fuzzy, off by default, and LAST ─────────────────────────────
  --
  -- §17 lists a fuzzy match and §28 asks for typos to work. Three of its four
  -- examples need nothing from this: a truncation is a PREFIX, so "banan"
  -- reaches Banana and "peps" reaches Pepsi through the ladder above. What the
  -- ladder cannot do is a TRANSPOSITION — "zreo" for "zero", "sampoo" for
  -- "sampon" — because every rung up there is ultimately a substring test.
  --
  -- ─── why it defaults to OFF, which was learned the hard way ───────────────
  --
  -- This used to run automatically whenever the strict pass found nothing, and
  -- that was fine while the catalog held a generic concept for every common
  -- word: "nothing matched" then really did mean "you have made a typo".
  --
  -- Removing the concepts nobody can shop from (Shampoo, Beer, Coffee) changed
  -- what an empty result MEANS. It now usually means "the catalog does not
  -- stock this yet" — and answering that with the nearest string produced,
  -- measured against the real catalog:
  --
  --     beer       -> Beef
  --     champu     -> Ciuperci Champignon
  --     toothpaste -> Toothbrush
  --
  -- No threshold fixes it. `sampoo`→`Sampon` and `champu`→`Champiñones` both
  -- score 0.714 on word_similarity; `detergnet`→`Detergent` and `beer`→`Beef`
  -- both score 0.429 on the strict variant. A typo and a real word the catalog
  -- happens not to hold are the same shape, and no similarity measure can tell
  -- them apart, because the difference is whether the word exists in a language
  -- rather than whether it resembles something.
  --
  -- So the ORDER was wrong, not the threshold. An empty result should send the
  -- caller to discovery, which goes and finds real beer; only if THAT also comes
  -- back empty is "here is the nearest thing we have" a reasonable last word.
  -- p_fuzzy is how a caller asks for that last word, and nothing on the
  -- keystroke path asks for it.
  --
  -- word_similarity() reads backwards from what you would expect:
  -- word_similarity(query, haystack) asks how well the query resembles some WORD
  -- SEQUENCE inside the haystack, rather than the haystack as a whole. That is
  -- the right question — search_blob is a long string and whole-string
  -- similarity against it is near zero for every product.
  --
  -- CALLED AS A FUNCTION, NOT AS THE `<%` OPERATOR, and the difference costs an
  -- index. `<%` is what pg_trgm's gin index can answer, but it compares against
  -- pg_trgm.word_similarity_threshold, which defaults to 0.6 and rejects
  -- "sampoo" against "sampon" — the exact case §28 asks for. Pinning that GUC on
  -- the function is the obvious fix and does not work on hosted Supabase: the
  -- migration role may not set the parameter, so `create function ... set
  -- pg_trgm.word_similarity_threshold` fails with "permission denied to set
  -- parameter" on deploy while succeeding locally, where the session happens to
  -- have pg_trgm loaded.
  --
  -- So the threshold is written out and this pass is a sequential scan. That is
  -- affordable because it runs ONLY when the strict search found nothing, which
  -- is the one moment there is no result to be slow for. If the catalog ever
  -- grows enough for it to hurt, the fix is not to reach for the GUC again — it
  -- is to accept 0.6 and use `<%`, losing "sampoo" and keeping the index.
  if p_fuzzy and not found then
    return query
    select
      coalesce(loc.alias, p.canonical_name),
      p.brand,
      p.popularity
    from public.catalog_products p
    left join lateral (
      select a.alias
      from public.catalog_aliases a
      where a.product_id = p.id and a.alias_type = 'name' and a.lang = v_lang
      limit 1
    ) loc on true
    where extensions.word_similarity(v_query, p.search_blob) >= 0.42
    order by extensions.word_similarity(v_query, p.search_blob) desc,
             p.popularity desc,
             p.canonical_name
    limit v_limit;
  end if;
end;
$$;

revoke all on function public.search_catalog(text, integer, text[], text[], boolean) from public, anon;
grant execute on function public.search_catalog(text, integer, text[], text[], boolean) to authenticated;
-- Also service_role, purely so a deploy can be checked. `node
-- catalog/scripts/seed.mjs --verify` runs a handful of real searches against the
-- project it just wrote to, and without this grant the one credential that can
-- load the catalog cannot ask whether the load worked.
--
-- It widens nothing. service_role already reads every row of every table here
-- directly; a read-only function computed from those same rows tells it nothing
-- it could not select for itself. The grants that matter are the two NOT given:
-- catalog_normalize(), because the merge key must stay uncomputable outside the
-- database, and bump_product_popularity(), because a ranking must only ever move
-- for a real person with a real session.
grant execute on function public.search_catalog(text, integer, text[], text[], boolean) to service_role;

-- ─── barcode ─────────────────────────────────────────────────────────────────
-- A barcode is an exact key, so this goes nowhere near the blob, the ranking or
-- the fold. §25 is explicit: never fuzzy-match a barcode. There is nothing to
-- rank and nothing to guess at, and a near miss on a scan is a wrong product in
-- somebody's basket.
--
-- Takes an ARRAY because the app's barcodeCandidates() expands one scan into the
-- equivalent encodings — a UPC-A read as EAN-13 carries a leading zero, and the
-- printed code and the stored one can differ by it. All of them are exact keys;
-- none of them is a guess.
--
-- p_langs is optional and the app does not currently pass it, which is why it
-- has a default: PostgREST resolves an RPC by the argument names in the body, so
-- a call with p_codes alone still binds here. When the app starts sending it, a
-- scan will come back in the scanner's language with no migration.
create or replace function public.lookup_barcode(
  p_codes text[],
  p_langs text[] default null
)
returns table (name text, maker text, popularity integer)
language plpgsql
security definer
stable
set search_path = public, extensions
as $$
declare
  v_lang text := nullif(p_langs[1], '');
begin
  if p_codes is null or cardinality(p_codes) = 0 then
    return;
  end if;

  return query
  select
    coalesce(loc.alias, p.canonical_name),
    p.brand,
    p.popularity
  from public.catalog_identifiers ci
  join public.catalog_products p on p.id = ci.product_id
  left join lateral (
    select a.alias
    from public.catalog_aliases a
    where a.product_id = p.id and a.alias_type = 'name' and a.lang = v_lang
    limit 1
  ) loc on true
  where ci.identifier_type = 'gtin'
    and ci.identifier_value = any (p_codes)
  -- One product per barcode is a unique index, so more than one row here means
  -- the scan matched several of the expanded encodings. The most-used product
  -- is the right answer to "which of these is the one on the shelf".
  order by p.popularity desc
  limit 1;
end;
$$;

revoke all on function public.lookup_barcode(text[], text[]) from public, anon;
grant execute on function public.lookup_barcode(text[], text[]) to authenticated;
grant execute on function public.lookup_barcode(text[], text[]) to service_role;

-- ─── learning ────────────────────────────────────────────────────────────────
-- What makes the catalog get better on its own: a product added to a real list
-- by a real person climbs.
--
-- RESOLVED BY NAME, not by id, because the app never sees an id. It got a name
-- and a maker back from search_catalog() and that is what it can send — and the
-- name it got back may be a LOCALIZED one, so a Romanian household bumping
-- "Lapte" has to reach the row whose canonical name is "Milk". Matching the
-- alias table is not a nicety here; without it every bump from a non-English
-- phone would silently count for nothing.
--
-- Fire-and-forget from the client: it never raises, and a name that matches
-- nothing is a no-op rather than an error. An add that already succeeded must
-- not surface a failure on top of it.

-- The ceiling, and its bookkeeping.
--
-- Without one, any signed-in client can drive any product to the top of every
-- search by calling this in a loop. That is worth a table: ranking is the whole
-- product here, and it is the one thing a client can write to at all.
create table if not exists public.catalog_bump_limits (
  user_id      text        not null,
  -- Truncated to the hour, so the row IS the window. No expiry job: an old row
  -- is simply never read again, and the table is small enough that it can be
  -- cleared by hand if it ever is not.
  window_start timestamptz not null,
  bumps        integer     not null default 0,
  primary key (user_id, window_start)
);

alter table public.catalog_bump_limits enable row level security;

-- No policy at all, and that is the point: RLS with no policy denies everything.
-- The table is written only by bump_product_popularity(), which is SECURITY
-- DEFINER and therefore not subject to it. A client that could read this could
-- learn how close it was to the limit; a client that could write it could raise
-- its own ceiling.
revoke all on public.catalog_bump_limits from anon, authenticated;

create or replace function public.bump_product_popularity(
  p_name  text,
  p_maker text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- 120 an hour is far above any real use — a household adding two products a
  -- minute for an hour — and far below what it takes to move a ranking.
  hourly_cap constant integer := 120;

  v_user   text := public.requesting_user_id();
  v_window timestamptz := date_trunc('hour', now());
  v_norm   text;
  v_name   text;
  v_id     uuid;
  v_bumps  integer;
begin
  if v_user is null then
    return;
  end if;

  v_norm := public.catalog_normalize(p_name, p_maker);
  v_name := public.catalog_normalize(p_name, null);
  if v_name = '' then
    return;
  end if;

  -- The merge key first, then the name alone, then the aliases. Same order as
  -- the search ladder, and for the same reason: the most specific evidence
  -- about which product was meant wins.
  select p.id into v_id from public.catalog_products p where p.normalized_name = v_norm;

  if v_id is null then
    select p.id into v_id from public.catalog_products p
    where public.catalog_normalize(p.canonical_name, null) = v_name
    order by p.popularity desc
    limit 1;
  end if;

  if v_id is null then
    select a.product_id into v_id
    from public.catalog_aliases a
    join public.catalog_products p on p.id = a.product_id
    where a.normalized_alias = v_name
      and a.alias_type in ('name', 'synonym')
    order by p.popularity desc
    limit 1;
  end if;

  -- A name this catalog has never heard of. Not an error: the product came from
  -- the household's own contributions in the app database, which has its own
  -- copy of this function and its own row to credit.
  if v_id is null then
    return;
  end if;

  insert into public.catalog_bump_limits (user_id, window_start, bumps)
  values (v_user, v_window, 1)
  on conflict (user_id, window_start)
  do update set bumps = public.catalog_bump_limits.bumps + 1
  returning bumps into v_bumps;

  -- Over the ceiling: the counter still climbed, so the window does not reset
  -- by continuing to hammer it, but the product does not move.
  if v_bumps > hourly_cap then
    return;
  end if;

  update public.catalog_products
     set add_count = add_count + 1
   where id = v_id;
end;
$$;

revoke all on function public.bump_product_popularity(text, text) from public, anon;
grant execute on function public.bump_product_popularity(text, text) to authenticated;
