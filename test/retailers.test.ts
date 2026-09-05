// The three scrapers, against bytes the shops actually sent.
//
// These are the tests that catch a site redesign. Every fixture here was
// captured live, so when Auchan renames a field or Carrefour drops its JSON-LD,
// re-capturing the fixture makes this suite fail with the reason rather than
// leaving a scheduled run to quietly report zero products at 3am.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { toRetailerProduct, parseResourcesHeader, categoryOf } from '../src/retailers/auchan/vtex.ts'
import type { VtexProduct } from '../src/retailers/auchan/vtex.ts'
import { AuchanScraper } from '../src/retailers/auchan/index.ts'
import { buildProduct as buildCarrefour, externalIdFrom as carrefourId } from '../src/retailers/carrefour/index.ts'
import { CarrefourScraper } from '../src/retailers/carrefour/index.ts'
import { buildProduct as buildLidl, externalIdFrom as lidlId } from '../src/retailers/lidl/index.ts'
import { LidlScraper } from '../src/retailers/lidl/index.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'

// ─── Auchan ──────────────────────────────────────────────────────────────────

const auchanPage = JSON.parse(readFixture('auchan/products-search.json')) as VtexProduct[]

describe('auchan / VTEX', () => {
  it('reads a real API page', () => {
    expect(auchanPage.length).toBeGreaterThan(5)
    expect(auchanPage[0].productId).toBeTruthy()
  })

  it('maps every product in the page to a listing', () => {
    const mapped = auchanPage.map((p) => toRetailerProduct(p))
    expect(mapped.every((m) => m !== null)).toBe(true)
  })

  it('takes the price and stock from the default seller offer', () => {
    const product = toRetailerProduct(auchanPage[0])!
    expect(product.retailer).toBe('auchan')
    expect(typeof product.available).toBe('boolean')
    if (product.price !== null) {
      expect(product.price).toBeGreaterThan(0)
      expect(product.currency).toBe('RON')
    }
  })

  it('reads the paging total out of the resources header', () => {
    expect(parseResourcesHeader('0-49/60013')).toEqual({ from: 0, to: 49, total: 60013 })
    expect(parseResourcesHeader('nonsense')).toBeNull()
    expect(parseResourcesHeader(null)).toBeNull()
  })

  it('maps the department, not the leaf', () => {
    expect(categoryOf(['/Fructe si Legume/Fructe proaspete/Banane/'])).toBe('produce')
    expect(categoryOf(['/Bauturi si Tutun/Apa/Apa carbogazoasa/'])).toBe('drinks')
    // Unrecognised is null, not 'other': a guessed shelf is invisible, a null one
    // is findable in the admin dashboard.
    expect(categoryOf(['/Something We Have Never Seen/'])).toBeNull()
    expect(categoryOf(undefined)).toBeNull()
  })

  it('drops "Non-brand", which is a placeholder rather than a maker', () => {
    const product = toRetailerProduct({
      productId: '1', productName: 'Banane', brand: 'Non-brand',
      link: 'https://www.auchan.ro/banane/p', items: [],
    })!
    expect(product.brand).toBeNull()
  })

  it('refuses an internal reference that only LOOKS like a barcode', () => {
    // Auchan files loose produce under 13-digit internal codes. They pass the
    // length test and fail the check digit, and a wrong barcode is worse than
    // none because it is the highest-priority match in the importer.
    const product = toRetailerProduct({
      productId: '2', productName: 'Rosii', link: 'https://www.auchan.ro/rosii/p',
      items: [{ ean: '2122142000000' }],
    })!
    expect(product.gtin).toBeNull()
  })

  it('keeps a barcode whose check digit works out', () => {
    const product = toRetailerProduct({
      productId: '3', productName: 'Apa Borsec 1.5 l',
      link: 'https://www.auchan.ro/apa/p',
      items: [{ ean: '5942219115845' }],
    })!
    expect(product.gtin).toBe('5942219115845')
  })

  it('says it stopped short when the shop stops answering', async () => {
    // THE ONE THAT WOULD HAVE CAUGHT THE FIRST REAL RUN. Auchan opened the
    // circuit at 9,523 products of roughly 60,000, the generator ended cleanly,
    // and the CLI closed the run as `completed` -- a sixth of a shop, recorded as
    // a finished crawl and eligible to sweep. A generator that stops early looks
    // exactly like one that finished, so it has to SAY so.
    const reasons: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'auchan/robots.txt' },
      { match: '/category/tree/', status: 429, body: 'Too Many Requests' },
      { match: '/products/search', status: 500, body: 'boom' },
    ])
    const log = testLogger()
    await collect(
      new AuchanScraper().discoverProducts({
        log,
        fetchImpl,
        minIntervalMs: 0,
        reportIncomplete: (reason) => void reasons.push(reason),
      }),
      50,
    )
    expect(reasons.length).toBeGreaterThan(0)
  })

  it('says nothing about being incomplete when the crawl actually finishes', async () => {
    const reasons: string[] = []
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'auchan/robots.txt' },
      { match: '/category/tree/', status: 429, body: 'Too Many Requests' },
      {
        match: '/products/search',
        file: 'auchan/products-search.json',
        headers: { resources: '0-9/10' },
      },
    ])
    await collect(
      new AuchanScraper().discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportIncomplete: (reason) => void reasons.push(reason),
      }),
      50,
    )
    // A 429 from the category tree is expected and survivable, and must not be
    // mistaken for a truncated crawl.
    expect(reasons).toEqual([])
  })

  it('crawls with no category tree at all, learning categories from the products', async () => {
    // The tree endpoint 429s in real life. This is the path that has to work.
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'auchan/robots.txt' },
      { match: '/category/tree/', status: 429, body: 'Too Many Requests' },
      {
        match: '/products/search',
        file: 'auchan/products-search.json',
        headers: { resources: '0-9/10' },
      },
    ])
    const log = testLogger()
    const products = await collect(
      new AuchanScraper().discoverProducts({ log, fetchImpl, limit: 5, minIntervalMs: 0 }),
      50,
    )
    expect(products.length).toBe(5)
    expect(log.lines.some((l) => l.message.includes('category tree unavailable'))).toBe(true)
    expect(callsOf(fetchImpl).some((u) => u.includes('/products/search'))).toBe(true)
  })
})

