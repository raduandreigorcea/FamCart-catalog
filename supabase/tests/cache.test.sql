-- The query cache and the negative cache (§7), and the metrics that read them.
--
--   npx supabase --workdir catalog db reset && npx supabase --workdir catalog test db
--
-- What these assert:
--
--   1. ONE ROW PER QUESTION. Asking again updates rather than appends, so the
--      table is bounded by distinct questions instead of by traffic.
--   2. THE QUERY IS FOLDED BY THE DATABASE. "Pepsi Zero" and "pepsi  zero" are
--      one cache entry. If the caller folded it instead, two callers folding
--      slightly differently would each get their own entry and the cache would
--      quietly stop working while looking full.
--   3. A MISS IS CACHED, and is distinguishable from never having asked. This
--      is the half of §7 that actually saves the round trips: a query that
--      finds nothing leaves no product behind, so without this every person
--      typing it pays in full, forever.
--   4. EXPIRY IS READ, NOT SWEPT. A stale entry is invisible to a lookup the
--      moment it expires, with no job needed to make that true.
--   5. THE TTL IS BOUNDED whatever the caller passes. A bug that asked for a
--      year would freeze a hole in the catalog for a year.
--   6. NO CLIENT CAN READ OR WRITE ANY OF IT. The cache says what other people
--      have been searching for.

begin;
select plan(28);

delete from public.catalog_products;
delete from public.catalog_search_cache;
delete from public.catalog_admins;

-- ─── 1. recording and finding ────────────────────────────────────────────────

select public.catalog_cache_record(
  'openfoodfacts', 'Pepsi Zero', 'RO', 'ro', 4,
  '{"returned": 20, "accepted": 4}'::jsonb, 1209600
);

select is(
  (select count(*)::int from public.catalog_search_cache),
  1,
  'recording a search leaves one row'
);

select is(
  (select normalized_query from public.catalog_search_cache),
  'pepsi zero',
  'the query is folded by the database, not stored as it was typed'
);

select is(
  (select result_count from public.catalog_cache_lookup('openfoodfacts', 'Pepsi Zero', 'RO', 'ro')),
  4,
  'and is found again'
);

select is(
  (select result_count from public.catalog_cache_lookup('openfoodfacts', '  pepsi   ZERO  ', 'RO', 'ro')),
  4,
  'however it is typed the second time — this is what makes it a cache'
);

select is(
  (select (stats->>'accepted')::int from public.catalog_cache_lookup('openfoodfacts', 'pepsi zero', 'RO', 'ro')),
  4,
  'the pipeline stats come back with it, so "why did this find nothing" is answerable'
);

-- ─── 2. the key is all four parts ────────────────────────────────────────────
-- Market and language genuinely change the answer: the external search ranks
-- per language, so caching across them would serve a French household a
-- Romanian ranking.

select is(
  (select count(*)::int from public.catalog_cache_lookup('openfoodfacts', 'pepsi zero', 'DE', 'ro')),
  0,
  'a different market is a different question'
);

select is(
  (select count(*)::int from public.catalog_cache_lookup('openfoodfacts', 'pepsi zero', 'RO', 'de')),
  0,
  'and so is a different language'
);

select is(
  (select count(*)::int from public.catalog_cache_lookup('openbeautyfacts', 'pepsi zero', 'RO', 'ro')),
  0,
  'and so is a different source'
);

-- ─── 3. asking again updates rather than appends ─────────────────────────────

select public.catalog_cache_record(
  'openfoodfacts', 'pepsi zero', 'RO', 'ro', 7, '{"accepted": 7}'::jsonb, 1209600
);

select is(
  (select count(*)::int from public.catalog_search_cache),
  1,
  'a second answer to the same question does not add a row'
);

select is(
  (select result_count from public.catalog_search_cache),
  7,
  'it replaces the answer'
);

-- hit_count belongs to the QUESTION, not to any one answer. Resetting it on a
-- refresh would erase the only evidence of which searches people repeat, which
-- is exactly the number the curation backlog is sorted by.
-- Three, because exactly three lookups above matched this row; the three that
-- asked for a different market, language or source matched nothing and
-- correctly counted nothing. Asserted exactly rather than loosely, so a change
-- that stopped counting hits fails here instead of quietly emptying the
-- curation backlog.
select is(
  (select hit_count from public.catalog_search_cache),
  3,
  'and does not reset how many times it has been asked'
);

