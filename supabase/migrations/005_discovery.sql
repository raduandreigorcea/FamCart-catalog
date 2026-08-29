-- ─── the cache, and the counters ─────────────────────────────────────────────
-- What keeps discovery from asking the same question twice.
--
-- The cold-to-warm loop (§24) is the growth mechanism: the first person to
-- search "pepsi zero" pays for an external call, and everyone after them is
-- answered locally. That works on its own for queries that FIND something —
-- the products land in catalog_products and the next search matches them.
--
-- IT DOES NOT WORK FOR QUERIES THAT FIND NOTHING, and that is what this table
-- is for. A search that returns no acceptable product leaves no trace in the
-- catalog, so without a record of having asked, every single person typing
-- "asdfgh" or a genuinely unknown local brand pays the full external round trip
-- for a result nobody will ever be able to use. §7 asks for negative caching by
-- name; this is it, and it is the more valuable half.
--
-- WHY A SHORTER TTL FOR MISSES THAN FOR HITS. A hit is a fact about a product
-- that will still be true next month. A miss is a fact about the CATALOG — "we
-- did not know this yet" — and the whole point of the system is that this
-- changes. 24 hours for a miss, 14 days for a hit, both inside §7's suggested
-- ranges.

create table if not exists public.catalog_search_cache (
  id uuid primary key default gen_random_uuid(),

  -- The four things that make one question different from another (§7).
  -- Folded, so "Pepsi Zero" and "pepsi  zero" are one cache entry rather than
  -- two — the same fold the search itself uses, applied by the trigger below
  -- rather than by the caller.
  source           text not null,
  normalized_query text not null,
  -- Empty string rather than null for both, so the unique index below is a
  -- plain one instead of needing NULLS NOT DISTINCT and four partial variants.
  -- The market and language genuinely change the answer: search-a-licious ranks
  -- differently per `langs`, so caching across them would serve a French
  -- household a Romanian ranking.
  market   text not null default '',
  language text not null default '',

  -- How many products SURVIVED the whole pipeline, not how many came back.
  -- Zero is the interesting value: it is what makes this a negative cache
  -- entry, and it means "we asked and there was nothing usable", which is a
  -- different thing from "we have not asked".
  result_count integer not null default 0,

  -- What the pipeline did, kept for the admin dashboard and for answering
  -- "why did this query find nothing" without re-running it. Small, bounded,
  -- and never the raw source payload — §20 is explicit that raw upstream
  -- records do not belong in this database.
  stats jsonb not null default '{}'::jsonb,

  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,

  -- Bookkeeping that turns into the §23 metrics without a second table.
  hit_count integer not null default 0
);

alter table public.catalog_search_cache
  drop constraint if exists catalog_search_cache_source_check;
alter table public.catalog_search_cache
  add constraint catalog_search_cache_source_check
  check (source in ('openfoodfacts', 'openproductsfacts', 'openbeautyfacts'));

alter table public.catalog_search_cache
  drop constraint if exists catalog_search_cache_query_length;
alter table public.catalog_search_cache
  add constraint catalog_search_cache_query_length
  check (char_length(normalized_query) between 1 and 100);

alter table public.catalog_search_cache
  drop constraint if exists catalog_search_cache_market_check;
alter table public.catalog_search_cache
  add constraint catalog_search_cache_market_check
  check (market = '' or market = any (array['RO','MD','DE','AT','CH','ES','FR','BE','IT','GB','IE']));

alter table public.catalog_search_cache
  drop constraint if exists catalog_search_cache_language_check;
alter table public.catalog_search_cache
  add constraint catalog_search_cache_language_check
  check (language = '' or language in ('en', 'de', 'es', 'ro', 'fr', 'it'));

alter table public.catalog_search_cache
  drop constraint if exists catalog_search_cache_counts_check;
alter table public.catalog_search_cache
  add constraint catalog_search_cache_counts_check
  check (result_count >= 0 and hit_count >= 0);

