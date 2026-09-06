-- ─── which shops carry these, by name ────────────────────────────────────────
-- A shopping list row knows a name and a maker and nothing else. It is a row in
-- the APP's database, written when somebody added it, and it has no idea the
-- catalog exists -- which is correct, and is why a list still works with no
-- catalog configured at all.
--
-- So showing which shop a listed product came from needs a lookup, and a lookup
-- for a whole list at once rather than one per row: a list of twenty items would
-- otherwise be twenty round trips on every load.
--
-- WHY NOT search_catalog. It is a ranked text search built to answer a
-- half-typed word with the best few matches. This is the opposite question --
-- exact names, all of them, no ranking -- and asking a search engine for an
-- exact match twenty times is both slower and less accurate than asking for the
-- rows themselves.
--
-- WHY NOT A COLUMN ON THE APP'S shopping_items. Because it would be a copy that
-- goes stale the moment a shop drops the product, and because the two databases
-- are deliberately not joined: the app's list survives the catalog being
-- unreachable, and a column would make that survival a lie.
--
-- Matching mirrors bump_product_popularity: the folded canonical name first,
-- then the folded name a RETAILER used, because the row on the list was very
-- often picked out of a dropdown showing a shop's own wording rather than ours.
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
    -- The product's own name.
    select a.folded, p.id
      from asked a
      join public.catalog_products p
        on public.catalog_normalize(p.canonical_name) = a.folded
    union
    -- Or the name a shop used for it, which is what the dropdown showed.
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
     order by m.folded, p.popularity desc, p.canonical_name
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
