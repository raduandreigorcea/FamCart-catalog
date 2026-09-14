// Aldi: one platform, six countries, and only the groceries.
//
// Aldi Süd (Germany), Hofer (Austria), Aldi Suisse, Aldi Italia, Aldi UK and
// Aldi Ireland run the same site: a product at /produkt/ (or /prodotto/,
// /product/) ending in a long numeric id, a schema.org Product with a price and
// no barcode, and a BreadcrumbList whose third item links the product's
// top-level category. Captured from the live sites on 2026-09-14.
//
// THE FILTER READS THAT CATEGORY LINK, not the product name and not the label
// beside the link. The label is in five languages and marketing copy; the URL
// slug is the shop's own stable key for the shelf. Each country lists the
// shelves that are groceries -- an allowlist, so an unknown or missing shelf is
// refused. That costs Hofer real food (half its products carry no category at
// all) and is still the right direction: a missing chip is a smaller lie than a
// hedge trimmer in a shopping list.

import { describe, it, expect } from 'vitest'
import { readFixture, fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { extractJsonLd, findProduct, readProduct } from '../src/core/jsonld.ts'
import { ALDI_COUNTRIES, aldiShelf, isAldiGrocery, buildAldiProduct, aldiIdFrom } from '../src/retailers/aldi/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'
import { MARKETS } from '../src/core/types.ts'

const page = (name: string): string => readFixture(`aldi/${name}.html.gz`)
const country = (slug: string) => ALDI_COUNTRIES.find((c) => c.slug === slug)!
const keeps = (slug: string, name: string) => isAldiGrocery(country(slug), aldiShelf(page(name)))

describe('the Aldi countries', () => {
  it('gives every country a unique slug and a market the app can derive', () => {
    const slugs = ALDI_COUNTRIES.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const c of ALDI_COUNTRIES) expect(MARKETS).toContain(c.country)
  })

  it('registers a scraper for every country, on its own domain', () => {
    for (const c of ALDI_COUNTRIES) {
      const scraper = SCRAPERS.find((s) => s.retailer === c.slug)
      expect(scraper, c.slug).toBeDefined()
      expect(scraper!.country).toBe(c.country)
      expect(`https://www.${scraper!.domain}`).toBe(c.origin)
    }
  })
})

describe('reading the shelf', () => {
  it('takes the top-level category out of the breadcrumb link', () => {
    expect(aldiShelf(page('de-food'))).toBe('milchprodukte-eier')
    expect(aldiShelf(page('ch-de-food'))).toBe('fruehstueck')
    expect(aldiShelf(page('gb-food'))).toBe('fresh-food')
    expect(aldiShelf(page('it-food'))).toBe('prodotti-refrigerati')
    expect(aldiShelf(page('ie-clothing'))).toBe('specialbuys')
  })

  it('reads no shelf from a page whose breadcrumb names no category', () => {
    expect(aldiShelf(page('at-nocategory'))).toBeNull()
  })
})

describe('which shelves are groceries', () => {
  it('keeps food in every language', () => {
    expect(keeps('aldi-de', 'de-food')).toBe(true)
    expect(keeps('aldi-ch', 'ch-de-food')).toBe(true)
    expect(keeps('aldi-it', 'it-food')).toBe(true)
    expect(keeps('aldi-gb', 'gb-food')).toBe(true)
  })

  it('keeps pet food', () => {
    expect(keeps('aldi-gb', 'gb-pet')).toBe(true)
  })

  it('drops clothing, hobby and the weekly special buys', () => {
    expect(keeps('aldi-de', 'de-clothing')).toBe(false) // fahrrad-zubehoer
    expect(keeps('aldi-it', 'it-nonfood')).toBe(false) // tempo-libero-e-attivita-outdoor
    expect(keeps('aldi-gb', 'gb-specialbuys')).toBe(false)
    expect(keeps('aldi-ie', 'ie-clothing')).toBe(false)
  })

  it('drops a product with no category at all', () => {
    expect(keeps('hofer', 'at-nocategory')).toBe(false) // a street sweeper
  })

  it('reads each country against its OWN list', () => {
    // `fresh-food` is a British slug. The same word in another country's list
    // would be a coincidence to rely on, not a rule.
    expect(isAldiGrocery(country('aldi-de'), 'fresh-food')).toBe(false)
    expect(isAldiGrocery(country('aldi-gb'), 'fresh-food')).toBe(true)
  })
})

