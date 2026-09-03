-- ─── the one way rows get in ─────────────────────────────────────────────────
-- catalog_import_products() is the only writer this catalog has, and everything
-- that adds a product goes through it: the curated seed importer today, the Open
-- Food Facts discovery function later. There is deliberately no second path.
--
-- WHY AN RPC RATHER THAN supabase-js .upsert()
--
-- Three reasons, and each of them is a bug that a client-side upsert produces
-- silently rather than loudly.
--
--   1. THE MERGE KEY IS NOT KNOWABLE BY THE CALLER. normalized_name is computed
--      by a trigger from a fold the client cannot execute (catalog_normalize is
--      revoked from every client role, on purpose). A client cannot name the row
--      it means to update.
--   2. A PRODUCT IS FOUR TABLES. Name, aliases, identifiers and provenance have
--      to land together or not at all — a product whose GTIN was written and
--      whose name was not is worse than no product. One statement per table from
--      the client is four chances to end up half-written.
--   3. IDENTITY IS RESOLVED, NOT SUPPLIED. A GTIN match beats a name match
--      (§12), so which existing row an incoming product belongs to is a query,
--      not something the caller knows.
--
-- WHAT IT GUARANTEES
--
--   * add_count is never written. Earned popularity survives every re-import,
--     including one that renames the product.
--   * Curated wins. A non-curated source may fill in a blank on a curated row —
--     a missing barcode, a missing image — and may never change its name, brand
--     or editorial weight. That is what makes the seed a floor rather than a
--     starting guess.
--   * Evidence accumulates rather than replacing. markets are unioned, aliases
--     and identifiers are added, quality_tier can only improve. A thinner
--     second source never makes the catalog worse.
--   * It is idempotent. Running it twice changes nothing the second time, which
--     is §26's requirement and is asserted in the pgTAP suite rather than hoped
--     for.
--   * One bad row costs one row. Each is applied in its own subtransaction and a
--     failure is reported back in `errors` rather than rolling back the import.
--     A single malformed record out of Open Food Facts must not lose the other
--     forty-nine.

-- Dropped first because the argument list gains p_concept_id and `create or
-- replace` cannot add a parameter. PostgREST resolves an RPC by the argument
-- NAMES in the body, so an existing two-argument call still binds to this and
-- the seed importer needs no change.
drop function if exists public.catalog_import_products(jsonb, text);

