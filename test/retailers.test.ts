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
import { parseListingPage } from '../src/retailers/carrefour/listing.ts'
import { buildProduct as buildLidl, externalIdFrom as lidlId } from '../src/retailers/lidl/index.ts'
import { LidlScraper } from '../src/retailers/lidl/index.ts'
import {
  buildProduct as buildMega,
  externalIdFrom as megaId,
  categoryFromPath as megaCategory,
  MegaImageScraper,
} from '../src/retailers/mega-image/index.ts'
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

  it('says it stopped short when the shop stops answering altogether', async () => {
    // THE ONE THAT WOULD HAVE CAUGHT THE FIRST REAL RUN. Auchan opened the
    // circuit at 9,523 products of roughly 60,000, the generator ended cleanly,
    // and the CLI closed the run as `completed` -- a sixth of a shop, recorded as
    // a finished crawl and eligible to sweep. A generator that stops early looks
    // exactly like one that finished, so it has to SAY so.
    //
    // The tree answers here so the frontier has categories to work through:
    // reaching the breaker takes more requests than a crawl that dies on its
    // first page, and a crawl that dies on its first page is caught by finding
    // nothing rather than by this.
    const tree = JSON.stringify([
      { id: 1000000, name: 'A', children: [{ id: 1010000, name: 'B' }] },
      { id: 2000000, name: 'C', children: [{ id: 2010000, name: 'D' }] },
    ])
    const reasons: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/robots.txt')) return new Response(readFixture('auchan/robots.txt'))
      if (url.includes('/category/tree/')) return new Response(tree)
      throw new Error('connection reset')
    }) as unknown as typeof fetch

    await collect(
      new AuchanScraper().discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportIncomplete: (reason) => void reasons.push(reason),
      }),
      50,
    )
    expect(reasons.some((r) => r.includes('circuit'))).toBe(true)
  })

  it('does NOT call a crawl truncated because one page errored', async () => {
    // This cost a good run. Twelve pages out of thousands returned 500, the
    // first marked a pass that read 59,839 of roughly 60,000 products as failed,
    // and a failed run can never sweep -- so availability would have stopped
    // updating for Auchan entirely while every run looked broken.
    //
    // Skipping a page ends that CATEGORY's paging; the frontier carries on. What
    // the hole costs is products, and products are what the sanity floor
    // measures, so that is the check that belongs to it.
    const reasons: string[] = []
    let call = 0
    const good = readFixture('auchan/products-search.json')
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/robots.txt')) return new Response(readFixture('auchan/robots.txt'))
      if (url.includes('/category/tree/')) return new Response('nope', { status: 429 })
      // One page in the middle fails; every other page answers.
      call += 1
      if (call === 2) return new Response('boom', { status: 500 })
      return new Response(good, { status: 200, headers: { resources: '0-9/10' } })
    }) as unknown as typeof fetch

    const products = await collect(
      new AuchanScraper().discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        limit: 5,
        reportIncomplete: (reason) => void reasons.push(reason),
      }),
      50,
    )
    expect(products.length).toBeGreaterThan(0)
    expect(reasons).toEqual([])
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

  // ─── departments, not products ────────────────────────────────────────────
  // The crawl reads department listings rather than product pages: 24 products
  // per request instead of one, which is the difference between forty-five
  // hours and about two, and is what lets the whole shop fit in one nightly job.
  //
  // The old path fetched every /produse/ URL in the sitemap. These pin the
  // inversion, because getting it half-done -- reading departments AND products
  // -- would be slower than either and nothing would fail.
  describe('departments', () => {
    const routes = [
      { match: '/robots.txt', file: 'carrefour/robots.txt' },
      { match: 'sitemap.xml', file: 'carrefour/sitemap-index.xml' },
      {
        match: 'sitemap_001',
        body:
          '<urlset><url><loc>https://carrefour.ro/bacanie-carrefour/</loc></url>' +
          '<url><loc>https://carrefour.ro/tex/femei/</loc></url></urlset>',
      },
      { match: 'sitemap_002', file: 'carrefour/sitemap-products.xml' },
      { match: '?p=', file: 'carrefour/listing-single.html.gz' },
      { match: '/bacanie-carrefour/', file: 'carrefour/listing-paged.html.gz' },
      { match: '/tex/femei/', file: 'carrefour/listing-single.html.gz' },
      { match: '/produse/', file: 'carrefour/product-instock.html.gz' },
    ]

    async function run(extra: Record<string, unknown> = {}) {
      const fetchImpl = fixtureFetch(routes)
      const products = await collect(
        new CarrefourScraper().discoverProducts({
          log: testLogger(),
          fetchImpl,
          minIntervalMs: 0,
          ...extra,
        }),
        500,
      )
      return { products, calls: callsOf(fetchImpl) }
    }

    it('does not mistake a root-level product page for a department', async () => {
      // Carrefour publishes products at the root as well as under /produse/:
      // carrefour.ro/prajitor-de-paine-...-19-41503994/ is a toaster, not an
      // aisle. Asking whether the path contains /produse/ let thousands of them
      // through to be crawled as departments, each one then counted as a page
      // the crawler could not read. A department is a URL that does NOT end in
      // a product id.
      const fetchImpl = fixtureFetch([
        ...routes,
        {
          match: 'sitemap_001',
          body:
            '<urlset><url><loc>https://carrefour.ro/bacanie-carrefour/</loc></url>' +
            '<url><loc>https://carrefour.ro/prajitor-de-paine-tefal-19-41503994/</loc></url></urlset>',
        },
      ])
      await collect(
        new CarrefourScraper().discoverProducts({
          log: testLogger(),
          fetchImpl,
          minIntervalMs: 0,
        }),
        500,
      )
      expect(callsOf(fetchImpl).some((u) => u.includes('prajitor-de-paine'))).toBe(false)
    })

    it('reads department pages and never touches a product page', async () => {
      const { products, calls } = await run()
      expect(products.length).toBeGreaterThan(0)
      expect(calls.some((u) => u.includes('/produse/'))).toBe(false)
      expect(calls.some((u) => u.includes('/bacanie-carrefour/'))).toBe(true)
    })

    it('gets many products from one request, which is the whole point', async () => {
      const { products, calls } = await run()
      const listingCalls = calls.filter((u) => !u.includes('sitemap') && !u.includes('robots'))
      expect(products.length).toBeGreaterThan(listingCalls.length)
    })

    it('KEEPS TURNING A PARENT PAST PRODUCTS ITS LEAVES ALREADY GAVE', async () => {
      // The bug that cost half the shop, pinned end to end rather than as a
      // unit. Departments nest and the leaves are read first, so a parent's
      // page one is entirely products already yielded. Stopping there -- which
      // "nothing globally new" does -- means never reaching page two, where the
      // products that sit in no leaf live. A live run covered 46.7%.
      //
      // Here the leaf and the parent's page one serve the SAME fixture, and the
      // parent's page two serves a different one. A crawl that stops on
      // familiarity never sees the second fixture's products at all.
      const fetchImpl = fixtureFetch([
        { match: '/robots.txt', file: 'carrefour/robots.txt' },
        { match: 'sitemap.xml', file: 'carrefour/sitemap-index.xml' },
        {
          match: 'sitemap_001',
          body:
            '<urlset><url><loc>https://carrefour.ro/aisle/</loc></url>' +
            '<url><loc>https://carrefour.ro/aisle/leaf/</loc></url></urlset>',
        },
        { match: 'sitemap_002', body: '<urlset></urlset>' },
        // Order matters: the more specific patterns first.
        { match: '/aisle/leaf/', file: 'carrefour/listing-paged.html.gz' },
        { match: '/aisle/?p=2', file: 'carrefour/listing-single.html.gz' },
        { match: '/aisle/?p=', body: '<html></html>', status: 404 },
        { match: '/aisle/', file: 'carrefour/listing-paged.html.gz' },
      ])
      const products = await collect(
        new CarrefourScraper().discoverProducts({
          log: testLogger(),
          fetchImpl,
          minIntervalMs: 0,
        }),
        500,
      )
      const singleOnly = parseListingPage(readFixture('carrefour/listing-single.html.gz'))!
      const got = new Set(products.map((p) => p.externalId))
      expect(
        singleOnly.some((p) => got.has(p.externalId)),
        'the parent was turned past its first page',
      ).toBe(true)
    })

    it('yields each product once, however many departments claim it', async () => {
      // A product sits in a leaf and in every parent above it, so the same
      // listing arrives repeatedly. The importer would cope, but products_valid
      // is what the sanity floor and the dashboard delta are measured on -- a
      // count inflated by duplicates would make a shrinking shop look healthy.
      const { products } = await run()
      const ids = products.map((p) => p.externalId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('carries a category, which the product page never could', async () => {
      const { products } = await run()
      expect(products.some((p) => p.category !== null)).toBe(true)
    })

    it('REFUSES TO CONCLUDE ANYTHING when the departments miss the shop', async () => {
      // The load-bearing one. Departments are an indirect route to the products:
      // one that sits in no department is never seen, and "did not see it" is
      // what a sweep reads as "no longer sold". The sanity floor is no help --
      // it compares against a previous COMPLETED run, and on this path there has
      // never been one, so the first would have marked every missed product gone.
      //
      // Here the fixtures' departments hold 24-ish products while the sitemap
      // lists fifty, so coverage is far under the bar and the run says so.
      const reasons: string[] = []
      await run({ reportIncomplete: (reason: string) => reasons.push(reason) })
      expect(reasons.length).toBeGreaterThan(0)
      expect(reasons.join(' ')).toContain('covered')
    })

    it('says nothing about coverage on a deliberately limited run', async () => {
      // --limit stops early by design, so measuring its coverage would report a
      // shortfall that is the operator's doing rather than the shop's.
      const reasons: string[] = []
      await run({ limit: 5, reportIncomplete: (reason: string) => reasons.push(reason) })
      expect(reasons.join(' ')).not.toContain('covered')
    })

    it('stops a department that ignores ?p instead of paging forever', async () => {
      // A small department serves page one again for every ?p, so "fewer than a
      // full page means the end" is wrong in both directions: a leaf would look
      // finished immediately and a full department would loop until the job died.
      // The stop rule is identity -- nothing new means nothing further.
      const { calls } = await run()
      const texPages = calls.filter((u) => u.includes('/tex/femei/'))
      expect(texPages.length).toBeLessThan(5)
    })
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

// ─── Mega Image ──────────────────────────────────────────────────────────────

const MEGA_URLS = {
  spray: 'https://www.mega-image.ro/Curatenie-si-nealimentare/Curatenie-casa/Insecticide/Spray-protector-impotriva-tantarilor-100ml/p/32688',
  catFood: 'https://www.mega-image.ro/Animale-de-companie/Hrana-pisici/Hrana-pisici/Hrana-pentru-pisici-adulte-cu-pui-si-legume-1-5kg/p/26379',
  hairDye: 'https://www.mega-image.ro/Cosmetice-si-ingrijire-personala/Ingrijirea-parului/Vopsea-pentru-par/Vopsea-pentru-par-Ciocolatiu-inchis-W2/p/99467',
}

describe('mega image', () => {
  it('reads the price out of the nested priceSpecification', () => {
    // The whole reason jsonld.ts learned about UnitPriceSpecification. Read the
    // offer alone and every one of 8,879 products arrives with no price.
    const product = jsonLdOf('mega-image/product-instock.html.gz')!
    expect(product.price).toBe(24.19)
    expect(product.currency).toBe('RON')
    expect(product.brand).toBe('Autan')
  })

  it('publishes no barcode, the same accepted cost as Carrefour', () => {
    // Two rows for one product is cosmetic; one row for two products is corrupt.
    // Without a GTIN these merge only when the folded name and size agree.
    for (const fixture of ['mega-image/product-instock.html.gz', 'mega-image/product-b.html.gz']) {
      expect(jsonLdOf(fixture)!.gtin).toBeNull()
    }
  })

  it('takes the id from the /p/ segment, which is the only one there is', () => {
    expect(megaId(MEGA_URLS.spray)).toBe('32688')
    expect(megaId(MEGA_URLS.catFood)).toBe('26379')
    expect(megaId('https://www.mega-image.ro/Ceva/c/003001009')).toBeNull()
  })

  it('reads the shelf off the URL, which carries the whole department path', () => {
    // The one thing this shop gives that Lidl does not. Lidl has to guess a
    // category from words in a product name; here the department is in the path,
    // written by the shop, three levels deep.
    expect(megaCategory(MEGA_URLS.spray)).toBe('household')
    expect(megaCategory(MEGA_URLS.catFood)).toBe('pet')
    expect(megaCategory(MEGA_URLS.hairDye)).toBe('personal-care')
    expect(megaCategory('https://www.mega-image.ro/Lactate-si-oua/Lapte/Lapte-UHT/Ceva/p/1')).toBe('dairy')
    expect(megaCategory('https://www.mega-image.ro/Fructe-si-legume-proaspete/x/y/z/p/1')).toBe('produce')
  })

  it('splits the two departments that hold more than one shelf', () => {
    // Bauturi is drinks AND alcohol; the breakfast aisle is bread AND coffee AND
    // cereal. The top-level name alone would file beer under soft drinks.
    expect(megaCategory('https://www.mega-image.ro/Bauturi/Bere/Bere-blonda/X/p/1')).toBe('alcohol')
    expect(megaCategory('https://www.mega-image.ro/Bauturi/Sucuri/Suc-de-portocale/X/p/1')).toBe('drinks')
    expect(megaCategory('https://www.mega-image.ro/Paine-cafea-cereale-si-mic-dejun/Cafea/Cafea-boabe/X/p/1')).toBe('drinks')
    expect(megaCategory('https://www.mega-image.ro/Paine-cafea-cereale-si-mic-dejun/Paine/Paine-alba/X/p/1')).toBe('bakery')
  })

  it('answers null for a department it has never heard of', () => {
    // Rather than guessing. A product with no shelf is listed by the admin
    // dashboard and can be mapped deliberately; a wrong shelf is invisible.
    expect(megaCategory('https://www.mega-image.ro/Gaming/x/y/p/1')).toBeNull()
  })

  it('builds a listing from a real page', () => {
    const listing = buildMega(jsonLdOf('mega-image/product-instock.html.gz')!, MEGA_URLS.spray)!
    expect(listing.retailer).toBe('mega-image')
    expect(listing.externalId).toBe('32688')
    expect(listing.price).toBe(24.19)
    expect(listing.currency).toBe('RON')
    expect(listing.available).toBe(true)
    expect(listing.category).toBe('household')
    expect(listing.quantity).toBe(100)
    expect(listing.unit).toBe('ml')
    expect(listing.productUrl).toBe(MEGA_URLS.spray)
  })

  it('refuses a page whose URL carries no product id', () => {
    expect(buildMega(jsonLdOf('mega-image/product-instock.html.gz')!, 'https://www.mega-image.ro/x/c/1')).toBeNull()
  })

  it('crawls its sitemap, keeping the products and dropping the departments', async () => {
    const fetchImpl = fixtureFetch([
      { match: '/robots.txt', file: 'mega-image/robots.txt' },
      { match: 'delhaizesitemapindex', file: 'mega-image/sitemap-index.xml' },
      { match: 'delhaizesitemap-', file: 'mega-image/sitemap-products.xml' },
      { match: '/p/', file: 'mega-image/product-instock.html.gz' },
    ])
    const log = testLogger()
    const products = await collect(
      new MegaImageScraper().discoverProducts({ log, fetchImpl, limit: 4, minIntervalMs: 0 }),
      10,
    )
    expect(products.length).toBe(4)
    expect(products.every((p) => p.retailer === 'mega-image')).toBe(true)
    // The six /c/ department pages in the fixture must never be fetched: they
    // carry no Product block, and on the live sitemap there are 1,828 of them.
    expect(callsOf(fetchImpl).some((u) => /\/c\/\d+$/.test(u))).toBe(false)
  })

  it('is incremental, because its sitemap dates every entry', async () => {
    const routes = [
      { match: '/robots.txt', file: 'mega-image/robots.txt' },
      { match: 'delhaizesitemapindex', file: 'mega-image/sitemap-index.xml' },
      { match: 'delhaizesitemap-', file: 'mega-image/sitemap-products.xml' },
      { match: '/p/', file: 'mega-image/product-instock.html.gz' },
    ]
    const run = async (since?: Date) =>
      (await collect(
        new MegaImageScraper().discoverProducts({
          log: testLogger(),
          fetchImpl: fixtureFetch(routes),
          minIntervalMs: 0,
          since,
        }),
        500,
      )).length

    // Compared against the same crawl without a date rather than against a
    // number: the fixture's three shards are one file served three times, so an
    // absolute count would be measuring the fixture. What matters is that a
    // dated run fetches strictly less, and that it still fetches something --
    // the entries here run from June to 9 September.
    const all = await run()
    const recent = await run(new Date('2026-09-08T00:00:00Z'))
    expect(all).toBeGreaterThan(0)
    expect(recent).toBeGreaterThan(0)
    expect(recent).toBeLessThan(all)
  })
})