-- ─── 4. the negative cache ───────────────────────────────────────────────────
-- The half that saves the round trips. A query that finds nothing leaves no
-- product behind, so without a record of having asked, every person typing it
-- pays the full external cost forever.

select public.catalog_cache_record(
  'openfoodfacts', 'asdfghjkl', '', '', 0, '{"returned": 0}'::jsonb, 86400
);

select is(
  (select result_count from public.catalog_cache_lookup('openfoodfacts', 'asdfghjkl')),
  0,
  'a search that found nothing is remembered as having found nothing'
);

select is(
  (select count(*)::int from public.catalog_cache_lookup('openfoodfacts', 'asdfghjkl')),
  1,
  'which is a ROW — distinguishable from never having asked, and that is the point'
);

select is(
  (select count(*)::int from public.catalog_cache_lookup('openfoodfacts', 'never asked')),
  0,
  'where never having asked returns nothing at all'
);

-- ─── 5. expiry ───────────────────────────────────────────────────────────────

update public.catalog_search_cache
   set expires_at = now() - interval '1 minute'
 where normalized_query = 'asdfghjkl';

select is(
  (select count(*)::int from public.catalog_cache_lookup('openfoodfacts', 'asdfghjkl')),
  0,
  'an expired entry is invisible with no sweep having run'
);

select is(
  (select count(*)::int from public.catalog_search_cache where normalized_query = 'asdfghjkl'),
  1,
  'though the row is still there — expiry is a read rule, not a delete'
);

select is(
  public.catalog_cache_sweep('0 seconds'),
  1,
  'and the sweep removes it when someone asks it to'
);

-- ─── 6. the TTL is bounded ───────────────────────────────────────────────────

select public.catalog_cache_record('openfoodfacts', 'forever', '', '', 1, '{}'::jsonb, 999999999);

select ok(
  (select expires_at from public.catalog_search_cache where normalized_query = 'forever')
    <= now() + interval '30 days' + interval '1 minute',
  'a caller asking for a year gets thirty days — a bug must not freeze the catalog'
);

select public.catalog_cache_record('openfoodfacts', 'instant', '', '', 1, '{}'::jsonb, 0);

select ok(
  (select expires_at from public.catalog_search_cache where normalized_query = 'instant')
    >= now() + interval '59 seconds',
  'and one asking for zero gets a minute — a bug must not disable the cache either'
);

-- ─── 7. rubbish in ───────────────────────────────────────────────────────────

select lives_ok(
  $$select public.catalog_cache_record('openfoodfacts', '   ', '', '', 0, '{}'::jsonb, 60)$$,
  'an empty query is ignored rather than stored'
);

select is(
  (select count(*)::int from public.catalog_search_cache where normalized_query = ''),
  0,
  'so the cache never holds a row nothing can ever match'
);

select throws_ok(
  $$select public.catalog_cache_record('some-scraper', 'x', '', '', 0, '{}'::jsonb, 60)$$,
  '23514', null,
  'an unknown source is refused: provenance is a closed list here too'
);

-- ─── 8. who may see any of this ──────────────────────────────────────────────

insert into public.catalog_admins (user_id) values ('admin_user');

set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select is(
  (select count(*)::int from public.catalog_search_cache),
  0,
  'an ordinary signed-in user sees no cache rows — this is what other people searched for'
);

select throws_ok(
  $$select public.catalog_cache_lookup('openfoodfacts', 'pepsi zero', 'RO', 'ro')$$,
  '42501', null,
  'and cannot reach the lookup, which would let them enumerate it'
);

select throws_ok(
  $$select public.catalog_cache_record('openfoodfacts', 'x', '', '', 0, '{}'::jsonb, 60)$$,
  '42501', null,
  'nor poison it with an answer of their own'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"admin_user"}';

select ok(
  (select count(*) from public.catalog_search_cache) > 0,
  'an admin can read it, because "what finds nothing" is the curation backlog'
);

select ok(
  (public.catalog_discovery_stats() ->> 'zero_result_queries')::int >= 0,
  'and the discovery stats are theirs to read'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ordinary_user"}';

select throws_ok(
  $$select public.catalog_discovery_stats()$$,
  'P0001',
  'not an admin',
  'an ordinary user cannot read the operational stats'
);

reset role;

select * from finish();
rollback;
