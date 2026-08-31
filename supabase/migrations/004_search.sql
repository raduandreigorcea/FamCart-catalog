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

    -- Reach rather than precision: this row belongs to the concept the query
    -- named, but its own name matched nothing. Below every rung that means the
    -- product was actually named, above the one that means it merely sits on
    -- the right shelf. See the rungs CTE in search_catalog for why it cannot go
    -- higher without breaking generic concepts.
    'concept',        45,

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
-- the database, and it is also what lets this call catalog_concept_resolve().
--
-- The cost of definer is that RLS does not run inside the body. That costs
-- nothing here: every row in this catalog is readable by every signed-in user,
-- so there is no row-level decision to lose. It would matter a great deal in the
-- app database, where the same function is scoped to a household.
--
-- ─── what the concept layer changed, and what it did not ─────────────────────
--
-- The ladder above is untouched. What 007 added is a question asked BEFORE the
-- ladder runs — "what does this word mean?" — and two consequences that follow
-- from the answer:
--
--   1. REACH. A product attributed to the resolved concept is relevant even
--      when its name contains none of the query. `Borsec 2L` is a water and
--      does not contain the string "apa" anywhere, so no amount of substring
--      matching will ever find it; concept membership is the only thing that
--      can. That is why the rung exists.
--
--   2. ORDER, for BRANDED concepts only. Somebody typing `apa`, `deodorant` or
--      `detergent` is choosing among commercial products, and a generic row is
--      a placeholder that answers nothing — a list saying "Apă" makes whoever
--      is holding it guess. So under a branded concept a generic row sinks
--      below every commercial one. It is never hidden, because the rule this
--      whole file is built around is that the dropdown must not go empty.
--
-- INTENT IS A SEPARATE SORT KEY, NOT POINTS, and that is deliberate. The
-- bonuses below are all smaller than the gap between two rungs, on purpose, so
-- that a nearby readable row can never overtake a better match. Intent has to
-- do exactly what the bonuses may not: the generic `Apă` matches an alias
-- exactly and scores 90, while `Apa Plata 2L` merely prefix-matches and scores
-- 80. Expressing "generic loses here" as points would mean a demotion larger
-- than a rung, which would corrupt the one invariant the ladder has. So it sits
-- outside the score, as the first ORDER BY key, where it is also far easier to
-- explain: two lists, commercial first, each internally ranked as always.
--
-- Dropped first because both the argument list and the return shape change, and
-- `create or replace` can do neither. A four-argument call still binds to this:
-- PostgREST resolves an RPC by the argument names in the body, so the app is
-- unaffected by the new columns and can project the three it wants with
-- `select=`.
drop function if exists public.search_catalog(text, integer, text[], text[]);
drop function if exists public.search_catalog(text, integer, text[], text[], boolean);

create or replace function public.search_catalog(
  p_query   text,
  p_limit   integer default 100,
  p_markets text[] default null,
  p_langs   text[] default null,
  p_fuzzy   boolean default false
)
returns table (
  name       text,
  maker      text,
  popularity integer,
  -- ─── why the result explains itself ────────────────────────────────────────
  -- Ranking bugs in this file do not look like bugs. They look like a catalog
  -- that does not stock something: `apa` returning onions read as bad data for
  -- weeks, and `beer` returning strawberries was written down as a curiosity
  -- rather than recognised as the same bug. Both were immediately obvious the
  -- moment the rung was visible.
  --
  -- Always populated rather than gated behind a flag, because a debug path that
  -- runs a different query from the real one is a debug path that lies. These
  -- are all computed by the ranking anyway; the client projects the three
  -- columns it wants with PostgREST's `select=` and pays nothing for the rest.
  match_type      text,
  matched_concept text,
  -- The intent, handed back so the CLIENT can decide whether discovery is worth
  -- asking for at all. Without it `cartofi` costs an edge-function round trip
  -- that can only ever answer "a generic concept is already answered" -- no
  -- external call, but a cold start and a wait, on the commonest kind of query
  -- there is. One column removes it.
  concept_intent  text,
  matched_alias   text,
  category_match  boolean,
  language_match  boolean,
  market_match    boolean,
  relevance_score integer
)
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
  v_word_pats text[];
  v_lang    text := nullif(p_langs[1], '');

  -- What the word MEANS, and whether the bare word is buyable. Null for most
  -- queries — a brand, a package size, a product nobody has named — and a null
  -- concept costs nothing: every branch below falls back to exactly the
  -- behaviour this function had before 007.
  v_concept uuid;
  v_intent  text;
  v_slug    text;

  -- ─── the short-token rule ──────────────────────────────────────────────────
  -- At or below this length, a token must match at the START OF A WORD. Above
  -- it, a match anywhere in the blob still counts.
  --
  -- WHY A LENGTH AND NOT A BLANKET RULE. `search_blob` holds every alias in six
  -- languages, which makes a short query astonishingly likely to land in the
  -- middle of an unrelated word. Searching "apa" (water) returned potatoes and
  -- onions in production, and both were correct substring matches:
  --
  --     Potatoes -> potatoes cartofi ... p-APA-s patatas patate
  --     Onions   -> onions ce-APA cebollas cipolle ...
  --     razors   -> APA-rate de ras de unica folosinta gillette
  --
  -- It is the same coincidence as `beer` finding Erd-BEER-en and Heidel-BEER-en,
  -- which was documented as a curiosity and is really this bug. Four characters
  -- catches both.
  --
  -- Above four, a mid-word match is usually the point rather than an accident:
  -- German compounds are the clear case, where "wasser" has to keep reaching
  -- Mineral-WASSER and Sprudel-WASSER, and "detergent" reaching a longer product
  -- name is what anyone would expect. So the rule is deliberately narrow — it
  -- fixes the queries that produce garbage and leaves the rest alone.
  short_token constant integer := 4;