describe('building a listing', () => {
  const productOf = (html: string) => readProduct(findProduct(extractJsonLd(html))!)

  it('reads name, brand, price and the shelf as a category', () => {
    const url = 'https://www.aldi-sued.de/produkt/milsani-fruchtbuttermilch-dessert-200-g-erdbeere-000000000202694001'
    const listing = buildAldiProduct(productOf(page('de-food')), url, country('aldi-de'), 'milchprodukte-eier')!
    expect(listing).toMatchObject({
      retailer: 'aldi-de',
      externalId: '000000000202694001',
      brand: 'MILSANI',
      price: 0.59,
      currency: 'EUR',
      category: 'dairy',
      gtin: null,
      available: true,
    })
  })

  it('names a British product in pounds', () => {
    const url = 'https://www.aldi.co.uk/product/ready-set-cook-washed-ready-to-cook-straight-to-wok-beansprouts-000000000000339761'
    const listing = buildAldiProduct(productOf(page('gb-food')), url, country('aldi-gb'), 'fresh-food')!
    expect(listing).toMatchObject({ retailer: 'aldi-gb', currency: 'GBP', price: 0.95 })
  })

  it('takes the id from the end of the URL, however long it is', () => {
    expect(aldiIdFrom('https://www.aldi.it/prodotto/home-creation-tela-per-dipingere-7395181588161431404114')).toBe(
      '7395181588161431404114',
    )
    expect(aldiIdFrom('https://www.aldi-sued.de/produkte/kaese/k/1588161425467082')).toBeNull()
  })
})

describe('crawling a country', () => {
  const robots = { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' }
  const urlset = (urls: string[]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${u}</loc><lastmod>2026-09-14</lastmod></url>`)
      .join('')}</urlset>`

  it('imports the groceries and skips the rest', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: '/sitemap_products.xml',
        body: urlset([
          'https://www.aldi-sued.de/produkt/milsani-fruchtbuttermilch-dessert-200-g-erdbeere-000000000202694001',
          'https://www.aldi-sued.de/produkt/crane-damen-regenhose-m-40-42-000000000736939002',
          'https://www.aldi-sued.de/produkte/kaese/k/1588161425467082',
        ]),
      },
      { match: 'fruchtbuttermilch', file: 'aldi/de-food.html.gz' },
      { match: 'regenhose', file: 'aldi/de-clothing.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'aldi-de')!
    const products = await collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))
    expect(products.map((p) => p.retailer + ':' + p.externalId)).toEqual(['aldi-de:000000000202694001'])
    // The category page in the sitemap is never fetched.
    expect(callsOf(fetchImpl).some((u) => u.includes('/k/'))).toBe(false)
  })

  it('reads the German half of Switzerland only', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: '/de/sitemap_products.xml',
        body: urlset([
          'https://www.aldi-suisse.ch/de/produkt/happy-harvest-porridge-im-doypack-fruechte-000000000332657003',
        ]),
      },
      { match: 'porridge', file: 'aldi/ch-de-food.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'aldi-ch')!
    const products = await collect(scraper.discoverProducts({ log: testLogger(), fetchImpl, minIntervalMs: 0 }))
    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({ currency: 'CHF', category: 'pantry' })
    expect(callsOf(fetchImpl).some((u) => u.includes('/fr/') || u.includes('/it/'))).toBe(false)
  })
})