create or replace function public.catalog_import_products(
  p_rows       jsonb,
  p_source     text,
  -- Which concept these rows answer to, when the caller knows.
  --
  -- The discovery function does know: the query that found them resolved to a
  -- concept before the external call was made, so attributing the results is
  -- evidence rather than a guess -- somebody typed `apa`, this came back, and it
  -- passed the relevance filter. The seed importer passes nothing, because
  -- commercial-ro.json says nothing about concepts and inferring one from the
  -- string "Apa Plata 2L" is the confident wrong merge S15 forbids.
  --
  -- NEVER OVERWRITES an attribution that already exists. A row can be returned
  -- by searches for two different concepts, and the first one to claim it is no
  -- worse a guess than the second; churning the column would make a product's
  -- concept depend on who searched last.
  p_concept_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r        jsonb;
  a        jsonb;
  g        text;
  v_id     uuid;
  v_norm   text;
  v_gtins  text[];
  v_markets text[];
  v_curated boolean;
  v_name_taken boolean;
  v_generic boolean;

  n_ins    integer := 0;
  n_upd    integer := 0;
  n_skip   integer := 0;
  n_alias  integer := 0;
  n_ident  integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if p_source is null or p_source not in
     ('curated', 'openfoodfacts', 'openproductsfacts', 'openbeautyfacts', 'user') then
    raise exception 'catalog_import_products: unknown source %', p_source;
  end if;

  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    begin
      v_norm := public.catalog_normalize(r->>'name', r->>'brand');

      -- §10: no usable name is the one rejection that needs no further thought.
      if v_norm = '' then
        n_skip := n_skip + 1;
        v_errors := v_errors || jsonb_build_object('row', r, 'error', 'no usable name');
        continue;
      end if;

      v_gtins := coalesce(
        array(select jsonb_array_elements_text(coalesce(r->'gtins', '[]'::jsonb))), '{}'
      );
      v_markets := coalesce(
        array(select jsonb_array_elements_text(coalesce(r->'markets', '[]'::jsonb))), '{}'
      );

      -- ── identity ──────────────────────────────────────────────────────────
      -- §12's order, and only its first two rungs. A GTIN is exact; a folded
      -- name is strong. Everything below that in the specification's list —
      -- brand plus similar name, compatible quantity — is a JUDGEMENT, and a
      -- judgement made here would merge two products with no way to undo it.
      -- Uncertain stays separate (§15). Two rows are a cosmetic problem; a
      -- wrong merge destroys a product.
      v_id := null;

      if array_length(v_gtins, 1) is not null then
        select ci.product_id into v_id
        from public.catalog_identifiers ci
        where ci.identifier_type = 'gtin'
          and ci.identifier_value = any (v_gtins)
        limit 1;
      end if;

      if v_id is null then
        select p.id into v_id
        from public.catalog_products p
        where p.normalized_name = v_norm;
      end if;

      -- ── insert ────────────────────────────────────────────────────────────
      if v_id is null then
        insert into public.catalog_products (
          product_type, canonical_name, name_lang, brand, category,
          markets, quantity, quantity_unit, image_url, quality_tier, base_weight,
          concept_id
        ) values (
          coalesce(r->>'type', 'commercial'),
          btrim(r->>'name'),
          coalesce(r->>'lang', 'en'),
          nullif(btrim(coalesce(r->>'brand', '')), ''),
          nullif(r->>'category', ''),
          v_markets,
          nullif(r->>'quantity', '')::numeric,
          nullif(r->>'unit', ''),
          nullif(r->>'image_url', ''),
          coalesce(r->>'tier', 'C'),
          -- Editorial weight is the seed's alone. An external source that could
          -- set it could outrank every curated staple on day one.
          case when p_source = 'curated' then coalesce((r->>'weight')::integer, 0) else 0 end,
          p_concept_id
        )
        returning id, product_type = 'generic' into v_id, v_generic;
        n_ins := n_ins + 1;

      -- ── update ────────────────────────────────────────────────────────────
      else
        select exists (
          select 1 from public.catalog_sources s
          where s.product_id = v_id and s.source_name = 'curated'
        ) into v_curated;

        -- A rename reached through a GTIN match can collide with a DIFFERENT
        -- product's merge key — two packs relabelled into one name upstream.
        -- Renaming into it would abort the import with a unique violation and
        -- lose the batch; keeping the old name loses nothing at all, because the
        -- GTIN already points where it should.
        select exists (
          select 1 from public.catalog_products p
          where p.normalized_name = v_norm and p.id <> v_id
        ) into v_name_taken;

        update public.catalog_products p set
          -- Curated wins, and a taken name is never stolen.
          canonical_name = case
            when (v_curated and p_source <> 'curated') or v_name_taken then p.canonical_name
            else coalesce(nullif(btrim(r->>'name'), ''), p.canonical_name)
          end,
          name_lang = case
            when (v_curated and p_source <> 'curated') or v_name_taken then p.name_lang
            else coalesce(nullif(r->>'lang', ''), p.name_lang)
          end,
          brand = case
            when v_curated and p_source <> 'curated' then p.brand
            else coalesce(nullif(btrim(coalesce(r->>'brand', '')), ''), p.brand)
          end,
          -- Blanks may always be filled in, by anybody. This is the half of
          -- "curated wins" that people forget: a curated row with no image and
          -- no barcode is improved by Open Food Facts knowing them, and refusing
          -- that would freeze the seed at whatever was known the day it was
          -- written.
          category      = coalesce(p.category, nullif(r->>'category', '')),
          quantity      = coalesce(p.quantity, nullif(r->>'quantity', '')::numeric),
          quantity_unit = coalesce(p.quantity_unit, nullif(r->>'unit', '')),
          image_url     = coalesce(p.image_url, nullif(r->>'image_url', '')),
          -- Unioned, never replaced. A source that only knows about France must
          -- not erase the evidence that the product is also sold in Romania.
          markets = case
            when v_markets = '{}' then p.markets
            else array(select distinct unnest(p.markets || v_markets) order by 1)
          end,
          -- 'A' < 'B' < 'C', so least() is "the best tier anyone has claimed".
          -- A thinner second source cannot demote a product.
          quality_tier = least(p.quality_tier, coalesce(r->>'tier', 'C')),
          base_weight = case
            when p_source = 'curated' then coalesce((r->>'weight')::integer, p.base_weight)
            else p.base_weight
          end,
          -- A blank may be filled, a claim is never restated. Same rule as
          -- category and image_url above.
          concept_id = coalesce(p.concept_id, p_concept_id)
          -- add_count is absent from this SET list on purpose. It is the one
          -- column an import may never touch: it is what real people earned.
        where p.id = v_id
        returning (p.product_type = 'generic') into v_generic;
        n_upd := n_upd + 1;
      end if;

      -- ── aliases ───────────────────────────────────────────────────────────
      -- Added, never replaced (§16). `on conflict do nothing` against
      -- catalog_aliases_unique is what makes a re-run free, and against
      -- catalog_aliases_one_name_per_lang it is what stops a second source
      -- quietly renaming the Romanian name of a product somebody already named.
      for a in select value from jsonb_array_elements(coalesce(r->'aliases', '[]'::jsonb))
      loop
        if nullif(btrim(coalesce(a->>'alias', '')), '') is not null then
          insert into public.catalog_aliases (product_id, alias, lang, alias_type)
          values (
            v_id,
            btrim(a->>'alias'),
            nullif(a->>'lang', ''),
            coalesce(a->>'type', 'synonym')
          )
          on conflict do nothing;
          if found then n_alias := n_alias + 1; end if;
        end if;
      end loop;

      -- ── identifiers ───────────────────────────────────────────────────────
      -- A GTIN already claimed by another product is left alone rather than
      -- moved. Two products disagreeing about one barcode is a fact about the
      -- upstream data, and the first claim is the one with evidence behind it.
      --
      -- A GENERIC ROW NEVER TAKES ONE. It is a shopping concept, not a pack:
      -- 'Feta' is what somebody writes on a list, and no barcode identifies it.
      -- The name rung above cannot tell the two apart, because Open Food Facts
      -- holds real packs named exactly 'Feta', 'Parmesan' and 'Spaghetti'; those
      -- fold onto the curated concept and used to hand it their codes. Eleven
      -- feta packs then all resolved through lookup_barcode() to the concept,
      -- so a scan answered with the word rather than the thing in your hand.
      -- Dropping the code costs nothing: the merge itself is still right, and
      -- the product keeps its own row upstream to be discovered on its name.
      if not v_generic then
        foreach g in array v_gtins
        loop
          if g ~ '^[0-9]{8,14}$' then
            insert into public.catalog_identifiers (product_id, identifier_value, source)
            values (v_id, g, p_source)
            on conflict do nothing;
            if found then n_ident := n_ident + 1; end if;
          end if;
        end loop;
      end if;

      -- ── provenance ────────────────────────────────────────────────────────
      -- Not bookkeeping: Open Food Facts is ODbL, so which rows came from it is
      -- a licensing fact about this table.
      -- FALLING BACK TO THE FOLDED NAME IS WHAT MAKES A RE-RUN FREE. The unique
      -- index on (source_name, source_product_id) is partial — it does not cover
      -- null ids — so a provenance row with no upstream id conflicts with
      -- nothing and a second import appends a duplicate instead of updating.
      -- Every source of ours does supply an id, but the one that forgets would
      -- fail silently and only in the row count. normalized_name is unique, so
      -- it is a serviceable id for a source that has none of its own.
      insert into public.catalog_sources (
        product_id, source_name, source_product_id, source_url, source_updated_at
      ) values (
        v_id, p_source,
        coalesce(nullif(r->>'source_id', ''), v_norm),
        nullif(r->>'source_url', ''),
        case when nullif(r->>'source_updated_at', '') is null then null
             else (r->>'source_updated_at')::timestamptz end
      )
      on conflict (source_name, source_product_id) where source_product_id is not null
      do update set
        product_id        = excluded.product_id,
        source_url        = coalesce(excluded.source_url, catalog_sources.source_url),
        source_updated_at = coalesce(excluded.source_updated_at, catalog_sources.source_updated_at),
        imported_at       = now();

      -- Corroboration is a ranking signal (§23), so it is counted rather than
      -- assumed: recomputed from the provenance rows that actually exist.
      update public.catalog_products p
         set source_count = greatest(1, (
               select count(distinct s.source_name)
               from public.catalog_sources s
               where s.product_id = v_id
             ))
       where p.id = v_id
         and p.source_count is distinct from greatest(1, (
               select count(distinct s.source_name)
               from public.catalog_sources s
               where s.product_id = v_id
             ));

    exception when others then
      -- One bad row costs one row. Without this a single malformed record out of
      -- an external source rolls back everything imported alongside it.
      n_skip := n_skip + 1;
      v_errors := v_errors || jsonb_build_object(
        'row', coalesce(r->>'name', '(unnamed)'),
        'error', sqlerrm
      );
    end;
  end loop;

  return jsonb_build_object(
    'source',            p_source,
    'inserted',          n_ins,
    'updated',           n_upd,
    'skipped',           n_skip,
    'aliases_added',     n_alias,
    'identifiers_added', n_ident,
    -- Bounded, because an import of thousands of broken rows would otherwise
    -- return a payload larger than the import itself.
    'errors',            (select jsonb_agg(e) from (
                            select e from jsonb_array_elements(v_errors) e limit 25
                          ) t)
  );
end;
$$;

-- No client role may call this, ever. It is SECURITY DEFINER and it writes the
-- global catalog; the seed importer and the discovery function both hold the
-- service-role key and that is the whole intended audience.
revoke all on function public.catalog_import_products(jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.catalog_import_products(jsonb, text, uuid) to service_role;