// ─── Carrefour ───────────────────────────────────────────────────────────────

function jsonLdOf(fixture: string) {
  const node = findProduct(extractJsonLd(readFixture(fixture)))
  return node ? readProduct(node) : null
}

describe('carrefour', () => {
  it('reads the Product block out of a real page', () => {
    const product = jsonLdOf('carrefour/product-instock.html.gz')!
    expect(product.name).toBe('Lapte UHT pentru cafea Zuzu Barista 3.5% 1L')
    expect(product.sku).toBe('15513004')
    expect(product.brand).toBe('Zuzu')
    expect(product.price).toBe(11.99)
    expect(product.currency).toBe('RON')
  })

  it('has no GTIN, on every page, permanently', () => {
    // Asserted rather than assumed, because the day it changes is the day
    // Carrefour listings start merging with Auchan's and somebody should notice.
    for (const fixture of ['carrefour/product-instock.html.gz', 'carrefour/product-ownbrand.html.gz']) {
      expect(jsonLdOf(fixture)!.gtin).toBeNull()
    }
  })

  it('builds a listing with the id from the URL tail', () => {
    const url = 'https://carrefour.ro/produse/lapte-uht-pentru-cafea-zuzu-barista-3-5-1l-19-15513004'
    const listing = buildCarrefour(jsonLdOf('carrefour/product-instock.html.gz')!, url)!
    expect(listing.retailer).toBe('carrefour')
    expect(listing.externalId).toBe('15513004')
    expect(listing.available).toBe(true)
    expect(listing.quantity).toBe(1)
    expect(listing.unit).toBe('l')
  })

  it('handles an own-brand product', () => {
    const url = 'https://carrefour.ro/produse/detergent-lichid-carrefour-expert-black-1-25l-19-11506707'
    const listing = buildCarrefour(jsonLdOf('carrefour/product-ownbrand.html.gz')!, url)!
    expect(listing.brand).toBe('Carrefour Expert')
    expect(listing.price).toBe(15.49)
    expect(listing.quantity).toBe(1.25)
    expect(listing.unit).toBe('l')
  })

  it('finds no Product on a delisted page, and does not invent one', () => {
    // A delisted Carrefour product 404s and its body carries no Product block.
    // The crawler counts it and moves on; it must NOT become "unavailable" here,
    // because absence is the sweep's business and only after a complete run.
    expect(jsonLdOf('carrefour/product-404-delisted.html.gz')).toBeNull()
  })

  it('prefers the sku but falls back to the URL', () => {
    expect(carrefourId('https://carrefour.ro/produse/x-19-15513004', '15513004')).toBe('15513004')
    expect(carrefourId('https://carrefour.ro/produse/x-19-15513004', null)).toBe('15513004')
    expect(carrefourId('https://carrefour.ro/produse/no-digits/', null)).toBeNull()
  })

  it('skips the category sitemap and fetches only product pages', async () => {
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'carrefour/robots.txt' },
      { match: 'sitemap.xml', file: 'carrefour/sitemap-index.xml' },
      { match: 'sitemap_001', body: '<urlset><url><loc>https://carrefour.ro/bacanie-carrefour/</loc></url></urlset>' },
      { match: 'sitemap_002', file: 'carrefour/sitemap-products.xml' },
      { match: '/produse/', file: 'carrefour/product-instock.html.gz' },
    ])
    const log = testLogger()
    const products = await collect(
      new CarrefourScraper().discoverProducts({ log, fetchImpl, limit: 2, minIntervalMs: 0 }),
      10,
    )
    expect(products.length).toBe(2)
    expect(callsOf(fetchImpl).some((u) => u.includes('/bacanie-carrefour/'))).toBe(false)
  })
})