-- ONE ROW PER QUESTION. This is what makes the cache a cache rather than a log:
-- asking again updates the row instead of appending, so the table's size is
-- bounded by the number of distinct questions rather than by traffic.
create unique index if not exists catalog_search_cache_key
  on public.catalog_search_cache (source, normalized_query, market, language);

-- Sweeping expired rows, and answering "what has been asked lately" for the
-- dashboard. Both want the same order.
create index if not exists catalog_search_cache_expires
  on public.catalog_search_cache (expires_at);

-- The query is folded by the database, not by the caller, for the same reason
-- normalized_name is: two callers folding slightly differently would each get
-- their own cache entry for one question, and the cache would quietly stop
-- working while looking full.
create or replace function public.catalog_search_cache_derive()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  new.normalized_query := left(public.catalog_normalize(new.normalized_query, null), 100);
  return new;
end;
$$;

drop trigger if exists catalog_search_cache_derive on public.catalog_search_cache;
create trigger catalog_search_cache_derive
  before insert or update on public.catalog_search_cache
  for each row execute function public.catalog_search_cache_derive();

alter table public.catalog_search_cache enable row level security;

-- No policy for ordinary clients: the cache says what other people have been
-- searching for, which is nobody's business but the operator's. Admins may read
-- it because "which queries find nothing" is the single most useful view for
-- deciding what to curate next.
drop policy if exists "admins can read the search cache" on public.catalog_search_cache;
create policy "admins can read the search cache"
  on public.catalog_search_cache for select to authenticated
  using (public.catalog_is_admin());

revoke all on public.catalog_search_cache from anon, authenticated;
grant select on public.catalog_search_cache to authenticated;

