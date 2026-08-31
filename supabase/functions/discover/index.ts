import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createAdapters } from '../_shared/sources/index.ts'
import type { SourceName, SourceProduct } from '../_shared/sources/types.ts'
import {
  groupBySource,
  isLocalSufficient,
  pipeline,
  relevantTo,
  toImportRows,
  type ConceptIntent,
  type LocalRow,
} from '../_shared/discover.ts'
import { gate } from '../_shared/quality.ts'
import { isLanguage, isMarket, type Language, type Market } from '../_shared/markets.ts'

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
// ─── THREE SOURCES, NOT ONE ──────────────────────────────────────────────────
//
// Open Food Facts answers food. It does not answer detergent, nappies,
// batteries, toothpaste or cat litter, and those are also the concepts the
// curated seed removed for needing a brand — so before the two sibling
// databases were added here, those searches missed locally AND missed
// externally, and the person got an empty dropdown with nowhere to go.
//
// All three are asked AT ONCE rather than in a fallback chain. A chain would
// make every household query pay Open Food Facts' latency before the source
// that can actually answer it is even tried; in parallel the cost is the
// slowest source rather than the sum, and the pipeline's cap keeps the batch
// the same size it always was.
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

const adapters = createAdapters({
  // Tighter than the adapter's own default. A person is waiting on this, and
  // a slow answer they have already scrolled past is worth less than a fast
  // empty one — the local results are already on screen either way. It applies
  // per source, and because the three are asked in parallel it is the ceiling
  // for all of them together rather than three times over.
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

type Admin = ReturnType<typeof createClient>

/**
 * Write one batch of rows, correctly attributed.
 *
 * `catalog_import_products` takes ONE source for the whole batch and records it
 * in `catalog_sources`, which is a licensing fact rather than bookkeeping — so
 * with three sources in play the rows are grouped and the RPC is called once
 * per group. One group's failure does not abandon the others: they are separate
 * transactions upstream and there is no sense in throwing away a good batch
 * because a different database's rows would not land.
 */
async function importRows(
  admin: Admin,
  rows: ReturnType<typeof toImportRows>,
  conceptId: string | null,
): Promise<{ imported: number; failed: SourceName[] }> {
  let imported = 0
  const failed: SourceName[] = []

  for (const [source, group] of groupBySource(rows)) {
    const { data, error } = await admin.rpc('catalog_import_products', {
      p_rows: group,
      p_source: source,
      // ATTRIBUTION IS FREE HERE, and it is evidence rather than a guess: this
      // query resolved to a concept before a single external call was made,
      // these rows came back for it, and every one of them passed relevantTo().
      // That is a stronger claim than anything a name classifier could make
      // after the fact, and it is the mechanism by which concept membership —
      // and therefore local reach for products whose names share nothing with
      // the query — grows on its own.
      p_concept_id: conceptId,
    })
    if (error) {
      failed.push(source)
      continue
    }
    imported += (data?.inserted ?? 0) + (data?.updated ?? 0)
  }

  return { imported, failed }
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

  let body: {
    query?: unknown
    market?: unknown
    language?: unknown
    local?: unknown
    barcode?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad request' }, 400)
  }

  const market = isMarket(body.market) ? body.market : undefined
  const language = isLanguage(body.language) ? body.language : undefined
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // ─── barcode mode ──────────────────────────────────────────────────────────
  // A scan that neither database knew. Same function because it needs the same
  // three things this one exists for: the service-role write, the User-Agent,
  // and the sources themselves.
  if (body.barcode !== undefined) {
    return await resolveBarcode(admin, body.barcode, { market, language, signal: req.signal })
  }

  const query = String(body.query ?? '').trim().slice(0, MAX_QUERY)
  if (query.length < MIN_QUERY) return empty('query-too-short')

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

  // ─── what does this word MEAN? ─────────────────────────────────────────────
  // Asked before anything else is decided, because it is what decides them.
  //
  // A generic concept ('cartofi', 'morcovi') is answered by the bare row that
  // is already on the searcher's screen, and no external database has a better
  // answer to give — asking would spend a request, a cache row and somebody's
  // wait on a result that cannot improve. A branded one ('apa', 'deodorant') is
  // the opposite: the local row is a placeholder and the real answer is
  // elsewhere.
  //
  // A failure here is not fatal and must not be. If the lookup errors the
  // intent is null, which is treated as 'branded' — the assumption that asks
  // rather than the one that stays silent.
  const { data: conceptRows } = await admin.rpc('catalog_concept_lookup', {
    p_query: query,
    p_lang: language ?? null,
  })
  const concept = (conceptRows as { id: string; slug: string; intent: string }[] | null)?.[0] ?? null
  const intent = (concept?.intent ?? null) as ConceptIntent | null

  // The concept's own words, in six languages, so the pipeline can tell a brand
  // from the category leaking out of the source's brand field. Only fetched on
  // the cold path and only when a concept resolved, so the warm path pays
  // nothing; a failure leaves it empty and stripCategoryBrands becomes a no-op.
  let categoryTerms: string[] = []
  if (concept) {
    const { data: termRows } = await admin
      .from('catalog_concept_terms')
      .select('term')
      .eq('concept_id', concept.id)
    categoryTerms = (termRows as { term: string }[] | null)?.map((t) => t.term) ?? []
  }

  if (isLocalSufficient(local, query, { minQueryLength: MIN_QUERY, intent })) {
    return empty(intent === 'generic' ? 'generic-concept' : 'local-sufficient')
  }

  // ─── the cache, before anything external ───────────────────────────────────
  // Including the misses. A query that found nothing yesterday finding nothing
  // again today is the single most common thing this function is asked, and
  // answering it without leaving the building is the whole point of §7.
  //
  // ONE ROW PER SOURCE, NOT ONE PER QUERY. `catalog_search_cache.source` is
  // constrained to the three source names, so there is no key a combined row
  // could use — but the per-source shape is the one worth having anyway: it is
  // what lets Open Beauty Facts' answer stay cached while Open Products Facts,
  // which was down when it was asked, gets asked again.
  const cached = await Promise.all(
    adapters.map(async (a) => ({
      adapter: a,
      rows: (
        await admin.rpc('catalog_cache_lookup', {
          p_source: a.meta.name,
          p_query: query,
          p_market: market ?? '',
          p_language: language ?? '',
        })
      ).data as { result_count?: number }[] | null,
    })),
  )

  const toAsk = cached.filter((c) => !(Array.isArray(c.rows) && c.rows.length)).map((c) => c.adapter)

  if (!toAsk.length) {
    // Every source has already been asked. A cached HIT means those products
    // are in catalog_products, so the client's next local search finds them and
    // there is nothing to return here; a cached MISS means there was nothing to
    // find. Both are "we have already asked", which is the answer.
    const anyHit = cached.some((c) => (c.rows ?? []).some((r) => (r.result_count ?? 0) > 0))
    return empty(anyHit ? 'cached-hit' : 'cached-miss')
  }

  // ─── ask, all at once ──────────────────────────────────────────────────────
  // allSettled rather than all: one source throwing must not lose the other
  // two's results, which is the same rule the app applies when it queries both
  // databases for suggestions.
  const answers = await Promise.allSettled(
    toAsk.map((a) =>
      a.search(query, { language, market, maxResults: 20, signal: req.signal }),
    ),
  )

  const perSource = toAsk.map((adapter, i) => {
    const answer = answers[i]
    const products = answer.status === 'fulfilled' ? answer.value : []
    return {
      adapter,
      products,
      // Whether this source ANSWERED, as opposed to whether it had anything.
      // The adapter returns [] for both "nothing matched" and "the source is
      // down", and the difference does not matter to the caller but decides
      // everything about the cache: caching an outage as a miss would freeze a
      // hole in the catalog for a day.
      healthy: answer.status === 'fulfilled' && !adapter.lastRequestFailed,
      // What this source had to say about this query, before dedupe and before
      // the cap. The right number for the cache, because "we already hold
      // these" is still a hit — the answer exists and asking again would only
      // rediscover it.
      relevant: relevantTo(products, query).length,
    }
  })

  if (!perSource.some((s) => s.healthy)) return empty('source-unavailable')

  const found: SourceProduct[] = perSource.flatMap((s) => s.products)
  const { rows, stats } = pipeline(found, query, local, { intent, categoryTerms })

  // ─── save what survived ────────────────────────────────────────────────────
  let imported = 0
  let failed: SourceName[] = []
  if (rows.length) {
    ;({ imported, failed } = await importRows(admin, rows, concept?.id ?? null))
    if (failed.length === groupBySource(rows).size) {
      // The products are real and the search worked; only the write failed.
      // Caching that as an answer would hide a broken import behind a healthy
      // cache for two weeks.
      return empty('import-failed')
    }
  }

  // Record only what was actually learned: a source that did not answer, and a
  // source whose rows could not be written, have both taught us nothing worth
  // remembering for a day.
  await Promise.all(
    perSource
      .filter((s) => s.healthy && !failed.includes(s.adapter.meta.name))
      .map((s) =>
        admin.rpc('catalog_cache_record', {
          p_source: s.adapter.meta.name,
          p_query: query,
          p_market: market ?? '',
          p_language: language ?? '',
          p_result_count: s.relevant,
          p_stats: stats,
          p_ttl_seconds: s.relevant ? TTL_HIT_SECONDS : TTL_MISS_SECONDS,
        }),
      ),
  )

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
    stats: { ...stats, sources: perSource.map((s) => s.adapter.meta.name) },
  })
})

