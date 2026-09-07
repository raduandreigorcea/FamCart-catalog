// The registry, and the drift it is the only place able to catch from inside
// this repository.
//
// A retailer's `country` has to be a market the app can derive from a phone's
// timezone, and it has to be a country the database's check constraint accepts.
// The app repo's test/catalog/markets.test.js checks the first half across the
// submodule boundary; this checks what can be checked here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCRAPERS, IMPLEMENTED, scraperFor, kaufland, megaImage } from '../src/core/registry.ts'
import { MARKETS, isMarket } from '../src/core/types.ts'

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/002_catalog.sql', import.meta.url)),
  'utf8',
)

describe('the retailer registry', () => {
  it('gives every retailer a market the app can actually derive', () => {
    for (const scraper of SCRAPERS) {
      expect(isMarket(scraper.country), `${scraper.retailer} country`).toBe(true)
    }
  })

  it('gives every retailer a country the database will accept', () => {
    // The check constraint is written in SQL where no type system reaches it, so
    // it is read back out of the migration rather than trusted.
    const match = /country in \(([^)]+)\)/.exec(migration)
    expect(match, 'the country check constraint is still in 002_catalog.sql').toBeTruthy()
    const allowed = match![1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect([...allowed].sort()).toEqual([...MARKETS].sort())
    for (const scraper of SCRAPERS) {
      expect(allowed).toContain(scraper.country)
    }
  })

  it('has a row in the migration for every IMPLEMENTED retailer, and none for the others', () => {
    // A row in catalog_retailers is a claim that data can arrive. A retailer with
    // no scraper must not have one, or its listings would be sweepable by a run
    // that can never happen.
    for (const scraper of IMPLEMENTED) {
      expect(migration).toContain(`'${scraper.retailer}',`)
    }
    expect(migration).not.toContain("('kaufland'")
    expect(migration).not.toContain("('mega-image'")
  })

  it('keeps the unreadable retailers listed rather than deleting them', () => {
    // Deleting the entry means the next person re-does the analysis and reaches
    // the same conclusion.
    expect(SCRAPERS).toContain(kaufland)
    expect(SCRAPERS).toContain(megaImage)
    expect(kaufland.implemented).toBe(false)
    expect(megaImage.implemented).toBe(false)
  })

  it('says why an unimplemented retailer is unimplemented, HERE', () => {
    // The note used to end with "See docs/retailers.md", and the assertion
    // checked for exactly that pointer. Then the docs went, which is the moment
    // a deferral becomes a dead end -- so the note now has to carry the finding
    // itself, and this checks that rather than checking that it points away.
    for (const scraper of SCRAPERS.filter((s) => !s.implemented)) {
      const note = scraper.note ?? ''
      expect(note, `${scraper.retailer} note`).toBeTruthy()
      // Long enough to be a reason rather than a label. "Not implemented" is
      // 15 characters and says nothing anybody can act on.
      expect(note.length, `${scraper.retailer} note length`).toBeGreaterThan(80)
      // Naming the site is what makes it re-checkable: a shop that was
      // unreadable in 2026 may not be next year, and whoever looks needs to
      // know where to look.
      expect(note, `${scraper.retailer} names its site`).toContain(scraper.domain)
      // And it must not send the reader somewhere else for the actual answer.
      expect(note, `${scraper.retailer} defers`).not.toMatch(/see .*\.md/i)
    }
  })

  it('throws rather than silently yielding nothing when one is asked to crawl', async () => {
    await expect(async () => {
      for await (const _ of kaufland.discoverProducts()) { /* unreachable */ }
    }).rejects.toThrow(/no scraper/)
  })

  it('resolves a retailer by slug and refuses an unknown one', () => {
    expect(scraperFor('auchan')?.retailer).toBe('auchan')
    expect(scraperFor('tesco')).toBeNull()
  })

  it('has unique slugs, since the slug is the database key', () => {
    const slugs = SCRAPERS.map((s) => s.retailer)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
