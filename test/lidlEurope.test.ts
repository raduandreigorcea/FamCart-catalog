// Lidl outside Romania: one scraper, ten countries, and only the groceries.
//
// Every Lidl country runs the same site, so the scraper is written once and
// configured per country. What differs is small and all of it is here: the
// domain, the product sitemap's country and language, the currency, the slug.
//
// THE FILTER IS THE LOAD-BEARING HALF. Lidl's German, French, Belgian and
// Spanish sites are online shops that are mostly beds, drills and jumpers; the
// Romanian one alone let a laser level and a women's jacket into the catalog.
// A shopping list wants none of it. Every Lidl page names its shelf with a
// numeric path that is the SAME IN EVERY COUNTRY AND LANGUAGE -- 0/17 is food
// and near-food (detergent, nappies), 0/10 is drinks -- so the rule reads that
// number rather than guessing from a product name in ten languages. Guessing
// from names is how "Butterbirne" (a pear TREE) passes for butter.
//
// Every page below was captured from the live sites on 2026-09-14.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import {
  LidlScraper,
  LIDL_COUNTRIES,
  lidlShelf,
  isGroceryShelf,
  buildProduct,
  externalIdFrom,
} from '../src/retailers/lidl/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'
import { MARKETS } from '../src/core/types.ts'

// readFixture unzips a .gz fixture itself.
const page = (name: string): string => readFixture(`lidl-eu/${name}.html.gz`)
const ro = (name: string): string => readFixture(`lidl/${name}.html.gz`)
const productOf = (html: string) => readProduct(findProduct(extractJsonLd(html))!)
const country = (slug: string) => LIDL_COUNTRIES.find((c) => c.slug === slug)!

describe('the Lidl countries', () => {
  it('keeps the Romanian shop as `lidl`, so nothing already imported changes identity', () => {
    const lidl = country('lidl')
    expect(lidl).toMatchObject({ country: 'RO', tld: 'ro', lang: 'ro', currency: 'RON' })
  })

  it('gives every country a unique slug and a market the app can derive', () => {
    const slugs = LIDL_COUNTRIES.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const c of LIDL_COUNTRIES) expect(MARKETS).toContain(c.country)
  })

  it('reads ONE language of a country that publishes several', () => {
    // Belgium lists every product twice, in Dutch and in French, under the same
    // id. Reading both would rename each listing back and forth every night.
    expect(country('lidl-be').lang).toBe('nl')
    expect(country('lidl-ch').lang).toBe('de')
  })

  it('registers a scraper for every country', () => {
    for (const c of LIDL_COUNTRIES) {
      const scraper = SCRAPERS.find((s) => s.retailer === c.slug)
      expect(scraper, c.slug).toBeDefined()
      expect(scraper!.country).toBe(c.country)
      expect(scraper!.domain).toBe(`lidl.${c.tld}`)
    }
  })
})

describe('which shelves are groceries', () => {
  it('keeps food and drinks, in any language', () => {
    expect(isGroceryShelf(lidlShelf(page('de-drinks')))).toBe(true) // 0/10, whisky, German
    expect(isGroceryShelf(lidlShelf(page('gb-food')))).toBe(true) // 0/17, baked beans
    expect(isGroceryShelf(lidlShelf(page('ch-food')))).toBe(true) // 0/17, Actimel
  })

  it('keeps near-food: detergent in Romania, baby wipes in the UK', () => {
    expect(isGroceryShelf(lidlShelf(ro('product-brand')))).toBe(true) // detergent, 0/17
    expect(isGroceryShelf(lidlShelf(page('gb-nonfood-17')))).toBe(true) // wipes, 0/17 NonFood
  })

  it('keeps the Romanian pages the scraper has always imported', () => {
    for (const name of ['product-b', 'product-brand', 'product-outofstock']) {
      expect(isGroceryShelf(lidlShelf(ro(name))), name).toBe(true)
    }
  })

  it('drops the garden shop', () => {
    expect(isGroceryShelf(lidlShelf(page('de-garden')))).toBe(false) // 0/12, hedge trimmer
  })

  it('drops plants and flowers, which sit on the food shelf', () => {
    // 0/17/1732 is plants, filed under food because the flowers stand by the
    // tills. Italy marks it P+F; Austria marks the same shelf NonFood.
    expect(isGroceryShelf(lidlShelf(page('it-plant')))).toBe(false)
    expect(isGroceryShelf(lidlShelf(page('at-plant-nonfood')))).toBe(false)
  })

  it('keeps a page whose path is missing but which says Food', () => {
    // Some British pages publish categoryPrimary with an empty path.
    expect(isGroceryShelf(lidlShelf('"wonCategoryPrimaryPath":"","categoryPrimary":"Food"'))).toBe(true)
    expect(isGroceryShelf(lidlShelf('"categoryPrimary":"F+V"'))).toBe(true)
  })

  it('drops a page that names no shelf at all', () => {
    // A redesign that removes the field then yields nothing, the run imports
    // nothing, and catalog_run_complete refuses to sweep: loud, not quietly wrong.
    expect(isGroceryShelf(lidlShelf('<html></html>'))).toBe(false)
  })
})