/**
 * A scanned code that neither database knew.
 *
 * Cheaper and stricter than the search path, because a barcode is an EXACT key.
 * There is no relevance question to ask — the code either identifies a product
 * upstream or it does not — so `relevantTo` has nothing to do here and the
 * quality gate is the only judgement left. It still applies: a record whose
 * name is the barcode, or the string "PRODUIT TEST", is no more useful for
 * having been scanned.
 *
 * DELIBERATELY NOT CACHED. `catalog_search_cache` is keyed by a normalised
 * QUERY, and a barcode is not one; a miss here also costs nothing to repeat,
 * because scanning is a deliberate act a person does once rather than a
 * keystroke they produce six of. The search path's cache exists to stop a
 * dropdown from generating traffic, and this is not that.
 */
async function resolveBarcode(
  admin: Admin,
  raw: unknown,
  ctx: { market?: Market; language?: Language; signal?: AbortSignal },
): Promise<Response> {
  // The app expands one scan into its equivalent encodings (EAN-13 from UPC-A
  // and so on); every one of them is an exact key for the same product.
  const codes = (Array.isArray(raw) ? raw : [raw])
    .map((c) => String(c ?? '').trim())
    .filter((c) => /^[0-9]{8,14}$/.test(c))
    .slice(0, 4)

  if (!codes.length) return json({ product: null, discovered: 0, reason: 'bad-barcode' })

  // In parallel, then first non-null in SOURCE ORDER rather than whichever
  // answered first. A product mis-filed into two of these databases must
  // resolve the same way every time, and "fastest to respond" is not a stable
  // rule — Open Food Facts is tried first because it is the largest and best
  // curated of the three.
  const answers = await Promise.allSettled(
    adapters.map((a) =>
      a.getByBarcode(codes, {
        language: ctx.language,
        market: ctx.market,
        signal: ctx.signal,
      }),
    ),
  )

  const hit = answers
    .map((a) => (a.status === 'fulfilled' ? a.value : null))
    .find((p): p is SourceProduct => p !== null)

  if (!hit) return json({ product: null, discovered: 0, reason: 'not-found' })

  const { accepted } = gate([hit], 'commercial')
  if (!accepted.length) return json({ product: null, discovered: 0, reason: 'rejected' })

  const { imported, failed } = await importRows(admin, toImportRows(accepted))
  if (failed.length) return json({ product: null, discovered: 0, reason: 'import-failed' })

  const product = accepted[0]
  return json({
    product: { name: product.name, maker: product.brand ?? null, popularity: 0 },
    discovered: imported,
  })
}
