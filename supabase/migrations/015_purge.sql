-- ─── removing what a shop files outside groceries ────────────────────────────
-- The catalog held what the shops' sitemaps held, and a supermarket's sitemap is
-- also a clothes shop, a garden centre and an electronics store: t-shirts,
-- flowers, televisions, drones. A shopping list wants none of it. The scrapers
-- now read each shop's own department for every product and stop importing the
-- ones outside groceries; this is how what was ALREADY imported goes.
--
-- NOTHING ELSE IN THIS SCHEMA DELETES, and that stays true of the sweep: absence
-- from a run only ever sets available = false. This is different in kind. It
-- acts on POSITIVE EVIDENCE -- the scraper saw the product, on the shop's own
-- site, in a department that is not groceries -- so it is safe whatever the run
-- concludes, and it names exactly the listings it removes. Nothing is inferred.
--
-- A product goes with its listings only when no other listing is left. The same
-- article sold as groceries by one shop and filed under "promotions" by another
-- stays, with the shop that sells it. A product created by hand in the admin has
-- no listings and is never reached from here.
create or replace function public.catalog_purge_listings(p_external_ids text[], p_retailer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_retailer_id      uuid;
  v_products         uuid[];
  v_listings_deleted integer := 0;
  v_products_deleted integer := 0;
begin
  select id into v_retailer_id from public.catalog_retailers where slug = p_retailer;
  if v_retailer_id is null then
    raise exception 'unknown retailer: %', p_retailer using errcode = 'P0001';
  end if;

  if p_external_ids is null or cardinality(p_external_ids) = 0 then
    return jsonb_build_object('listings_deleted', 0, 'products_deleted', 0);
  end if;

  -- catalog_listings_after_change keeps listing_count and the search text of
  -- every product touched here correct, row by row, as it does for any delete.
  with gone as (
    delete from public.catalog_listings l
     where l.retailer_id = v_retailer_id
       and l.external_id = any (p_external_ids)
    returning l.product_id
  )
  select array_agg(distinct g.product_id), count(*)
    into v_products, v_listings_deleted
    from gone g;

  with gone as (
    delete from public.catalog_products p
     where p.id = any (coalesce(v_products, '{}'::uuid[]))
       and not exists (select 1 from public.catalog_listings l where l.product_id = p.id)
    returning 1
  )
  select count(*) into v_products_deleted from gone;

  return jsonb_build_object(
    'listings_deleted', v_listings_deleted,
    'products_deleted', v_products_deleted
  );
end;
$fn$;

comment on function public.catalog_purge_listings(text[], text) is
  'Remove listings a scraper saw filed outside groceries, and any product left with no listing. Positive evidence only.';

revoke all on function public.catalog_purge_listings(text[], text) from public, anon, authenticated;
grant execute on function public.catalog_purge_listings(text[], text) to service_role;
