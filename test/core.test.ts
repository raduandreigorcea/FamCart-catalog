// Quantity parsing, barcodes, sitemaps, JSON-LD and robots.txt.
//
// The quantity parser gets the most attention here because it feeds the merge
// key, and the merge key decides whether two products are one product. Getting
// "6 x 0,5 L" wrong puts a crate and a bottle in the same row.

import { describe, it, expect } from 'vitest'
import { parseQuantity, stripQuantity, validGtin, httpsUrl, usableBrand } from '../src/core/normalize.ts'
import { parseUrlset, parseSitemapIndex } from '../src/core/sitemap.ts'
import { extractJsonLd, findProduct, readProduct, isAvailable } from '../src/core/jsonld.ts'
import { parseRobots, isAllowed } from '../src/core/robots.ts'
import { readFixture } from './helpers.ts'

describe('parseQuantity', () => {
  it('reads the shapes Romanian shops actually write', () => {
    expect(parseQuantity('Lapte UHT Zuzu 3.5% 1L')).toEqual({ quantity: 1, unit: 'l' })
    expect(parseQuantity('Apa plata Dorna 1,5 l')).toEqual({ quantity: 1.5, unit: 'l' })
    expect(parseQuantity('Alune prajite Nutline, 135 g')).toEqual({ quantity: 135, unit: 'g' })
    expect(parseQuantity('Banane, +/- 1 kg')).toEqual({ quantity: 1, unit: 'kg' })
    expect(parseQuantity('Iaurt grecesc 450ml')).toEqual({ quantity: 450, unit: 'ml' })
    expect(parseQuantity('Oua proaspete 10 bucati')).toEqual({ quantity: 10, unit: 'buc' })
  })

  it('multiplies a multipack out', () => {
    // A crate is three litres and a bottle is half of one. Treating them alike
    // is how they end up sharing a row.
    expect(parseQuantity('Bere Ursus 6 x 0,5 L')).toEqual({ quantity: 3, unit: 'l' })
    expect(parseQuantity('Apa 12x2l')).toEqual({ quantity: 24, unit: 'l' })
  })

  it('converts centilitres, which the catalog does not store', () => {
    expect(parseQuantity('Vin rosu 75 cl')).toEqual({ quantity: 750, unit: 'ml' })
  })

  it('never mistakes a percentage for a size', () => {
    // The most common number in a Romanian dairy aisle.
    expect(parseQuantity('Lapte 3.5%')).toBeNull()
    expect(parseQuantity('Smantana 12% grasime')).toBeNull()
  })

  it('takes the LAST size, because that is where the pack size lives', () => {
    expect(parseQuantity('Lapte 3.5% Zuzu 1 L')).toEqual({ quantity: 1, unit: 'l' })
  })

  it('returns null rather than guessing', () => {
    expect(parseQuantity('Paine de casa')).toBeNull()
    expect(parseQuantity('')).toBeNull()
    expect(parseQuantity(null)).toBeNull()
  })
})

describe('stripQuantity', () => {
  it('removes the size and the approximation marker it hides behind', () => {
    expect(stripQuantity('Banane, +/- 1 kg').toLowerCase()).not.toContain('+')
    expect(stripQuantity('Apa Dorna 2 l').trim()).toBe('Apa Dorna')
  })

  it('leaves a name with no size alone', () => {
    expect(stripQuantity('Paine de casa')).toBe('Paine de casa')
  })
})

describe('validGtin', () => {
  it('accepts a code whose check digit works out', () => {
    expect(validGtin('5942219115845')).toBe('5942219115845')
    expect(validGtin('4056489114703')).toBe('4056489114703')
  })

  it('refuses an internal reference that only looks like one', () => {
    // Auchan files loose produce under 13-digit codes of this shape. A wrong
    // barcode is worse than none: it is the highest-priority match there is.
    expect(validGtin('2122142000000')).toBeNull()
  })

  it('refuses the wrong shape entirely', () => {
    expect(validGtin('abc')).toBeNull()
    expect(validGtin('123')).toBeNull()
    expect(validGtin(null)).toBeNull()
    expect(validGtin('')).toBeNull()
  })
})