-- ─── asking the cache ────────────────────────────────────────────────────────
-- Returns the entry when it is still fresh, and counts the hit.
--
-- SECURITY DEFINER and service_role only. The discovery function is the one
-- caller; a client that could reach this could enumerate what everyone else has
-- been searching for.
create or replace function public.catalog_cache_lookup(
  p_source   text,
  p_query    text,
  p_market   text default '',
  p_language text default ''
)
returns table (result_count integer, stats jsonb, fetched_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_query text := left(public.catalog_normalize(coalesce(p_query, ''), null), 100);
begin
  if v_query = '' then
    return;
  end if;

  -- The update IS the lookup: a separate select then update would be two round
  -- trips and a race, and the returning clause gives the row back either way.
  return query
  update public.catalog_search_cache c
     set hit_count = c.hit_count + 1
   where c.source = p_source
     and c.normalized_query = v_query
     and c.market = coalesce(p_market, '')
     and c.language = coalesce(p_language, '')
     and c.expires_at > now()
  returning c.result_count, c.stats, c.fetched_at;
end;
$$;

revoke all on function public.catalog_cache_lookup(text, text, text, text) from public, anon, authenticated;
grant execute on function public.catalog_cache_lookup(text, text, text, text) to service_role;

-- ─── recording an answer ─────────────────────────────────────────────────────
-- Called once per external search, whatever it found.
--
-- p_ttl_seconds is the caller's, because the caller is the only thing that
-- knows whether this was a hit or a miss and the two want very different
-- lifetimes. Bounded here anyway: a caller that passed a year would turn a
-- temporary outage into a permanent hole in the catalog.
create or replace function public.catalog_cache_record(
  p_source      text,
  p_query       text,
  p_market      text default '',
  p_language    text default '',
  p_result_count integer default 0,
  p_stats       jsonb default '{}'::jsonb,
  p_ttl_seconds integer default 86400
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_query text := left(public.catalog_normalize(coalesce(p_query, ''), null), 100);
  -- One minute to thirty days. The floor stops a bug from disabling the cache
  -- entirely; the ceiling stops one from freezing it.
  v_ttl   integer := least(greatest(coalesce(p_ttl_seconds, 86400), 60), 2592000);
begin
  if v_query = '' then
    return;
  end if;

  insert into public.catalog_search_cache (
    source, normalized_query, market, language, result_count, stats, fetched_at, expires_at
  ) values (
    p_source, v_query, coalesce(p_market, ''), coalesce(p_language, ''),
    greatest(coalesce(p_result_count, 0), 0),
    coalesce(p_stats, '{}'::jsonb),
    now(), now() + make_interval(secs => v_ttl)
  )
  on conflict (source, normalized_query, market, language) do update set
    result_count = excluded.result_count,
    stats        = excluded.stats,
    fetched_at   = excluded.fetched_at,
    expires_at   = excluded.expires_at;
    -- hit_count is deliberately absent: it belongs to the question, not to any
    -- one answer, and resetting it on every refresh would erase the only
    -- evidence of which searches people actually repeat.
end;
$$;

revoke all on function public.catalog_cache_record(text, text, text, text, integer, jsonb, integer) from public, anon, authenticated;
grant execute on function public.catalog_cache_record(text, text, text, text, integer, jsonb, integer) to service_role;

-- ─── sweeping ────────────────────────────────────────────────────────────────
-- Nothing expires on its own. An expired row is already ignored by
-- catalog_cache_lookup (it checks expires_at) and overwritten by the next
-- catalog_cache_record for the same question, so this exists to keep the table
-- small rather than to keep it correct — which is why there is no scheduled job
-- and no pg_cron dependency. Run it by hand, or from the dashboard, when the
-- row count starts to matter.
create or replace function public.catalog_cache_sweep(p_older_than interval default '30 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.catalog_search_cache
   where expires_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.catalog_cache_sweep(interval) from public, anon, authenticated;
grant execute on function public.catalog_cache_sweep(interval) to service_role;

-- ─── what the operator sees ──────────────────────────────────────────────────
-- §23's metrics, computed rather than accumulated.
--
-- NO COUNTER TABLE, and that is a deliberate refusal to build one. Every number
-- below is already implied by rows that exist for other reasons, so a counter
-- table would be a second source of truth that can drift from the first, plus a
-- write on the hot path of every search. When the catalog is large enough that
-- these scans hurt, the answer is a materialized view refreshed on a schedule —
-- not a counter incremented by hand from four places.
--
-- Admin-only, and readable through the dashboard's existing catalog_stats slot.
create or replace function public.catalog_discovery_stats()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.catalog_is_admin() then
    raise exception 'not an admin';
  end if;

  return jsonb_build_object(
    'products',        (select count(*) from public.catalog_products),
    'generic',         (select count(*) from public.catalog_products where product_type = 'generic'),
    'commercial',      (select count(*) from public.catalog_products where product_type = 'commercial'),
    'discovered',      (select count(*) from public.catalog_products p
                         where exists (select 1 from public.catalog_sources s
                                        where s.product_id = p.id and s.source_name <> 'curated')),
    'aliases',         (select count(*) from public.catalog_aliases),
    'identifiers',     (select count(*) from public.catalog_identifiers),
    'by_tier',         (select jsonb_object_agg(quality_tier, n)
                         from (select quality_tier, count(*) n
                                 from public.catalog_products group by quality_tier) t),
    -- The cache, which is where the interesting operational questions live.
    'cache_entries',   (select count(*) from public.catalog_search_cache),
    'cache_hits',      (select coalesce(sum(hit_count), 0) from public.catalog_search_cache),
    -- Queries that were asked and found nothing usable. THE MOST USEFUL NUMBER
    -- IN THIS OBJECT: it is the curation backlog, in priority order, measured
    -- from what people actually typed rather than from what anyone guessed.
    'zero_result_queries',
      (select count(*) from public.catalog_search_cache where result_count = 0),
    'top_misses',
      (select coalesce(jsonb_agg(jsonb_build_object('query', normalized_query, 'asked', hit_count + 1)
                                 order by hit_count desc), '[]'::jsonb)
         from (select normalized_query, hit_count
                 from public.catalog_search_cache
                where result_count = 0
                order by hit_count desc
                limit 20) t)
  );
end;
$$;

revoke all on function public.catalog_discovery_stats() from public, anon;
grant execute on function public.catalog_discovery_stats() to authenticated;
