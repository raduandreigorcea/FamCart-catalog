// Delhaize Belgium: groceries by the department in the URL, one language, and a
// price read out of the offer's priceSpecification. Page captured 2026-09-14.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import { delhaizeIsGrocery, delhaizeIdFrom, buildDelhaizeProduct } from '../src/retailers/delhaize/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const url = (path: string) => `https://www.delhaize.be${path}`
const MUSHROOMS = url('/nl/shop/Verse-groenten-en-fruit/Verse-groenten/Champignons/Witte-champignons/Witte-champignons-Belgisch/p/F2015021100304110000')
const DECORATION = url('/nl/shop/Keuken-wonen-en-vrije-tijd/Huisdecoratie/Kaarsen/Geurkaars-Vanille/p/S2023010100000000000')

describe('delhaize: which departments are groceries', () => {
  it('keeps the supermarket, including the kitchen corner of the home aisle', () => {
    expect(delhaizeIsGrocery(MUSHROOMS)).toBe(true)
    expect(delhaizeIsGrocery(url('/nl/shop/Onderhoud-en-huishouden/Wassen/Wasmiddel/p/S1'))).toBe(true)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Keukengerei-en-accessoires/Garde/p/S2'))).toBe(true)
  })

  it('drops decorations, plants, electrics and party accessories', () => {
    expect(delhaizeIsGrocery(DECORATION)).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Insecten-en-planten/Orchidee/p/S3'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Keuken-wonen-en-vrije-tijd/Elektriciteit/Lamp/p/S4'))).toBe(false)
    expect(delhaizeIsGrocery(url('/nl/shop/Eindejaarsproducten/Feest-accessoires/Slingers/p/S5'))).toBe(false)
  })

  it('refuses a French page and anything that is not a product', () => {
    expect(delhaizeIdFrom(url('/fr/shop/Legumes/Champignons/p/F2015021100304110000'))).toBeNull()
    expect(delhaizeIdFrom(url('/nl/shop/Verse-groenten-en-fruit/c/v2VEG'))).toBeNull()
  })
})

describe('delhaize: a listing', () => {
  it('reads the price from the priceSpecification and the department as a shelf', () => {
    const html = readFixture('delhaize/food.html.gz')
    const listing = buildDelhaizeProduct(readProduct(findProduct(extractJsonLd(html))!), MUSHROOMS)!
    expect(listing).toMatchObject({
      retailer: 'delhaize',
      externalId: 'F2015021100304110000',
      brand: 'Delhaize',
      currency: 'EUR',
      category: 'produce',
      gtin: null,
      available: true,
    })
    expect(listing.price).toBeGreaterThan(0)
  })
})

describe('delhaize: the crawl', () => {
  it('fetches the groceries, never the decorations, and reports what it skipped', async () => {
    const excluded: string[] = []
    let coverage: [number, number] | null = null
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /login\n' },
      {
        match: 'delhaizesitemapindex',
        body: `<urlset><url><loc>${MUSHROOMS}</loc><lastmod>2026-09-14</lastmod></url><url><loc>${DECORATION}</loc><lastmod>2026-09-14</lastmod></url></urlset>`,
      },
      { match: '/p/F2015021100304110000', file: 'delhaize/food.html.gz' },
    ])
    const products = await collect(
      SCRAPERS.find((s) => s.retailer === 'delhaize')!.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: (id: string) => excluded.push(id),
        reportCoverage: (seen: number, advertised: number) => {
          coverage = [seen, advertised]
        },
      }),
    )
    expect(products).toHaveLength(1)
    expect(excluded).toEqual(['S2023010100000000000'])
    expect(callsOf(fetchImpl).some((u) => u.includes('Huisdecoratie'))).toBe(false)
    expect(coverage).toEqual([2, 2])
  })
})
