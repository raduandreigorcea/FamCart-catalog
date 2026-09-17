// Carrefour's removals-only run: the one-off cleanup of what was imported before
// the catalog read groceries only.
//
// A nightly Carrefour run spends 4h40 of its five hours re-reading the 545
// grocery departments, so the 3,023 others -- where the clothes, the televisions
// and the flowerpots are -- are never reached, and nothing imported from them
// before 2026-09-14 is ever removed. This mode skips the groceries and trusts a
// grocery pass that already read them all: what that pass saw is groceries, and
// only what a non-grocery department shows and that pass did NOT see is removed.
//
// The danger is the trust. An empty or too-small set of known groceries would
// make every product look like a t-shirt, so the loader refuses one.

import { describe, it, expect } from 'vitest'
import { fixtureFetch, callsOf, collect, readFixture, testLogger } from './helpers.ts'
import { CarrefourScraper } from '../src/retailers/carrefour/index.ts'
import { parseImpressions } from '../src/retailers/carrefour/listing.ts'
import { loadSeenSince, MIN_GROCERY_IDS } from '../src/importer/seen.ts'

const routes = [
  { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' },
  { match: 'sitemap.xml', file: 'carrefour/sitemap-index.xml' },
  {
    match: 'sitemap_001',
    body:
      '<urlset><url><loc>https://carrefour.ro/bacanie-carrefour/</loc></url>' +
      '<url><loc>https://carrefour.ro/tex/femei/</loc></url>' +
      '<url><loc>https://carrefour.ro/electrocasnice/</loc></url></urlset>',
  },
  { match: 'sitemap_002', file: 'carrefour/sitemap-products.xml' },
  { match: '?p=', file: 'carrefour/listing-single.html.gz' },
  { match: '/bacanie-carrefour/', file: 'carrefour/listing-paged.html.gz' },
  { match: '/tex/femei/', file: 'carrefour/listing-single.html.gz' },
  { match: '/electrocasnice/', file: 'carrefour/listing-single.html.gz' },
]

const shown = parseImpressions(readFixture('carrefour/listing-single.html.gz'))!.map((row) => String(row.id))

describe('a removals-only Carrefour run', () => {
  async function run(groceryIds: Set<string>, extra: Record<string, unknown> = {}) {
    const fetchImpl = fixtureFetch(routes)
    const excluded: string[] = []
    const products = await collect(
      new CarrefourScraper().discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        removalsOnly: { groceryIds },
        reportExcluded: async (id: string) => void excluded.push(id),
        ...extra,
      }),
      500,
    )
    return { products, excluded, calls: callsOf(fetchImpl) }
  }

  it('never reads a grocery department, and imports nothing', async () => {
    const { products, calls } = await run(new Set())
    expect(calls.some((u) => u.includes('/bacanie-carrefour/'))).toBe(false)
    expect(calls.some((u) => u.includes('/tex/femei/'))).toBe(true)
    expect(products).toEqual([])
  })

  it('removes what a non-grocery department shows, and not what the grocery pass saw', async () => {
    const kept = shown[0]
    const { excluded } = await run(new Set([kept]))
    expect(excluded).not.toContain(kept)
    expect(excluded).toEqual(expect.arrayContaining(shown.slice(1)))
    // Each id once, however many departments show it.
    expect(new Set(excluded).size).toBe(excluded.length)
  })

  it('reads one slice of the non-grocery departments when sharded, and still removes', async () => {
    const first = await run(new Set(), { shard: { index: 0, of: 2 } })
    const second = await run(new Set(), { shard: { index: 1, of: 2 } })
    const read = (calls: string[]) => ['/tex/femei/', '/electrocasnice/'].filter((d) => calls.some((u) => u.includes(d)))
    expect(read(first.calls)).toHaveLength(1)
    expect(read(second.calls)).toHaveLength(1)
    expect(read(first.calls)).not.toEqual(read(second.calls))
    expect(first.excluded.length).toBeGreaterThan(0)
  })
})

describe('loadSeenSince', () => {
  const env = { url: 'https://catalog.test', key: 'service-key' }
  const since = new Date('2026-09-16T09:50:43Z')

  /** A PostgREST that answers the retailer lookup and pages the listings. */
  function postgrest(total: number, page = 1000) {
    const asked: string[] = []
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      asked.push(url)
      if (url.includes('/catalog_retailers')) return new Response(JSON.stringify([{ id: 'r-1' }]))
      const range = new Headers(init?.headers).get('range') ?? '0-999'
      const [from] = range.split('-').map(Number)
      const rows = Array.from({ length: Math.max(0, Math.min(page, total - from)) }, (_, i) => ({
        external_id: String(from + i),
      }))
      return new Response(JSON.stringify(rows))
    }) as unknown as typeof fetch
    return { impl, asked }
  }

  it('pages through every listing the retailer showed since the watermark', async () => {
    const { impl, asked } = postgrest(MIN_GROCERY_IDS + 1500)
    const ids = await loadSeenSince(env, 'carrefour', since, impl)
    expect(ids.size).toBe(MIN_GROCERY_IDS + 1500)
    const listing = asked.find((u) => u.includes('/catalog_listings'))!
    expect(listing).toContain('retailer_id=eq.r-1')
    expect(listing).toContain(`last_seen_at=gte.${encodeURIComponent(since.toISOString())}`)
  })

  // A watermark in the future, or a grocery pass that never ran, gives a set too
  // small to be groceries -- and with it, every product looks like a t-shirt.
  it('refuses a set of groceries too small to be real', async () => {
    const { impl } = postgrest(12)
    await expect(loadSeenSince(env, 'carrefour', since, impl)).rejects.toThrow(/refusing/i)
  })

  it('refuses an unknown retailer', async () => {
    const impl = (async () => new Response('[]')) as unknown as typeof fetch
    await expect(loadSeenSince(env, 'nowhere', since, impl)).rejects.toThrow(/unknown retailer/i)
  })
})
