-- ─── catalog_stats, counted on a schedule instead of on every page load ─────
-- THE ONLY DEFINITION OF catalog_stats. 006 held it until now and carries a
-- note pointing here, so re-pushing 006 cannot put the counting body back.
--
-- WHAT BROKE. The admin Health page showed "catalog_stats: canceling statement
-- due to statement timeout" on 2026-09-15, while the Mega Image run was
-- writing. The old body counted the whole catalog on every call: products,
-- listings, barcodes, and every shop's listings twice. `authenticated` has an
-- 8 second statement_timeout. Measured that morning against 102,700 products
-- and 108,400 listings, the per-shop counts alone took 2,592 ms with a cold
-- cache and 90 ms warm, the same query minutes apart. A scrape in progress is
-- exactly what keeps the cache cold, so the page failed at the moment it was
-- most worth opening.
--
-- THE FIX. Every one of those numbers changes only when a scraper writes, so
-- they are counted into catalog_stats_cache by pg_cron, as postgres, outside
-- any request budget. catalog_stats reads that one row, and reads each shop's
-- last two runs live -- those are index lookups (003's
-- catalog_scrape_runs_retailer_started and _completed), and they are what says
-- a run is failing NOW, so they must not wait for the next count.
--
-- WHY NOT COUNT AT THE END OF catalog_run_complete. It is called through
-- PostgREST under the same 8 second budget, and it holds the sweep. Adding a
-- whole-catalog count to it would trade a red panel on a dashboard for a sweep
-- that times out, which is the one thing in this project that must not fail.
--
-- THE COST. Totals can be up to 15 minutes old, and the page says how old
-- (`counted_at`). A shop's run status and delta are never stale.

create extension if not exists pg_cron with schema pg_catalog;

-- One row, enforced: the primary key is a boolean that must be true.
create table if not exists public.catalog_stats_cache (
  id         boolean primary key default true,
  counted_at timestamptz not null,
  -- products, listings, unavailable, identifiers, with_barcode, with_price,
  -- earned, orphans
  totals     jsonb not null,
  -- { "<slug>": { "listings": n, "available": n } }
  retailers  jsonb not null
);

-- { "<country>": { "products": n, "listings": n, "unavailable": n, "with_barcode": n } }
--
-- Added after the table existed, so it is its own statement: a column declared
-- inside `create table if not exists` reaches new databases only, because the
-- block is skipped where the table is already there.
--
-- For the Scrapers page's country selector. It cannot be summed from
-- `retailers` in the browser: a product two shops in one country both sell is
-- one product there, and only a count over the listings knows that. There is no
-- "sold nowhere" per country -- a product with no listing belongs to none.
alter table public.catalog_stats_cache add column if not exists countries jsonb not null default '{}'::jsonb;

alter table public.catalog_stats_cache drop constraint if exists catalog_stats_cache_single_row;
alter table public.catalog_stats_cache add constraint catalog_stats_cache_single_row check (id);

-- Read only through catalog_stats, which checks for an admin itself.
alter table public.catalog_stats_cache enable row level security;
revoke all on public.catalog_stats_cache from public, anon, authenticated;

create or replace function public.catalog_stats_refresh()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.catalog_stats_cache (id, counted_at, totals, retailers, countries)
  select
    true,
    now(),
    jsonb_build_object(
      'products',     (select count(*) from public.catalog_products),
      'listings',     (select count(*) from public.catalog_listings),
      'unavailable',  (select count(*) from public.catalog_listings where not available),
      'identifiers',  (select count(*) from public.catalog_identifiers),
      'with_barcode', (select count(distinct product_id) from public.catalog_identifiers),
      'with_price',   (select count(distinct product_id) from public.catalog_listings where price is not null),
      'earned',       (select count(*) from public.catalog_products where add_count > 0),
      'orphans',      (select count(*) from public.catalog_products where listing_count = 0)
    ),
    -- One pass over the listings, grouped, rather than two counts per shop.
    coalesce((
      select jsonb_object_agg(r.slug, jsonb_build_object(
               'listings',  coalesce(c.listings, 0),
               'available', coalesce(c.available, 0)))
        from public.catalog_retailers r
        left join (
          select retailer_id, count(*) as listings, count(*) filter (where available) as available
            from public.catalog_listings
           group by retailer_id
        ) c on c.retailer_id = r.id
    ), '{}'::jsonb),
    -- One pass over the listings again, grouped by the shop's country. A
    -- country with no listings is absent rather than a row of zeros.
    coalesce((
      select jsonb_object_agg(c.country, jsonb_build_object(
               'products',     c.products,
               'listings',     c.listings,
               'unavailable',  c.unavailable,
               'with_barcode', c.with_barcode))
        from (
          select r.country,
                 count(distinct l.product_id)                                            as products,
                 count(*)                                                                as listings,
                 count(*) filter (where not l.available)                                 as unavailable,
                 count(distinct l.product_id) filter (where b.product_id is not null)    as with_barcode
            from public.catalog_listings l
            join public.catalog_retailers r on r.id = l.retailer_id
            left join (select distinct product_id from public.catalog_identifiers) b
              on b.product_id = l.product_id
           group by r.country
        ) c
    ), '{}'::jsonb)
  on conflict (id) do update
    set counted_at = excluded.counted_at,
        totals     = excluded.totals,
        retailers  = excluded.retailers,
        countries  = excluded.countries;
