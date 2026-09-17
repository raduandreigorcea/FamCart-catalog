// Validation, batching, and the run lifecycle on the JavaScript side.
//
// The SQL importer has its own pgTAP suite; this one covers the half that lives
// in Node -- what gets rejected before it ever reaches the database, and the rule
// that a run which did not finish is never closed as one that did.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { validate } from '../src/importer/validate.ts'
import { ScrapeRun, RETRY_DELAYS_MS, watchLiveness } from '../src/importer/run.ts'
import { HttpClient } from '../src/core/http.ts'
import type { CatalogDb } from '../src/importer/run.ts'
import { connect } from '../src/importer/run.ts'
import type { RetailerProduct } from '../src/core/types.ts'
import { testLogger } from './helpers.ts'

function product(overrides: Partial<RetailerProduct> = {}): RetailerProduct {
  return {
    retailer: 'auchan',
    externalId: 'A1',
    name: 'Apa plata Dorna 2L',
    brand: 'Dorna',
    gtin: '5942219115845',
    price: 4.99,
    currency: 'RON',
    quantity: 2,
    unit: 'l',
    category: 'drinks',
    productUrl: 'https://www.auchan.ro/p/a1',
    available: true,
    ...overrides,
  }
}

describe('validate', () => {
  it('passes a complete product through', () => {
    const result = validate(product())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.row.external_id).toBe('A1')
      expect(result.row.gtin).toBe('5942219115845')
      expect(result.row.price).toBe(4.99)
    }
  })

  it('names the reason it rejected something', () => {
    // The reason is the useful output: "4,000 rejected as no-name" is a broken
    // selector, "4,000 as bad-price" is a shop that changed its markup. Both look
    // like "the catalog stopped growing" without it.
    expect(validate(product({ name: '' }))).toMatchObject({ ok: false, reason: 'no-name' })
    expect(validate(product({ externalId: '' }))).toMatchObject({ ok: false, reason: 'no-external-id' })
    expect(validate(product({ productUrl: 'http://insecure/x' }))).toMatchObject({ ok: false, reason: 'no-url' })
    expect(validate(product({ price: -1 }))).toMatchObject({ ok: false, reason: 'bad-price' })
    expect(validate(product({ name: 'x'.repeat(201) }))).toMatchObject({ ok: false, reason: 'name-too-long' })
  })

  it('drops a bad barcode without dropping the row', () => {
    const result = validate(product({ gtin: '2122142000000' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.row.gtin).toBeNull()
  })

  it('rounds a price to what the column stores', () => {
    // Otherwise a third decimal makes every run look like a price change and
    // fills previous_price with noise.
    const result = validate(product({ price: 4.9949 }))
    if (result.ok) expect(result.row.price).toBe(4.99)
  })

  it('drops a quantity with no usable unit rather than storing half of it', () => {
    const result = validate(product({ quantity: 5, unit: null }))
    if (result.ok) {
      expect(result.row.quantity).toBeNull()
      expect(result.row.unit).toBeNull()
    }
  })

  it('drops an unknown category instead of forcing it to "other"', () => {
    const result = validate(product({ category: 'nonsense' as never }))
    if (result.ok) expect(result.row.category).toBeNull()
  })

  it('never emits a price with no currency', () => {
    const result = validate(product({ currency: null }))
    if (result.ok) expect(result.row.currency).toBe('RON')
  })
})

/** A database that records what it was asked and answers from a script. */
function fakeDb(answers: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const db: CatalogDb = {
    async rpc(name, args) {
      calls.push({ name, args })
      if (answers[name] instanceof Error) return { data: null, error: answers[name] }
      return { data: answers[name] ?? {}, error: null }
    },
  }
  return { db, calls }
}

const OPEN = { catalog_run_open: 'run-1' }

