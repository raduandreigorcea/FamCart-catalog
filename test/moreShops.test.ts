// Carrefour Italia and MPreis: two sites, two ways of saying which aisle a
// product is in, and one rule -- groceries only.
//
// Carrefour Italia names the aisle in the analytics on the page; MPreis names it
// in the breadcrumb. Pages captured 2026-09-14. (Dia Spain was a third, and
// refuses this crawler; see its note in core/registry.ts.)

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import {
  carrefourItShelf,
  isCarrefourItGrocery,
  buildCarrefourItProduct,
  carrefourItIdFrom,
} from '../src/retailers/carrefour-it/index.ts'
import { mpreisShelf, mpreisIsGrocery, buildMpreisProduct, mpreisIdFrom } from '../src/retailers/mpreis/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

const productOf = (html: string) => readProduct(findProduct(extractJsonLd(html))!)
const scraper = (slug: string) => SCRAPERS.find((s) => s.retailer === slug)!
const robots = { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' }
const urlset = (urls: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc><lastmod>2026-09-14</lastmod></url>`)
    .join('')}</urlset>`

describe('carrefour italia', () => {
  const page = (name: string) => readFixture(`carrefour-it/${name}.html.gz`)
  const keeps = (name: string) => isCarrefourItGrocery(carrefourItShelf(page(name)))

  it('keeps meat, pet food and baby food', () => {
    expect(keeps('food-meat')).toBe(true)
    expect(keeps('pet-food')).toBe(true)
    expect(keeps('baby-food')).toBe(true)
  })

  it('drops appliances, and the toys in the baby aisle', () => {
    expect(keeps('appliance')).toBe(false)
    expect(keeps('baby-toy')).toBe(false)
  })

  it('reads a label with an accent or an apostrophe the same as without', () => {
    expect(isCarrefourItGrocery(carrefourItShelf('"item_category":"Uova, latte e latticini"'))).toBe(true)
    expect(isCarrefourItGrocery(carrefourItShelf('"item_category":"Articoli per la casa e per la tua auto"'))).toBe(false)
  })

  it('takes the barcode from the URL, and not a counter code', () => {
    const whiskas = 'https://www.carrefour.it/p/whiskas-sticks-snack-gatto-con-manzo-3-pezzi-18-g/4008429046537.html'
    const steak = 'https://www.carrefour.it/p/costata-con-osso-di-scottona/2101083000000.html'
    expect(buildCarrefourItProduct(productOf(page('pet-food')), whiskas, carrefourItShelf(page('pet-food')))).toMatchObject({
      retailer: 'carrefour-it',
      externalId: '4008429046537',
      gtin: '4008429046537',
      currency: 'EUR',
      category: 'pet',
    })
    expect(buildCarrefourItProduct(productOf(page('food-meat')), steak, carrefourItShelf(page('food-meat')))!.gtin).toBeNull()
    expect(carrefourItIdFrom('https://www.carrefour.it/c/spesa-online/carne/')).toBeNull()
  })

  it('crawls the groceries and reports the rest', async () => {
    const steak = 'https://www.carrefour.it/p/costata-con-osso-di-scottona/2101083000000.html'
    const coffee = 'https://www.carrefour.it/p/lavazza-jolie-evo-macchina-per-caffe-a-capsule-06-l/8000070073401.html'
    const excluded: string[] = []
    const products = await collect(
      scraper('carrefour-it').discoverProducts({
        log: testLogger(),
        minIntervalMs: 0,
        reportExcluded: (id: string) => excluded.push(id),
        fetchImpl: fixtureFetch([
          robots,
          { match: 'sitemap_0-product.xml', body: urlset([steak, coffee]) },
          { match: 'costata', file: 'carrefour-it/food-meat.html.gz' },
          { match: 'lavazza', file: 'carrefour-it/appliance.html.gz' },
        ]),
      }),
    )
    expect(products.map((p) => p.externalId)).toEqual(['2101083000000'])
    expect(excluded).toEqual(['8000070073401'])
  })
})

describe('mpreis', () => {
  const crumbs = (...links: string[]) =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'BreadcrumbList',
      itemListElement: links.map((item, i) => ({ '@type': 'ListItem', position: i + 1, item })),
    })}</script>`

  it('reads the shelf from the deepest category link', () => {
    expect(mpreisShelf(readFixture('mpreis/food.html.gz'))).toMatch(/^lebensmittel\//)
    expect(
      mpreisShelf(crumbs('https://www.mpreis.at/shop/c/drogerie-26028721', 'https://www.mpreis.at/shop/c/drogerie/blumen-123')),
    ).toBe('drogerie/blumen')
  })

  it('keeps food, drinks and the drugstore a shopping list needs', () => {
    expect(mpreisIsGrocery(mpreisShelf(readFixture('mpreis/food.html.gz')))).toBe(true)
    expect(mpreisIsGrocery('getraenke/bier')).toBe(true)
    expect(mpreisIsGrocery('drogerie/wasch-putzmittel')).toBe(true)
  })

  it('drops flowers, magazines, the Tchibo corner, and a product with no category', () => {
    expect(mpreisIsGrocery('drogerie/blumen')).toBe(false)
    expect(mpreisIsGrocery('drogerie/zeitschriften-zeitungen')).toBe(false)
    expect(mpreisIsGrocery('drogerie/tchibo-eduscho')).toBe(false)
    expect(mpreisIsGrocery(null)).toBe(false)
  })

  it('builds a listing with a barcode', () => {
    const html = readFixture('mpreis/food.html.gz')
    const listing = buildMpreisProduct(productOf(html), 'https://www.mpreis.at/shop/p/example-123456', mpreisShelf(html))!
    expect(listing).toMatchObject({ retailer: 'mpreis', externalId: '123456', currency: 'EUR' })
    expect(listing.price).toBeGreaterThan(0)
    expect(mpreisIdFrom('https://www.mpreis.at/shop/c/lebensmittel-50234186')).toBeNull()
  })

  it('crawls a grocery page', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      { match: 'sitemap.xml', body: urlset(['https://www.mpreis.at/shop/p/example-123456']) },
      { match: '/shop/p/', file: 'mpreis/food.html.gz' },
    ])
    const products = await collect(scraper('mpreis').discoverProducts({ log: testLogger(), minIntervalMs: 0, fetchImpl }))
    expect(products).toHaveLength(1)
    expect(callsOf(fetchImpl).some((u) => u.includes('/shop/p/example-123456'))).toBe(true)
  })
})
