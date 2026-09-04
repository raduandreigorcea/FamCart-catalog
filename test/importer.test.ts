// Validation, batching, and the run lifecycle on the JavaScript side.
//
// The SQL importer has its own pgTAP suite; this one covers the half that lives
// in Node -- what gets rejected before it ever reaches the database, and the rule
// that a run which did not finish is never closed as one that did.

import { describe, it, expect } from 'vitest'
import { validate } from '../src/importer/validate.ts'
import { ScrapeRun } from '../src/importer/run.ts'
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
    imageUrl: 'https://cdn.test/a.jpg',
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

  it('treats a transport failure as fatal, not as one bad row', async () => {
    // The whole batch is unknown. Carrying on would let the run close as
    // completed and sweep rows that may well have landed.
    const { db } = fakeDb({ ...OPEN, catalog_import_listings: new Error('connection reset') })
    const run = new ScrapeRun(db, 'auchan', testLogger())
    await run.open()
    await run.add(product())
    await expect(run.flush()).rejects.toThrow(/connection reset/)
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