describe('usableBrand', () => {
  it('drops the placeholders shops write instead of a brand', () => {
    // Both found in live data: VTEX puts "Non-brand" under loose produce, and
    // Lidl ships "Dummymarke" -- German for dummy brand -- across its flower
    // range. Stored, either one invents a maker for a product that has none.
    expect(usableBrand('Non-brand')).toBeNull()
    expect(usableBrand('Dummymarke')).toBeNull()
    expect(usableBrand('n/a')).toBeNull()
    expect(usableBrand('  ')).toBeNull()
    expect(usableBrand(null)).toBeNull()
  })

  it('is case and accent insensitive, because shops are not consistent', () => {
    expect(usableBrand('NON-BRAND')).toBeNull()
    expect(usableBrand('Fără marcă')).toBeNull()
  })

  it('keeps a short brand, which is not the same as a placeholder', () => {
    // W5 and Ja! are real Lidl own-brands. Guessing from length would delete
    // them, which is why this matches known values instead.
    expect(usableBrand('W5')).toBe('W5')
    expect(usableBrand('Ja!')).toBe('Ja!')
    expect(usableBrand('Zuzu')).toBe('Zuzu')
  })

  it('refuses one too long for the column', () => {
    expect(usableBrand('x'.repeat(81))).toBeNull()
  })
})

describe('httpsUrl', () => {
  it('insists on https and upgrades a protocol-relative URL', () => {
    expect(httpsUrl('https://a.test/x.jpg')).toBe('https://a.test/x.jpg')
    expect(httpsUrl('//a.test/x.jpg')).toBe('https://a.test/x.jpg')
    expect(httpsUrl('http://a.test/x.jpg')).toBeNull()
    expect(httpsUrl(null)).toBeNull()
  })

  it('refuses one too long for the column', () => {
    expect(httpsUrl('https://a.test/' + 'x'.repeat(2000))).toBeNull()
  })
})

describe('sitemaps', () => {
  it('reads a real Carrefour urlset, with its lastmod', () => {
    const entries = parseUrlset(readFixture('carrefour/sitemap-products.xml'))
    expect(entries.length).toBe(50)
    expect(entries[0].loc).toContain('https://carrefour.ro/produse/')
    expect(entries[0].lastmod).toBeInstanceOf(Date)
  })

  it('reads a real Lidl urlset, which carries no lastmod', () => {
    const entries = parseUrlset(readFixture('lidl/sitemap-products.xml'))
    expect(entries.length).toBe(50)
    expect(entries[0].loc).toMatch(/\/p\/.+\/p\d+/)
    expect(entries[0].lastmod).toBeNull()
  })

  it('reads an index', () => {
    const nested = parseSitemapIndex(readFixture('carrefour/sitemap-index.xml'))
    expect(nested.length).toBeGreaterThan(0)
    expect(nested[0]).toContain('sitemap')
  })

  it('does not mistake a urlset for an index', () => {
    expect(parseSitemapIndex(readFixture('lidl/sitemap-products.xml'))).toEqual([])
  })
})

describe('JSON-LD', () => {
  it('skips a malformed block rather than losing the page', () => {
    const html = `
      <script type="application/ld+json">{ this is not json </script>
      <script type="application/ld+json">{"@type":"Product","name":"Real"}</script>`
    const product = findProduct(extractJsonLd(html))
    expect(product).not.toBeNull()
    expect(readProduct(product!).name).toBe('Real')
  })

  it('finds a Product inside an @graph', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Buried"}]}</script>`
    expect(readProduct(findProduct(extractJsonLd(html))!).name).toBe('Buried')
  })

  it('prefers the offer that actually names a price', () => {
    // Lidl ships several offers and only the in-stock one has a number.
    const html = `<script type="application/ld+json">{"@type":"Product","name":"X","offers":[
      {"@type":"Offer","availability":"OutOfStock"},
      {"@type":"Offer","price":9.99,"priceCurrency":"RON","availability":"InStock"}]}</script>`
    const product = readProduct(findProduct(extractJsonLd(html))!)
    expect(product.price).toBe(9.99)
  })

  it('reads a comma decimal separator', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"X","offers":{"price":"11,99"}}</script>`
    expect(readProduct(findProduct(extractJsonLd(html))!).price).toBe(11.99)
  })

  it('takes the first of an array of gtin13 values', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"X","gtin13":["4056489114703"]}</script>`
    expect(readProduct(findProduct(extractJsonLd(html))!).gtin).toBe('4056489114703')
  })
})

