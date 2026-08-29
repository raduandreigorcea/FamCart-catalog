import { createClient } from 'jsr:@supabase/supabase-js@2'
import { OpenFoodFactsAdapter } from '../_shared/sources/openFoodFacts.ts'
import { pipeline, isLocalSufficient, type LocalRow } from '../_shared/discover.ts'
import { isLanguage, isMarket } from '../_shared/markets.ts'

// The cold path. Everything in §5 that is not "search the local catalog".
//
// ─── why this is a function and not client code ──────────────────────────────
//
// The warm path — the one that answers almost every keystroke — does NOT come
// through here. The app calls search_catalog() directly over PostgREST, which
// is one round trip to Postgres with no function to cold-start. This is only
// reached when that answer was not good enough, which is the definition of the
// cold search in §24.
//
// Three things force the external leg to be server-side rather than in the
// browser, and each of them on its own would be enough:
//
//   1. THE WRITE. Saving an accepted product means calling
//      catalog_import_products, which is granted to service_role and nothing
//      else. A browser holding a key that could do that is a browser that could
//      rewrite the catalog for everybody.
//   2. THE CACHE HAS TO BE SHARED. A per-device cache means the thousandth
//      person to search a term nobody stocks still pays for the external call.
//      §7's negative cache is only worth anything if it is one cache.
//   3. OPEN FOOD FACTS WANTS TO KNOW WHO IS CALLING. A User-Agent set in a
//      browser is ignored by the browser, and the request would be a CORS
//      preflight away from not happening at all.
//
// ─── what it does NOT do ─────────────────────────────────────────────────────
//
// It does not return the local results — the caller already has those, and
// sending them back would double them. It returns only what discovery ADDED,
// so the client can append. And it never fails the caller: every error path
// returns an empty list with a reason, because §19 says a dead external source
// must cost its own rows and nothing else.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// §6. Below three characters an external search returns noise proportional to
// how common the letters are, and the local prefix match is already better.
const MIN_QUERY = 3
const MAX_QUERY = 100

// §7. A hit is a fact about a product and stays true; a miss is a fact about
// this catalog, which is the thing that changes. See 005_discovery.sql.
const TTL_HIT_SECONDS = 14 * 24 * 60 * 60
const TTL_MISS_SECONDS = 24 * 60 * 60

const adapter = new OpenFoodFactsAdapter({
  // Tighter than the adapter's own default. A person is waiting on this, and
  // a slow answer they have already scrolled past is worth less than a fast
  // empty one — the local results are already on screen either way.
  timeoutMs: 3_500,
  retries: 1,
  userAgent: 'FamCart/1.0 (https://famcart-app.vercel.app)',
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/** Nothing found, and why. Never an error status: a miss is a normal outcome. */
function empty(reason: string): Response {
  return json({ products: [], discovered: 0, reason })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // ─── who is asking ─────────────────────────────────────────────────────────
  // The caller's own token, verified by creating a client with it and asking
  // the database who that is. This function writes to the global catalog on
  // behalf of whoever called it, so "signed in" is the floor — an anonymous
  // caller could otherwise pour discovered rows into a catalog every household
  // shares.
  //
  // Note the two clients below are deliberately different: `caller` proves
  // identity under the caller's own rights, `admin` does the privileged work.
  // Using one client for both is how a function like this accidentally becomes
  // an open write endpoint.
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json({ error: 'not configured' }, 500)

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  // search_catalog is granted to `authenticated` and revoked from `anon`, so a
  // token that cannot run it is a token that has no business writing here. This
  // is an authorisation check dressed as a cheap query, and it costs one round
  // trip rather than a JWT library.
  const { error: whoError } = await caller.rpc('search_catalog', { p_query: 'a', p_limit: 1 })
  if (whoError) return json({ error: 'unauthorized' }, 401)

  let body: { query?: unknown; market?: unknown; language?: unknown; local?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad request' }, 400)
  }

  const query = String(body.query ?? '').trim().slice(0, MAX_QUERY)
  if (query.length < MIN_QUERY) return empty('query-too-short')

  const market = isMarket(body.market) ? body.market : undefined
  const language = isLanguage(body.language) ? body.language : undefined

  // What the client already got from search_catalog. Untrusted and used for two
  // things only, both of which fail safe if it lies: deciding whether to ask
  // externally at all, and skipping products the catalog already has. A caller
  // that sends [] gets an external search it did not need; one that sends
  // fabricated rows gets fewer discoveries. Neither can write anything.
  const local: LocalRow[] = Array.isArray(body.local)
    ? (body.local as unknown[])
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
        .slice(0, 100)
        .map((r) => ({
          name: String(r.name ?? ''),
          maker: r.maker == null ? null : String(r.maker),
          popularity: Number(r.popularity) || 0,
        }))
        .filter((r) => r.name)
    : []

  if (isLocalSufficient(local, query, { minQueryLength: MIN_QUERY })) {
    return empty('local-sufficient')
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const source = adapter.meta.name

  // ─── the cache, before anything external ───────────────────────────────────
  // Including the misses. A query that found nothing yesterday finding nothing
  // again today is the single most common thing this function is asked, and
  // answering it without leaving the building is the whole point of §7.
  const { data: cached } = await admin.rpc('catalog_cache_lookup', {
    p_source: source,
    p_query: query,
    p_market: market ?? '',
    p_language: language ?? '',
  })

  if (Array.isArray(cached) && cached.length) {
    // A cached HIT means those products are already in catalog_products, so the
    // client's next local search finds them and there is nothing to return
    // here. A cached MISS means there was nothing to find. Both are "we have
    // already asked", which is the answer.
    return empty(cached[0].result_count > 0 ? 'cached-hit' : 'cached-miss')
  }

  // ─── ask ───────────────────────────────────────────────────────────────────
  const found = await adapter.search(query, {
    language,
    market,
    maxResults: 20,
    signal: req.signal,
  })

  // The adapter returns [] for both "nothing matched" and "the source is down",
  // and the difference matters here even though it does not to the caller: a
  // failure must NOT be cached as a miss, or an outage would freeze a hole in
  // the catalog for a day. The breaker is the honest signal for that.
  if (!found.length && adapter.circuitOpen) return empty('source-unavailable')

  const { rows, stats } = pipeline(found, query, local)

  // ─── save what survived ────────────────────────────────────────────────────
  let imported = 0
  if (rows.length) {
    const { data, error } = await admin.rpc('catalog_import_products', {
      p_rows: rows,
      p_source: source,
    })
    if (error) {
      // The products are real and the search worked; only the write failed.
      // Caching that as an answer would hide a broken import behind a healthy
      // cache for two weeks.
      return empty('import-failed')
    }
    imported = (data?.inserted ?? 0) + (data?.updated ?? 0)
  }

  await admin.rpc('catalog_cache_record', {
    p_source: source,
    p_query: query,
    p_market: market ?? '',
    p_language: language ?? '',
    p_result_count: rows.length,
    p_stats: stats,
    p_ttl_seconds: rows.length ? TTL_HIT_SECONDS : TTL_MISS_SECONDS,
  })

  // Returned so the person who paid for the cold search sees the result of it
  // rather than an unchanged dropdown. Everyone after them gets these from the
  // local catalog, which is the loop working.
  return json({
    products: rows.map((r) => ({
      name: r.name,
      maker: r.brand ?? null,
      popularity: 0,
    })),
    discovered: imported,
    stats,
  })
})
