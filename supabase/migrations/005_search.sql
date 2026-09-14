-- ─── what the app calls ──────────────────────────────────────────────────────
-- Three functions, and their NAMES AND ARGUMENT NAMES ARE A CROSS-REPOSITORY
-- CONTRACT. PostgREST resolves an RPC by the argument names in the request body,
-- so renaming p_query, p_limit, p_markets, p_langs, p_retailers, p_codes,
-- p_name or p_maker breaks src/lib/productSuggestions.ts in the app repo with
-- nothing here to warn anybody. The app's CI runs this suite for exactly that reason.
--
-- The failure is also SILENT on the app's side: a 404 from PostgREST is caught,
-- the catalog leg of Promise.allSettled returns [], and suggestions quietly fall
-- back to the app database's own rows. Nobody sees an error; the dropdown just
-- gets worse.

-- ─── the weights, in one place ───────────────────────────────────────────────
-- Read by the admin dashboard so a ranking decision can be explained rather than
-- argued about.
--
-- THE RUNGS ARE TEN APART AND THE BONUSES ADD UP TO NINE. That is not tidiness:
-- it is what makes a bonus incapable of lifting a row over a better match. When
-- bonuses could cross a rung, "beer" answered with "Beef" -- a worse text match
-- that happened to be in stock at three shops. A bonus breaks ties inside a rung
-- and never leaves it.
create or replace function public.catalog_search_weights()
returns jsonb
language sql
immutable
as $fn$
  select jsonb_build_object(
    'name_exact',    100,
    'name_prefix',    80,
    'brand_exact',    70,
    'name_tokens',    60,
    'brand_prefix',   50,
    'blob_tokens',    30,
    'blob_substring', 20,
    'fuzzy',           5,
    'bonus_available', 5,
    'bonus_multi_retailer', 3,
    'bonus_quantity',  1
  )
$fn$;

comment on function public.catalog_search_weights() is
  'The ranking rungs and bonuses. Rungs are 10 apart; bonuses total 9, so a bonus can never cross a rung.';

revoke all on function public.catalog_search_weights() from public, anon;
grant execute on function public.catalog_search_weights() to authenticated;

-- ─── search ──────────────────────────────────────────────────────────────────
-- search_catalog LIVES IN 009, ALONE. It was defined here first, and 009
-- rewrote it so the trigram index on search_blob is actually reachable.
--
-- The definition did not stay here as well, and that is the point: two files
-- restating one function is a race whose winner is whichever was pushed last,
-- and the loss is silent. That exact thing happened to catalog_run_open between
-- 003 and 007 -- see the note in 003 -- and cost three days of scrape runs that
-- were never closed. Here it would read as "the search got slow again", with
-- nothing in the repository to say why.
--
-- The rungs and their weights stay below, because the admin dashboard reads them
-- and nothing about them changed.

-- ─── barcode ─────────────────────────────────────────────────────────────────
-- lookup_barcode LIVES IN 014, ALONE, with its comment and its grants. It gained
-- a market there: a scan in Italy must not find a product only a Romanian shop
-- sells, and must read the name an Italian shop uses.

-- ─── popularity ──────────────────────────────────────────────────────────────
-- bump_product_popularity LIVES IN 009, ALONE, for the same reason search_catalog
-- does. Its rate-limit table stays here, because a table is not a body that can
-- be silently replaced.
-- The only number in this schema that a human writes, and the only reason a
-- catalog assembled by machines ends up ordered the way people actually shop.
--
-- Rate limited per user per hour. Not because anybody is expected to attack it,
-- but because the app calls it fire-and-forget and swallows the result: a bug
-- that called it in a loop would be invisible from the client side and would
-- quietly rewrite the ranking for everybody.
create table if not exists public.catalog_bump_limits (
  user_id      text not null,
  window_start timestamptz not null,
  bumps        integer not null default 0,
  primary key (user_id, window_start)
);

comment on table public.catalog_bump_limits is
  'Per-user hourly ceiling on popularity bumps. No policy: nothing but the bump function may read it.';

alter table public.catalog_bump_limits enable row level security;
revoke all on public.catalog_bump_limits from anon, authenticated;