// ─── Lidl ────────────────────────────────────────────────────────────────────

describe('lidl', () => {
  it('reads a gtin13, which is the only retailer here that publishes one', () => {
    const product = jsonLdOf('lidl/product-outofstock.html.gz')!
    expect(product.gtin).toBe('4056489114703')
    expect(product.brand).toBe('DULANO')
  })

  it('treats InStoreOnly as available, because it is a supermarket', () => {
    // Lidl RO has no general webshop, so most of the assortment is marked
    // InStoreOnly. Calling that unavailable would mark the whole catalog gone.
    const url = 'https://www.lidl.ro/p/ariel-detergent-pudra-mountain-spring/p11000189'
    const listing = buildLidl(jsonLdOf('lidl/product-brand.html.gz')!, url)!
    expect(listing.available).toBe(true)
    expect(listing.price).toBe(69.99)
  })

  it('treats OutOfStock as unavailable, and copes with no price', () => {
    const url = 'https://www.lidl.ro/p/dulano-sunca-feliata-din-pulpa-de-porc/p11000346'
    const listing = buildLidl(jsonLdOf('lidl/product-outofstock.html.gz')!, url)!
    expect(listing.available).toBe(false)
    expect(listing.price).toBeNull()
    expect(listing.currency).toBeNull()
  })

  it('takes the id from the URL, not the variant-level sku', () => {
    // The page for p11000189 reports sku "11000189121". Using the sku would make
    // the id change whenever Lidl reorganises a variant, and a changed id is a
    // new listing plus a swept old one on every single run.
    expect(lidlId('https://www.lidl.ro/p/ariel/p11000189', '11000189121')).toBe('11000189')
  })

  it('crawls its gzipped sitemap', async () => {
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'lidl/robots.txt' },
      { match: 'product_sitemap', file: 'lidl/sitemap-products.xml' },
      { match: '/p/', file: 'lidl/product-brand.html.gz' },
    ])
    const log = testLogger()
    const products = await collect(new LidlScraper().discoverProducts({ log, fetchImpl, limit: 3, minIntervalMs: 0 }), 10)
    expect(products.length).toBe(3)
    expect(products.every((p) => p.retailer === 'lidl')).toBe(true)
  })
})