describe('ScrapeRun', () => {
  it('opens a run, imports in batches, and closes it', async () => {
    const { db, calls } = fakeDb({
      ...OPEN,
      catalog_import_listings: { inserted: 2, updated: 0, unchanged: 0, products_created: 2 },
      catalog_run_complete: { status: 'completed', marked_unavailable: 1 },
    })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.add(product({ externalId: 'A1' }))
    await run.add(product({ externalId: 'A2', gtin: null }))
    const verdict = await run.complete()

    expect(calls[0].name).toBe('catalog_run_open')
    expect(calls.some((c) => c.name === 'catalog_import_listings')).toBe(true)
    expect(verdict).toMatchObject({ status: 'completed' })
    expect(run.totals.valid).toBe(2)
  })

  it('sends the run id with every import, so rows carry the watermark', async () => {
    const { db, calls } = fakeDb({ ...OPEN, catalog_import_listings: {}, catalog_run_complete: {} })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.add(product())
    await run.complete()
    const importCall = calls.find((c) => c.name === 'catalog_import_listings')
    expect(importCall?.args.p_run_id).toBe('run-1')
    expect(importCall?.args.p_retailer).toBe('auchan')
  })

  it('counts a rejection instead of sending it', async () => {
    const { db, calls } = fakeDb({ ...OPEN, catalog_import_listings: {}, catalog_run_complete: {} })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.add(product({ name: '' }))
    await run.complete()
    expect(run.totals.rejected).toBe(1)
    expect(run.totals.valid).toBe(0)
    expect(calls.some((c) => c.name === 'catalog_import_listings')).toBe(false)
    expect(run.totals.rejections['no-name']).toBe(1)
  })

  it('treats a transport failure that outlasts every retry as fatal, not as one bad row', async () => {
    // The whole batch is unknown. Carrying on would let the run close as
    // completed and sweep rows that may well have landed.
    const { db, calls } = fakeDb({ ...OPEN, catalog_import_listings: new Error('connection reset') })
    const run = new ScrapeRun(db, 'auchan', testLogger(), false, { sleep: async () => {} })
    await run.open()
    await run.add(product())
    await expect(run.flush()).rejects.toThrow(/connection reset/)
    expect(calls.filter((c) => c.name === 'catalog_import_listings')).toHaveLength(
      1 + RETRY_DELAYS_MS.length,
    )
  })

  it('retries a batch the database never answered, and counts it once', async () => {
    // What killed three of four shops on 2026-09-13: one unanswered batch, on
    // an instance that was answering again seconds later.
    const imports: number[] = []
    let failures = 2
    const db: CatalogDb = {
      async rpc(name) {
        if (name === 'catalog_run_open') return { data: 'run-1', error: null }
        if (name === 'catalog_import_listings') {
          imports.push(1)
          if (failures-- > 0) return { data: null, error: { message: 'Gateway Timeout' } }
          return { data: { inserted: 1 }, error: null }
        }
        return { data: {}, error: null }
      },
    }
    const waits: number[] = []
    const run = new ScrapeRun(db, 'auchan', testLogger(), false, {
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await run.open()
    await run.add(product())
    await run.flush()

    expect(imports).toHaveLength(3)
    expect(waits).toEqual(RETRY_DELAYS_MS.slice(0, 2))
    expect(run.totals.inserted).toBe(1)
  })

  it('retries a PostgREST pool timeout, which is a stall and not a refusal', async () => {
    let failures = 1
    const db: CatalogDb = {
      async rpc(name) {
        if (name === 'catalog_import_listings' && failures-- > 0) {
          return { data: null, error: { code: 'PGRST003', message: 'Timed out acquiring connection' } }
        }
        return { data: name === 'catalog_run_open' ? 'run-1' : {}, error: null }
      },
    }
    const run = new ScrapeRun(db, 'auchan', testLogger(), false, { sleep: async () => {} })
    await run.open()
    await run.add(product())
    await expect(run.flush()).resolves.toBeUndefined()
  })

  it('does not retry an error the database itself raised', async () => {
    // Same rows, same refusal. Waiting a minute and a half to hear it again
    // only delays the run saying why it failed.
    const { db, calls } = fakeDb({
      ...OPEN,
      catalog_import_listings: Object.assign(new Error('permission denied'), { code: '42501' }),
    })
    const waits: number[] = []
    const run = new ScrapeRun(db, 'auchan', testLogger(), false, {
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await run.open()
    await run.add(product())
    await expect(run.flush()).rejects.toThrow(/permission denied/)
    expect(calls.filter((c) => c.name === 'catalog_import_listings')).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it('closes a failed run as failed, and never as completed', async () => {
    const { db, calls } = fakeDb({ ...OPEN, catalog_run_fail: null })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.fail(new Error('interrupted'))
    expect(calls.some((c) => c.name === 'catalog_run_fail')).toBe(true)
    expect(calls.some((c) => c.name === 'catalog_run_complete')).toBe(false)
  })

  it('is loud when the database refuses to sweep', async () => {
    const log = testLogger()
    const { db } = fakeDb({
      ...OPEN,
      catalog_import_listings: {},
      catalog_run_complete: { status: 'partial', reason: 'found_nothing' },
    })
    const run = new ScrapeRun(db, 'auchan', log, false)
    await run.open()
    await run.complete()
    expect(log.lines.some((l) => l.level === 'error' && l.message.includes('refused to sweep'))).toBe(true)
  })

  it('removes what the scraper excluded, naming the retailer, when the run closes', async () => {
    const { db, calls } = fakeDb({
      ...OPEN,
      catalog_import_listings: {},
      catalog_purge_listings: { listings_deleted: 2, products_deleted: 1 },
      catalog_run_complete: { status: 'completed' },
    })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.exclude('X1')
    await run.exclude('X2')
    await run.complete()

    const purge = calls.find((c) => c.name === 'catalog_purge_listings')
    expect(purge?.args).toEqual({ p_external_ids: ['X1', 'X2'], p_retailer: 'auchan' })
    expect(run.totals).toMatchObject({ excluded: 2, purgedListings: 2, purgedProducts: 1 })
  })

  it('removes exclusions even from a run that closes as partial, because they are evidence', async () => {
    // An exclusion is "the shop filed this outside groceries", seen with our own
    // eyes. It does not depend on having read the whole shop, unlike the sweep.
    const { db, calls } = fakeDb({ ...OPEN, catalog_purge_listings: {}, catalog_run_partial: null })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.exclude('X1')
    await run.partial('--limit 5')
    expect(calls.some((c) => c.name === 'catalog_purge_listings')).toBe(true)
  })

  it('excludes a gift set or a product sold with an object instead of importing it', async () => {
    const { db, calls } = fakeDb({
      ...OPEN,
      catalog_import_listings: {},
      catalog_purge_listings: { listings_deleted: 1, products_deleted: 1 },
      catalog_run_complete: { status: 'completed' },
    })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.add(product({ externalId: 'B1', name: 'Whisky Jim Beam White, 0.7 l + 2 pahare' }))
    await run.complete()

    expect(calls.some((c) => c.name === 'catalog_import_listings')).toBe(false)
    expect(calls.find((c) => c.name === 'catalog_purge_listings')?.args.p_external_ids).toEqual(['B1'])
    expect(run.totals).toMatchObject({ excluded: 1, found: 0 })
  })

  it('removes nothing in a dry run, and still counts what it would', async () => {
    const { db, calls } = fakeDb()
    const run = new ScrapeRun(db, 'auchan', testLogger(), true)
    await run.open()
    await run.exclude('X1')
    await run.complete()
    expect(calls.length).toBe(0)
    expect(run.totals.excluded).toBe(1)
  })

  it('writes nothing at all in a dry run', async () => {
    const { db, calls } = fakeDb()
    const run = new ScrapeRun(db, 'auchan', testLogger(), true)
    await run.open()
    await run.add(product())
    await run.complete()
    expect(calls.length).toBe(0)
  })
})

describe('connect', () => {
  it('refuses to run without its own credentials', () => {
    // NO FALLBACK to the app project, deliberately. An earlier version of this
    // repository fell back, which quietly made the production household database
    // the default target of every load.
    expect(() => connect({})).toThrow(/CATALOG_SUPABASE_URL/)
    expect(() => connect({ CATALOG_SUPABASE_URL: 'https://x.test' })).toThrow(/SERVICE_ROLE_KEY/)
  })
})

describe('the sign of life', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the pages read since the last report', async () => {
    const { db, calls } = fakeDb(OPEN)
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.alive(12)
    expect(calls.filter((c) => c.name === 'catalog_run_alive')).toEqual([
      { name: 'catalog_run_alive', args: { p_run_id: 'run-1', p_pages: 12, p_done: null, p_total: null, p_unit: null } },
    ])
  })

  // A crawl must never die because the dashboard could not be told it is alive.
  it('does not throw when the sign of life cannot be recorded', async () => {
    const { db } = fakeDb({ ...OPEN, catalog_run_alive: new Error('boom') })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await expect(run.alive(1)).resolves.toBeUndefined()
  })

  it('reports once a minute while answers arrive, counting the good pages', async () => {
    vi.useFakeTimers()
    const { db, calls } = fakeDb(OPEN)
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    const client = new HttpClient({
      fetchImpl: (async () => new Response('x', { status: 200 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    })
    const stop = watchLiveness(run, 60_000)

    await client.get('https://example.test/1')
    await client.get('https://example.test/2')
    await vi.advanceTimersByTimeAsync(60_000)

    // A minute with no answer at all says nothing: silence is the signal.
    await vi.advanceTimersByTimeAsync(60_000)

    await stop()
    const alive = calls.filter((c) => c.name === 'catalog_run_alive')
    expect(alive).toHaveLength(1)
    expect(alive[0].args.p_pages).toBe(2)
  })

  it('still counts as alive when every answer was a refusal, with no pages read', async () => {
    vi.useFakeTimers()
    const { db, calls } = fakeDb(OPEN)
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    const client = new HttpClient({
      fetchImpl: (async () => new Response('x', { status: 404 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    })
    const stop = watchLiveness(run, 60_000)
    await client.get('https://example.test/gone')
    await vi.advanceTimersByTimeAsync(60_000)
    await stop()
    const alive = calls.filter((c) => c.name === 'catalog_run_alive')
    expect(alive).toHaveLength(1)
    expect(alive[0].args.p_pages).toBe(0)
  })

  // The progress bar's numbers travel with the sign of life: the latest the
  // scraper reported, once a minute, never one report per page.
  it('carries the latest progress with each report', async () => {
    vi.useFakeTimers()
    const { db, calls } = fakeDb(OPEN)
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    const client = new HttpClient({
      fetchImpl: (async () => new Response('x', { status: 200 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    })
    let progress: { done: number; total: number; unit: string } | null = { done: 3, total: 10, unit: 'pages' }
    const stop = watchLiveness(run, 60_000, () => progress)
    await client.get('https://example.test/1')
    progress = { done: 4, total: 10, unit: 'pages' }
    await vi.advanceTimersByTimeAsync(60_000)
    await stop()
    const alive = calls.filter((c) => c.name === 'catalog_run_alive')
    expect(alive).toHaveLength(1)
    expect(alive[0].args).toMatchObject({ p_done: 4, p_total: 10, p_unit: 'pages' })
  })

  // The removals belong in the run row, where the Scrapers page reads a run --
  // not only in the job's log. A removals-only run imports nothing, so without
  // this its row said 0, 0, 0 after deleting thousands.
  it('records what the run removed in its stats, as it goes', async () => {
    vi.useFakeTimers()
    const { db, calls } = fakeDb({ ...OPEN, catalog_purge_listings: { listings_deleted: 7, products_deleted: 5 } })
    const run = new ScrapeRun(db, 'carrefour', testLogger())
    await run.open()
    const client = new HttpClient({
      fetchImpl: (async () => new Response('x', { status: 200 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    })
    const stop = watchLiveness(run, 60_000)
    for (let i = 0; i < 100; i++) await run.exclude(`id-${i}`)
    await client.get('https://example.test/1')
    await vi.advanceTimersByTimeAsync(60_000)
    const progress = calls.filter((c) => c.name === 'catalog_run_progress').at(-1)
    expect(progress?.args.p_stats).toMatchObject({ excluded: 100, purged_listings: 7, purged_products: 5 })
    await stop()
  })

  it('sends what is left when it is stopped', async () => {
    vi.useFakeTimers()
    const { db, calls } = fakeDb(OPEN)
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    const client = new HttpClient({
      fetchImpl: (async () => new Response('x', { status: 200 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    })
    const stop = watchLiveness(run, 60_000)
    await client.get('https://example.test/1')
    await stop()
    const alive = calls.filter((c) => c.name === 'catalog_run_alive')
    expect(alive.map((c) => c.args.p_pages)).toEqual([1])
  })
})