describe('building a listing for a country', () => {
  it('names the retailer of that country, and no currency for an in-store item with no price', () => {
    // Most British and Swiss food is InStoreOnly and publishes no price. A
    // currency with nothing to price is not written, as for any other shop.
    const url = 'https://www.lidl.co.uk/p/newgate-baked-beans-in-rich-tomato-sauce/p92961'
    const listing = buildProduct(productOf(page('gb-food')), url, country('lidl-gb'))!
    expect(listing.retailer).toBe('lidl-gb')
    expect(listing.externalId).toBe('92961')
    expect(listing.price).toBeNull()
    expect(listing.currency).toBeNull()
  })

  it('takes the currency the offer names', () => {
    const url = 'https://www.lidl.de/p/loch-lomond-single-malt-scotch-whisky-12-jahre-46-vol/p100269218'
    const listing = buildProduct(productOf(page('de-drinks')), url, country('lidl-de'))!
    expect(listing).toMatchObject({ retailer: 'lidl-de', price: 36.9, currency: 'EUR' })
  })

  it("falls back to the country's currency when a priced offer names none", () => {
    const url = 'https://www.lidl.co.uk/p/whatever/p92961'
    const product = { ...productOf(page('de-drinks')), currency: null }
    expect(buildProduct(product, url, country('lidl-gb'))!.currency).toBe('GBP')
  })

  it('takes the id from a URL that carries a locale segment', () => {
    expect(externalIdFrom('https://www.lidl.ch/p/de-CH/danone-actimel-drink/p10058511', null)).toBe('10058511')
  })

  it('still builds a Romanian listing with no country passed', () => {
    const url = 'https://www.lidl.ro/p/ariel-detergent-pudra-mountain-spring/p11000189'
    const listing = buildProduct(productOf(ro('product-brand')), url)!
    expect(listing.retailer).toBe('lidl')
    expect(listing.currency).toBe('RON')
  })
})

describe('crawling a country', () => {
  const robots = { match: '/robots.txt', body: 'User-agent: *\nDisallow: /q/search\n' }
  const urlset = (urls: string[]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${u}</loc></url>`)
      .join('')}</urlset>`

  it('imports the groceries and skips the rest', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: '/p/export/DE/de/product_sitemap.xml.gz',
        body: urlset([
          'https://www.lidl.de/p/loch-lomond-single-malt-scotch-whisky-12-jahre-46-vol/p100269218',
          'https://www.lidl.de/p/parkside-heckenschere-teleskop/p100397648',
        ]),
      },
      { match: 'loch-lomond', file: 'lidl-eu/de-drinks.html.gz' },
      { match: 'heckenschere', file: 'lidl-eu/de-garden.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'lidl-de')!
    const products = await collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))
    expect(products.map((p) => p.externalId)).toEqual(['100269218'])
    expect(products[0]).toMatchObject({ retailer: 'lidl-de', currency: 'EUR' })
  })

  it('counts a skipped page as read, so the run still covers the whole shop', async () => {
    // Coverage is what lets a run sweep. A crawl that read every page the shop
    // advertised has seen the shop, whether or not it kept what it read.
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: 'product_sitemap',
        body: urlset(['https://www.lidl.de/p/parkside-heckenschere-teleskop/p100397648']),
      },
      { match: 'heckenschere', file: 'lidl-eu/de-garden.html.gz' },
    ])
    let coverage: [number, number] | null = null
    const scraper = SCRAPERS.find((s) => s.retailer === 'lidl-de')!
    await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportCoverage: (seen: number, advertised: number) => {
          coverage = [seen, advertised]
        },
      }),
    )
    expect(coverage).toEqual([1, 1])
  })

  it('asks Belgium for the Dutch sitemap and never the French one', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: '/p/export/BE/nl/product_sitemap.xml.gz',
        body: urlset(['https://www.lidl.be/p/nl-BE/danone-actimel/p10058511']),
      },
      { match: '/p/nl-BE/', file: 'lidl-eu/ch-food.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'lidl-be')!
    const products = await collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))
    expect(products).toHaveLength(1)
    expect(products[0].retailer).toBe('lidl-be')
    expect(callsOf(fetchImpl).some((u) => u.includes('/BE/fr/'))).toBe(false)
  })

  it('leaves the Romanian scraper constructible with no arguments', () => {
    expect(new LidlScraper().retailer).toBe('lidl')
  })
})
