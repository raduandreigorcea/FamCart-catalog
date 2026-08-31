-- ─── the one way concepts get in ─────────────────────────────────────────────
-- The same shape as catalog_import_products, for the same reasons, and it is
-- worth stating the two that are specific to concepts:
--
--   1. THE FOLD IS NOT KNOWABLE BY THE CALLER. normalized_term is computed by a
--      trigger from catalog_normalize(), which is revoked from every client
--      role. A caller cannot name the term row it means to keep, so it cannot
--      compute the difference between what it is sending and what is stored.
--   2. A CONCEPT IS TWO TABLES that have to move together. A concept whose
--      intent was updated but whose terms were not is a word that now behaves
--      differently and can no longer be found.
--
-- ─── what it guarantees ──────────────────────────────────────────────────────
--
--   * The seed file is the AUTHORITY on a curated concept's terms, in both
--     directions. Adding a translation adds it; removing one removes it. This
--     is deliberately unlike catalog_aliases, where removal needs an explicit
--     prune (006), and the difference is that a concept's terms are a small,
--     hand-authored, complete list rather than evidence accumulated from
--     sources. A term nobody meant to keep is a word silently redirecting
--     somebody's search.
--   * Stable ids. Terms already present are left alone rather than deleted and
--     re-inserted, so re-running the seed churns nothing and created_at stays
--     true.
--   * Idempotent. The second run reports zeroes across the board.
--   * Curated claims the slug. A concept that was minted automatically
--     (origin='discovered') and is later authored by hand becomes 'curated',
--     because a person has now made the decision the machine guessed at.
--   * One bad concept costs one concept, in its own subtransaction, for the
--     same reason the product importer works that way.
--
-- WHAT IT DOES NOT DO: attach products. A concept knows nothing about which
-- rows belong to it; catalog_products.concept_id is written by the backfill and
-- by discovery, and never from here. Keeping the two apart is what lets the
-- concept file be re-run against a live catalog without touching a product.

create or replace function public.catalog_import_concepts(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r         jsonb;
  t         jsonb;
  v_id      uuid;
  v_terms   text[];
  v_existed boolean;

  n_ins     integer := 0;
  n_upd     integer := 0;
  n_skip    integer := 0;
  n_term    integer := 0;
  n_gone    integer := 0;
  v_errors  jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a json array';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    begin
      -- ── the concept itself ──────────────────────────────────────────────
      select id into v_id
        from public.catalog_concepts
       where slug = r->>'slug';

      v_existed := v_id is not null;

      if v_existed then
        update public.catalog_concepts
           set intent      = r->>'intent',
               category    = nullif(r->>'category', ''),
               base_weight = coalesce((r->>'weight')::integer, 0),
               -- A hand-authored concept overrides a machine-minted one. The
               -- reverse never happens: nothing below ever writes 'discovered'
               -- over 'curated'.
               origin      = 'curated'
         where id = v_id;
        n_upd := n_upd + 1;
      else
        insert into public.catalog_concepts (slug, intent, category, base_weight, origin)
        values (
          r->>'slug',
          r->>'intent',
          nullif(r->>'category', ''),
          coalesce((r->>'weight')::integer, 0),
          'curated'
        )
        returning id into v_id;
        n_ins := n_ins + 1;
      end if;

      -- ── the terms ───────────────────────────────────────────────────────
      -- Insert what is missing. `on conflict do nothing` against the
      -- (concept_id, normalized_term, coalesce(lang,'')) unique index is what
      -- makes a re-run free: the trigger folds the term, the index catches the
      -- duplicate, and the existing row keeps its id.
      --
      -- The conflict target is written out rather than named, because an index
      -- on an EXPRESSION cannot be referenced by column list alone.
      --
      -- The count is taken from the statement rather than from the input,
      -- because the input can legitimately contain two strings that fold to one
      -- (a label and a synonym differing only by case) and reporting those as
      -- two insertions would make the summary lie.
      for t in select value from jsonb_array_elements(coalesce(r->'terms', '[]'::jsonb)) loop
        insert into public.catalog_concept_terms (concept_id, term, lang, term_type)
        values (
          v_id,
          t->>'term',
          nullif(t->>'lang', ''),
          coalesce(nullif(t->>'type', ''), 'synonym')
        )
        on conflict (concept_id, normalized_term, coalesce(lang, '')) do nothing;
        if found then
          n_term := n_term + 1;
        end if;
      end loop;

      -- Remove terms the file no longer carries.
      --
      -- THE FOLD HAS TO HAPPEN IN HERE. The caller sends raw strings and the
      -- stored column is folded, so comparing the two outside the database
      -- would delete every accented term on every run and re-insert it — which
      -- would look idempotent in the summary and churn every id.
      --
      -- Only for concepts the file actually described. A concept absent from
      -- p_rows is not touched at all, so importing one file never prunes
      -- another's work.
      select coalesce(array_agg(public.catalog_normalize(value->>'term', null)), '{}')
        into v_terms
        from jsonb_array_elements(coalesce(r->'terms', '[]'::jsonb));

      with removed as (
        delete from public.catalog_concept_terms
         where concept_id = v_id
           and not (normalized_term = any (v_terms))
        returning 1
      )
      select n_gone + count(*) into n_gone from removed;

    exception when others then
      n_skip := n_skip + 1;
      v_errors := v_errors || jsonb_build_object(
        'concept', coalesce(r->>'slug', '(unnamed)'),
        'error', sqlerrm
      );
    end;
  end loop;

  return jsonb_build_object(
    'inserted',      n_ins,
    'updated',       n_upd,
    'skipped',       n_skip,
    'terms_added',   n_term,
    'terms_removed', n_gone,
    'errors',        (select jsonb_agg(e) from (
                        select e from jsonb_array_elements(v_errors) e limit 25
                      ) t)
  );
end;
$$;

comment on function public.catalog_import_concepts(jsonb) is
  'The only writer for the concept layer. Takes the curated file as the authority on a concept intent and its terms, in both directions, and leaves products alone.';

-- No client role may call this, ever. A client that can mint a concept can
-- redirect everybody else's searches and choose which intent applies to a word,
-- which is a larger power than writing a product: intent decides whether the
-- catalog goes and asks an external database at all.
revoke all on function public.catalog_import_concepts(jsonb) from public, anon, authenticated;
grant execute on function public.catalog_import_concepts(jsonb) to service_role;

-- ─── attaching products to concepts ──────────────────────────────────────────
-- Separate from the import above, and separate from catalog_import_products,
-- because attribution has a different authority than either.
--
-- A product's concept comes from EVIDENCE, in descending order of confidence:
-- the seed states it, or the query that discovered the row resolved to it. It
-- is never inferred from the name — deciding that "Lapte de migdale" is milk
-- because the string starts with "lapte" is the confident wrong merge §15
-- forbids, and it would be unpickable afterwards.
--
-- `p_overwrite` defaults false so discovery can attribute a row without ever
-- overriding a curated decision. The backfill passes true, because there the
-- seed IS the authority.
create or replace function public.catalog_attach_concept(
  p_product_ids uuid[],
  p_concept_id  uuid,
  p_overwrite   boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  update public.catalog_products p
     set concept_id = p_concept_id
   where p.id = any (p_product_ids)
     and (p_overwrite or p.concept_id is null);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.catalog_attach_concept(uuid[], uuid, boolean) from public, anon, authenticated;
grant execute on function public.catalog_attach_concept(uuid[], uuid, boolean) to service_role;