describe('availability', () => {
  it('reads the full schema.org URL Carrefour uses', () => {
    expect(isAvailable('https://schema.org/InStock')).toBe(true)
    expect(isAvailable('https://schema.org/OutOfStock')).toBe(false)
  })

  it('reads the bare form Lidl uses', () => {
    expect(isAvailable('OutOfStock')).toBe(false)
    // A supermarket with no webshop marks its whole assortment this way.
    // Calling it unavailable would mark the whole Lidl catalog gone.
    expect(isAvailable('InStoreOnly')).toBe(true)
  })

  it('treats an absent value as not available rather than assuming', () => {
    expect(isAvailable(null)).toBe(false)
  })
})

describe('robots.txt', () => {
  it('allows what the three retailers actually allow', () => {
    const auchan = parseRobots(readFixture('auchan/robots.txt'))
    expect(isAllowed(auchan, 'https://www.auchan.ro/api/catalog_system/pub/products/search')).toBe(true)

    const carrefour = parseRobots(readFixture('carrefour/robots.txt'))
    expect(isAllowed(carrefour, 'https://carrefour.ro/produse/lapte-1-12345678')).toBe(true)
    // And genuinely disallows what it disallows.
    expect(isAllowed(carrefour, 'https://carrefour.ro/catalogsearch/result')).toBe(false)

    const lidl = parseRobots(readFixture('lidl/robots.txt'))
    expect(isAllowed(lidl, 'https://www.lidl.ro/p/ciocolata/p11000152')).toBe(true)
  })

  it('lets a longer Allow beat a shorter Disallow', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /etc.clientlibs/\nAllow: /etc.clientlibs/kaufland')
    expect(isAllowed(robots, 'https://x.test/etc.clientlibs/other')).toBe(false)
    expect(isAllowed(robots, 'https://x.test/etc.clientlibs/kaufland/a.js')).toBe(true)
  })

  it('treats an empty Disallow as permission, not prohibition', () => {
    // Inverting this would stop every scraper here.
    const robots = parseRobots('User-agent: *\nDisallow:')
    expect(isAllowed(robots, 'https://x.test/anything')).toBe(true)
  })

  it('applies a run of User-agent lines to one group', () => {
    const robots = parseRobots('User-agent: Googlebot\nUser-agent: *\nDisallow: /private')
    expect(isAllowed(robots, 'https://x.test/private/a')).toBe(false)
  })

  it('ignores a group aimed at somebody else', () => {
    const robots = parseRobots('User-agent: EvilBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin')
    expect(isAllowed(robots, 'https://x.test/products')).toBe(true)
    expect(isAllowed(robots, 'https://x.test/admin')).toBe(false)
  })

  it('handles wildcards and end anchors', () => {
    const robots = parseRobots('User-agent: *\nDisallow: /*?order=\nDisallow: /tmp$')
    expect(isAllowed(robots, 'https://x.test/list?order=asc')).toBe(false)
    expect(isAllowed(robots, 'https://x.test/tmp')).toBe(false)
    expect(isAllowed(robots, 'https://x.test/tmpfile')).toBe(true)
  })

  it('collects the sitemaps, which is how two scrapers start', () => {
    const robots = parseRobots(readFixture('lidl/robots.txt'))
    expect(robots.sitemaps.some((s) => s.includes('sitemap'))).toBe(true)
  })

  it('treats an unreachable robots.txt as no rules stated', () => {
    // A 404 is the documented case and all three of these sites rely on it for
    // some path or another.
    expect(isAllowed({ rules: [], crawlDelayMs: null, sitemaps: [], unavailable: true }, 'https://x.test/a'))
      .toBe(true)
  })
})
