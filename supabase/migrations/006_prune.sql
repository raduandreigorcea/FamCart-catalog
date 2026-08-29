-- ─── taking a curated row back out ───────────────────────────────────────────
-- The seed file is the authority for curated rows, and until now it was only
-- half an authority: adding an entry created a row, removing one left the row
-- behind forever. That drift is silent and cumulative — the file says 188
-- concepts, the database holds 238, and nothing anywhere says which fifty are
-- ghosts.
--
-- This closes it. `node catalog/scripts/seed.mjs --prune` passes the source ids
-- the seed currently contains, and anything curated that is NOT in that list is
-- reported and (with --apply) removed.
--
-- ─── the three guards, and what each one is for ──────────────────────────────
--
-- A function that deletes catalog rows from a list supplied by a caller is the
-- most dangerous thing in this schema, so it is fenced three ways:
--
--   1. AN EMPTY KEEP-LIST IS REFUSED. The obvious catastrophe is a seed loader
--      that fails to read its files, passes [], and truthfully reports that it
--      pruned every curated product in the catalog. There is no legitimate call
--      with an empty list, so it raises instead.
--   2. CURATED-ONLY ROWS. A product Open Food Facts has also seen is not the
--      seed's to delete: the seed may have introduced it, but the row now rests
--      on evidence from somewhere else. Only rows whose ENTIRE provenance is
--      'curated' are eligible.
--   3. NOTHING HAPPENS WITHOUT p_apply. The default is a dry run that returns
--      exactly what it would remove, so the destructive call is always the
--      second one somebody makes.
--
-- Earned popularity is returned alongside each row rather than protecting it.
-- A concept people have actually been adding is worth a second look before it
-- goes, and add_count is the number that tells you — but "this was popular" is
-- not a reason to keep something the seed has deliberately dropped.

-- Withdrawing an experiment. `needs_brand` was added to demote concepts that
-- cannot be shopped from without a brand (Shampoo, Baby formula) below real
-- products. Removing those concepts from the seed entirely turned out to be
-- both what was wanted and strictly simpler — with no row to match, a search
-- for "shampoo" is empty, and an empty local result already means "ask
-- discovery" with no special case anywhere. The column was applied to the
-- deployed project and never reached anything else, so this is a no-op on a
-- fresh database and a cleanup there.
alter table public.catalog_products drop column if exists needs_brand;
alter table public.catalog_products
  drop constraint if exists catalog_products_needs_brand_check;

create or replace function public.catalog_prune_curated(
  p_keep  text[],
  p_apply boolean default false
)
returns table (source_id text, name text, add_count integer, removed boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard 1. See the header: the empty list is the catastrophe.
  if p_keep is null or cardinality(p_keep) = 0 then
    raise exception 'catalog_prune_curated: refusing to prune against an empty keep-list';
  end if;

  return query
  with eligible as (
    select p.id, s.source_product_id, p.canonical_name, p.add_count
    from public.catalog_products p
    join public.catalog_sources s
      on s.product_id = p.id and s.source_name = 'curated'
    where s.source_product_id is not null
      and not (s.source_product_id = any (p_keep))
      -- Guard 2. Corroborated by something other than the seed, so not the
      -- seed's to withdraw.
      and not exists (
        select 1 from public.catalog_sources o
        where o.product_id = p.id and o.source_name <> 'curated'
      )
  ),
  -- Guard 3. The delete is skipped entirely unless asked for, and the CTE is
  -- still evaluated so the report is identical either way.
  gone as (
    delete from public.catalog_products p
    using eligible e
    where p_apply and p.id = e.id
    returning p.id
  )
  select
    e.source_product_id,
    e.canonical_name,
    e.add_count,
    exists (select 1 from gone g where g.id = e.id)
  from eligible e
  order by e.add_count desc, e.canonical_name;
end;
$$;

revoke all on function public.catalog_prune_curated(text[], boolean) from public, anon, authenticated;
grant execute on function public.catalog_prune_curated(text[], boolean) to service_role;
