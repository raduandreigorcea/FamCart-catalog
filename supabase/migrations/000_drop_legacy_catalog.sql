-- ─── the old catalog, removed ────────────────────────────────────────────────
-- THE ONE MIGRATION HERE THAT IS A REAL INCREMENT RATHER THAN A RESTATEMENT.
--
-- Every other file in this directory describes the schema as it SHOULD BE and is
-- written to be re-runnable. This one cannot be: it exists because a database
-- that already holds the previous catalog cannot be brought to the new shape by
-- restating the new shape at it.
--
-- The reason is the trap the app repo's CLAUDE.md warns about, in its sharpest
-- form. 002 says `create table if not exists public.catalog_products`, and a
-- database carrying the OLD catalog already has a table by that name -- with
-- product_type, name_lang, markets, quality_tier and an alias table hanging off
-- it. `if not exists` would skip the create silently, every later statement would
-- run against the wrong columns, and the result would be a half-migrated catalog
-- that reports success.
--
-- So the old world is dropped first, and this file sorts before 001 to guarantee
-- it happens first. It is the same shape as 000_rename_families_to_households.sql
-- in the app repo, and for the same reason.
--
-- WHAT IT DELIBERATELY DOES NOT DROP: catalog_admins. That table is who is
-- allowed to use the dashboard, it is identical in both schemas, and dropping it
-- would lock the owner out of the project the migration is being run against.
--
-- GUARDED, so it is a no-op everywhere it has already run and on every fresh
-- database. `catalog_concepts` is the marker: it existed only in the old schema
-- and is not recreated by anything here, so its presence means "this database is
-- still the old one" and its absence means there is nothing to do. Without that
-- guard, re-running this file against the NEW catalog would drop a working
-- catalog and every scrape that filled it.

do $$
declare
  v_legacy boolean;
  v_name   text;
  v_args   text;
begin
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'catalog_concepts'
  ) into v_legacy;

  if not v_legacy then
    raise notice 'no legacy catalog here; nothing to drop';
    return;
  end if;

  raise notice 'legacy catalog found: dropping it';

  -- Functions FIRST, and by iterating pg_proc rather than by naming signatures.
  --
  -- The old schema had upwards of twenty functions and several were overloaded
  -- (search_catalog had a four- and a five-argument form). A `drop function`
  -- listing signatures by hand misses whichever overload somebody added last and
  -- leaves it behind, still granted, still callable, now pointed at tables that
  -- no longer exist.
  for v_name, v_args in
    select p.proname, pg_get_function_identity_arguments(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (
         p.proname like 'catalog\_%'
         or p.proname in ('search_catalog', 'lookup_barcode', 'bump_product_popularity')
       )
       -- The identity layer stays: 001 restates these and they are shared with
       -- the admin list this file is preserving.
       and p.proname not in ('catalog_is_admin', 'requesting_user_id')
  loop
    execute format('drop function if exists public.%I(%s) cascade', v_name, v_args);
  end loop;

  -- Then the tables. cascade because the old satellites carry foreign keys into
  -- catalog_products, and the order they come off is not worth encoding.
  drop table if exists public.catalog_search_cache cascade;
  drop table if exists public.catalog_concept_terms cascade;
  drop table if exists public.catalog_concepts cascade;
  drop table if exists public.catalog_sources cascade;
  drop table if exists public.catalog_aliases cascade;
  drop table if exists public.catalog_identifiers cascade;
  drop table if exists public.catalog_products cascade;
  -- Same name and same shape in both schemas, but it holds one row per user per
  -- hour and none of it is worth carrying across a rebuild.
  drop table if exists public.catalog_bump_limits cascade;

  -- NOT dropped: public.catalog_admins.
end;
$$;