end;
$fn$;

comment on function public.catalog_stats_refresh() is
  'Count the catalog into catalog_stats_cache. Run by pg_cron every 15 minutes; see 020.';

revoke all on function public.catalog_stats_refresh() from public, anon, authenticated;
grant execute on function public.catalog_stats_refresh() to service_role;

-- ─── health ──────────────────────────────────────────────────────────────────
-- THE "A SCRAPER STARTED RETURNING ZERO" ALARM.
--
-- The catalog can rot in a way no error reports: a retailer changes their markup
-- or their API, the scraper keeps completing, and the numbers quietly fall. So
-- every retailer's last run is reported next to the one before it, with the
-- delta, and the runs that refused to sweep say why. That is the difference
-- between noticing in a day and noticing when somebody complains that search
-- got worse.
--
-- The counts come from the cache and are null until it has been filled once; a
-- retailer added since the last count is listed with null counts rather than
-- left out, so a new shop is visible the moment its row exists.
create or replace function public.catalog_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_cache public.catalog_stats_cache;
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  select * into v_cache from public.catalog_stats_cache where id;

  return coalesce(v_cache.totals, '{}'::jsonb) || jsonb_build_object(
    'counted_at', v_cache.counted_at,
    'countries', coalesce(v_cache.countries, '{}'::jsonb),
    'retailers', (
      select coalesce(jsonb_agg(x order by x ->> 'slug'), '[]'::jsonb) from (
        select jsonb_build_object(
          'slug', r.slug,
          'country', r.country,
          'enabled', r.enabled,
          'listings',  (v_cache.retailers -> r.slug ->> 'listings')::bigint,
          'available', (v_cache.retailers -> r.slug ->> 'available')::bigint,
          'last_run',    to_jsonb(last_run.*),
          'previous_valid', prev.products_valid,
          -- The number worth looking at: this run against the one before it.
          'delta', case when prev.products_valid is null or last_run.products_valid is null
                        then null else last_run.products_valid - prev.products_valid end
        ) as x
          from public.catalog_retailers r
          left join lateral (
            select s.status, s.started_at, s.finished_at, s.products_found, s.products_valid,
                   s.products_rejected, s.inserted, s.updated, s.unchanged,
                   s.marked_unavailable, s.error_count, s.error
              from public.catalog_scrape_runs s
             where s.retailer_id = r.id
             order by s.started_at desc limit 1
          ) last_run on true
          left join lateral (
            select s.products_valid
              from public.catalog_scrape_runs s
             where s.retailer_id = r.id and s.status = 'completed'
             order by s.started_at desc offset 1 limit 1
          ) prev on true
      ) t
    )
  );
end;
$fn$;

comment on function public.catalog_stats() is
  'Catalog and per-retailer scrape health. The place a scraper that started returning nothing becomes visible. Counts are cached (020); runs are live.';

revoke all on function public.catalog_stats() from public, anon;
grant execute on function public.catalog_stats() to authenticated;

-- Every 15 minutes. A nightly crawl takes hours, so a count that is a quarter
-- of an hour behind is still the right shape; faster would spend the small
-- instance's cache on numbers nobody is looking at. cron.schedule replaces a
-- job of the same name, so re-running this file does not stack a second one.
select cron.schedule('catalog-stats-refresh', '*/15 * * * *', $$select public.catalog_stats_refresh()$$);

-- Filled now, so the page has numbers before the first scheduled count.
select public.catalog_stats_refresh();