begin
  -- Fold the query exactly as the stored names were folded, so "Apă" and "apa"
  -- are one search. There is one authority for that fold and this is a caller
  -- of it, not a second copy.
  v_query := public.catalog_normalize(coalesce(p_query, ''), null);
  if v_query = '' then
    return;
  end if;

  -- What does this word mean? Exact match only — see catalog_concept_resolve()
  -- for why a fuzzy resolution would be worse than none.
  v_concept := public.catalog_concept_resolve(p_query, v_lang);
  if v_concept is not null then
    select c.intent, c.slug into v_intent, v_slug
      from public.catalog_concepts c
     where c.id = v_concept;
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

  -- One pattern per SHORT token, anchored to the start of a word.
  --
  -- No regex: search_blob is space-separated folded text, so "starts a word" is
  -- exactly "preceded by a space" once a leading space is prepended to the blob
  -- below. That reuses the LIKE escaping established above rather than
  -- introducing a second escaping language whose metacharacters differ — a
  -- folded quantity like "0.5l" carries a dot that means "any character" in a
  -- regex and nothing at all in a LIKE.
  select array_agg(
           '% ' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         )
    into v_word_pats
  from (
    select tok
    from regexp_split_to_table(v_query, '\s+') as tok
    where tok <> '' and char_length(tok) <= short_token
    limit max_tokens
  ) t;

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
    -- Members of the resolved concept. This is REACH rather than precision: it
    -- is the only way a product whose name contains none of the query can be
    -- found at all. Capped like the blob branch and for the same reason.
    (
      select p.id
      from public.catalog_products p
      where v_concept is not null and p.concept_id = v_concept
      order by p.popularity desc
      limit max_candidates
    )
    union
    (
      select p.id
      from public.catalog_products p
      where p.search_blob like v_primary
        and p.search_blob like all (v_rest)
        -- Null when every token was long enough to be trusted anywhere.
        and (v_word_pats is null or (' ' || p.search_blob) like all (v_word_pats))
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
      p.product_type,
      (p.concept_id is not null and p.concept_id = v_concept) as in_concept,
      -- ─── intent, as its own sort key ──────────────────────────────────────
      -- Only 'branded' moves anything, and only generic rows. A generic concept
      -- leaves the ladder alone (nobody typing `morcovi` wants a brand), and so
      -- does a mixed one (`lapte` should return both, ordered by how well they
      -- matched). One rule, one direction, and every other query behaves
      -- exactly as it did before this file knew what a concept was.
      (case
         when v_concept is null then 0
         -- ─── a row nobody can shop from sinks to the bottom ───────────────
         --
         -- A COMMERCIAL row whose entire name is the concept's own word and
         -- which carries no brand at all. Open Food Facts is full of these --
         -- a barcode, the word "Pâine", and nothing else -- and they are the
         -- worst rows in the catalog in the position that matters most,
         -- because `name_exact` scores 100 and beats every real product.
         --
         -- Searching "paine" put five of them above `Pâine albă feliată` by
         -- Dobrogea. They are not merely unhelpful: they are indistinguishable
         -- from the generic concept while claiming to be a product, so the
         -- dropdown shows the same word four times and the person cannot tell
         -- which one to pick.
         --
         -- THE NAME TEST IS WHAT MAKES THIS SAFE. "brand is null" alone would
         -- also demote `Cartofi Albi 2.5kg` and `Oua Marimea M 10 buc`, which
         -- are curated rows carrying a real package size and no maker. Only a
         -- name that is EXACTLY one of the concept's own words qualifies.
         when p.product_type = 'commercial'
              and p.brand is null
              and exists (
                select 1 from public.catalog_concept_terms t
                 where t.concept_id = v_concept
                   and t.normalized_term = p.normalized_name
              ) then 2
         -- The generic placeholder under a branded concept. Below real
         -- products, but above the commercial duplicates of itself: at least
         -- this one is honestly a concept and carries six languages.
         when v_intent = 'branded' and p.product_type = 'generic' then 1
         else 0
       end) as intent_rank,
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
      al.hit_alias,
      coalesce(al.cat_hit, false) as cat_hit,
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
        -- Reached through a category name. Reported rather than scored: it is
        -- the difference between "this product is a drink" and "this product is
        -- called that", and confusing the two is what once returned Eggs for a
        -- search for milk.
        bool_or(a.alias_type = 'category'
                and a.normalized_alias like v_primary
                and a.normalized_alias like all (v_rest))                                 as cat_hit,
        -- Which string actually did it, for the explanation. Exact first, then
        -- prefix, so the reported alias is the strongest one rather than
        -- whichever the planner reached first.
        coalesce(
          (array_agg(a.alias) filter (
            where a.alias_type in ('name', 'synonym') and a.normalized_alias = v_query))[1],
          (array_agg(a.alias) filter (
            where a.alias_type in ('name', 'synonym') and a.normalized_alias like v_prefix))[1]
        )                                                                                 as hit_alias,
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
  rungs as (
    -- ─── which rung, named ────────────────────────────────────────────────
    -- The rung is chosen as a LABEL and the score is looked up from it, rather
    -- than the two being computed separately. That is what makes the reported
    -- match_type and the number it sorts by incapable of disagreeing — an
    -- explanation that can drift from the ranking is worse than no explanation,
    -- because it is believed.
    select
      f.*,
      case
        when f.name_only = v_query or f.name_only || ' ' || coalesce(f.brand_only, '') = v_query
          then 'name_exact'
        when f.alias_exact                                   then 'alias_exact'
        when f.name_only like v_prefix                       then 'name_prefix'
        when f.alias_prefix                                  then 'alias_prefix'
        when f.name_only like v_primary
             and f.name_only like all (v_rest)               then 'name_tokens'
        when f.brand_only is not null
             and (f.brand_only = v_query
                  or f.brand_only like v_prefix)             then 'brand_match'
        when f.alias_tokens                                  then 'alias_tokens'
        -- ─── concept membership sits LOW, and deliberately ────────────────
        -- It is reach, not precision. Every rung above it means the product was
        -- actually NAMED by what was typed; this one means only that it belongs
        -- to the right idea. Placed any higher, an attributed water would
        -- outrank a product whose own name matched the query — and for a
        -- GENERIC concept it would push the generic row (which is the correct
        -- answer to `morcovi`) below a commercial one. Above blob_only because
        -- "this IS a water" beats "this is filed under drinks".
        when f.in_concept                                    then 'concept'
        -- Reached through a category name and nothing else. Still returned —
        -- a shelf query is a real query — but never above a product that was
        -- actually named.
        else 'blob_only'
      end as match_type
    from facts f
  ),
  scored as (
    select
      r.*,
      (r.markets && p_markets)                              as market_hit,
      (v_lang is not null and coalesce(r.reads_it, false))  as lang_hit,
      (
        (w ->> r.match_type)::int
        +
        -- MARKET DEMOTES, IT NEVER FILTERS. A hard filter would give a household
        -- in a thin market an empty dropdown indistinguishable from "we have
        -- never heard of that product", which is the worst failure a search box
        -- has. An unknown market scores between a hit and a miss, because
        -- missing country metadata is extremely common in honest external data
        -- and is not evidence that the product is unavailable.
        case
          when p_markets is null or cardinality(p_markets) = 0 then 0
          when r.markets && p_markets                          then (w->>'market_hit')::int
          when cardinality(r.markets) = 0                      then (w->>'market_unknown')::int
          else 0
        end
        +
        case when v_lang is not null and r.reads_it then (w->>'lang_hit')::int else 0 end
        +
        case r.quality_tier
          when 'A' then (w->>'tier_a')::int
          when 'B' then (w->>'tier_b')::int
          else 0
        end
      ) as score
    from rungs r
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
  select
    s.display_name,
    s.brand,
    s.popularity,
    s.match_type,
    v_slug,
    v_intent,
    s.hit_alias,
    s.cat_hit,
    coalesce(s.lang_hit, false),
    coalesce(s.market_hit, false),
    s.score
  from scored s
  where s.readable or not exists (select 1 from scored r2 where r2.readable)
  -- INTENT FIRST. Under a branded concept this splits the result into two
  -- lists — real products, then the generic placeholder — and inside each the
  -- order is exactly what it always was. See the header for why this is a sort
  -- key rather than points.
  order by
    s.intent_rank,
    s.score desc,
    -- Popularity is the TIE-BREAK, not part of the score. §23: it must never
    -- override exact relevance, and folded into the score it would — add_count
    -- is unbounded and the rungs are ten apart.
    s.popularity desc,
    s.display_name
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
  -- NOTE that the concept layer does not change this and must not. A concept
  -- resolving tells us the word is real; it says nothing about whether a row
  -- resembling it is the row that was wanted. `champu` resolves to no concept
  -- at all, which is exactly the point.
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
      p.popularity,
      'fuzzy'::text,
      v_slug,
      v_intent,
      null::text,
      false,
      false,
      false,
      (w->>'fuzzy')::int
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
