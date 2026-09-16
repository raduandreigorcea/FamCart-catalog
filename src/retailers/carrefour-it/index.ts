// Carrefour Italia: a different site from carrefour.ro, read through its product
// sitemap and the schema.org Product block on each page. Checked 2026-09-14.
//
// 26,714 products, every sitemap entry dated, so a nightly run fetches what moved.
//
// THE BARCODE IS IN THE URL. /p/pepsi-330-ml/0000040608006.html -- the number is
// the product's EAN, and the id this listing is keyed on. Unlike Carrefour
// Romania, which publishes none, so an Italian Carrefour listing merges across
// shops. Numbers starting with 2 are Carrefour's own codes for goods weighed at
// the counter (a steak, 2101083000000) and are NOT barcodes anyone else shares.
//
// ONLY THE GROCERIES, by the category Carrefour's own analytics names on every
// page ("item_category":"Carne"). The Product block and the breadcrumb carry
// none. Its site is a supermarket (spesa online) beside a department store --
// appliances, garden furniture, toys, televisions -- and only the supermarket's
// aisles are read, with baby toys taken out of the baby aisle.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.carrefour.it'
const SITEMAP = `${ORIGIN}/sitemap_0-product.xml`
const PRODUCT_URL = /\/p\/[^/]+\/(\d{6,})\.html$/

export function carrefourItIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(url.replace(/[?#].*$/, ''))?.[1] ?? null
}

const fold = (value: string): string =>
  value
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// The supermarket's aisles, as the analytics names them, folded. Read from one
// product in every aisle of /spesa-online/ on 2026-09-14 -- the aisle's URL slug
// and its label differ ("cura-della-casa" is "Cura casa"), so the labels are what
// is listed. A null shelf is groceries that span several of ours.
const AISLES: Record<string, Category | null> = {
  'frutta e verdura': 'produce',
  carne: 'meat',
  pesce: 'fish',
  'uova latte e latticini': 'dairy',
  'formaggi e salumi': null,
  'pane e snack salati': 'bakery',
  'pasta riso e farina': 'pantry',
  'condimenti e conserve': 'pantry',
  'dolci e prima colazione': null,
  'gelati e surgelati': 'frozen',
  gastronomia: null,
  'acqua succhi e bibite': 'drinks',
  'birra vino e liquori': 'alcohol',
  'cura casa': 'household',
  'cura persona': 'personal-care',
  'salute e benessere': 'health',
  animali: 'pet',
  'prima infanzia': 'baby',
}

// The baby aisle sells toys and pushchairs beside baby food and nappies.
const NOT_BABY_GROCERIES = /giochi|giocattol|abbigliament|passeggin|seggiolin|culle|lettin|arred|sicurezza/

export interface CarrefourItShelf {
  aisle: string | null
  subAisle: string | null
}

/** The first item_category pair on the page: the product's own view event. */
export function carrefourItShelf(html: string): CarrefourItShelf {
  const aisle = /"item_category"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? ''
  const subAisle = /"item_category2"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? ''
  return { aisle: aisle ? fold(aisle) : null, subAisle: subAisle ? fold(subAisle) : null }
}

export function isCarrefourItGrocery(shelf: CarrefourItShelf): boolean {
  if (shelf.aisle === null || !Object.prototype.hasOwnProperty.call(AISLES, shelf.aisle)) return false
  if (shelf.aisle === 'prima infanzia' && NOT_BABY_GROCERIES.test(shelf.subAisle ?? '')) return false
  return true
}

export function buildCarrefourItProduct(
  product: JsonLdProduct,
  url: string,
  shelf: CarrefourItShelf,
): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = carrefourItIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: 'carrefour-it',
    externalId,
    name,
    brand: usableBrand(product.brand),
    // A counter code (2...) is Carrefour's alone; validGtin does not know that.
    gtin: externalId.startsWith('2') ? null : validGtin(externalId),
    price,
    currency: price === null ? null : (product.currency ?? 'EUR'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf.aisle !== null ? (AISLES[shelf.aisle] ?? null) : null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class CarrefourItScraper implements RetailerScraper {
  readonly retailer = 'carrefour-it'
  readonly country: Market = 'IT'
  readonly domain = 'carrefour.it'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/p/example/8000000000000.html`)) {
      throw new Error('carrefour-it robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: true,
      urlFilter: (url) => PRODUCT_URL.test(url.replace(/[?#].*$/, '')),
      keep: (html) => isCarrefourItGrocery(carrefourItShelf(html)),
      idOf: (url) => carrefourItIdFrom(url),
      build: (product, url, html) => buildCarrefourItProduct(product, url, carrefourItShelf(html)),
    })
  }
}

export const carrefourIt = new CarrefourItScraper()
