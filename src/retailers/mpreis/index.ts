// MPreis, the Tyrolean supermarket: its online shop, read through the sitemap
// and the schema.org blocks on each page. Checked 2026-09-14.
//
// 12,788 products with dated sitemap entries, a price, and -- unusually -- a
// barcode on most of them.
//
// ONLY THE GROCERIES, by the breadcrumb. Its links name the shop's own tree
// (/shop/c/lebensmittel/suesses-salziges-1118774), which has three roots: food,
// drinks, and a drugstore. Food and drinks are imported whole. The drugstore
// keeps what a shopping list holds -- baby care, household goods, pet food,
// personal care, detergents -- and drops flowers, vouchers, cards and souvenirs,
// magazines, the Tchibo corner and "specials". A product with no category is
// refused.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { breadcrumbLinks } from '../../core/breadcrumb.ts'
import { parseQuantity, validGtin, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.mpreis.at'
const SITEMAP = `${ORIGIN}/sitemap.xml`
const PRODUCT_URL = /\/shop\/p\/[^/]+-(\d+)\/?$/

const SHELVES: Record<string, Category | null> = {
  'lebensmittel/obst': 'produce',
  'lebensmittel/gemuese': 'produce',
  'lebensmittel/fleisch-wurst': 'meat',
  'lebensmittel/fisch': 'fish',
  'lebensmittel/milch-eier': 'dairy',
  'lebensmittel/brot-gebaeck': 'bakery',
  'lebensmittel/grundnahrung': 'pantry',
  'lebensmittel/konserven-fertiggerichte-suppen': 'pantry',
  'lebensmittel/suesses-salziges': 'snacks',
  'lebensmittel/tiefkuehl': 'frozen',
  'lebensmittel/to-go': null,
  'getraenke/wasser-limonaden-energy-drinks': 'drinks',
  'getraenke/saefte-sirup': 'drinks',
  'getraenke/kaffee-tee-kakao': 'drinks',
  'getraenke/bier': 'alcohol',
  'getraenke/wein-schaumwein': 'alcohol',
  'getraenke/spirituosen': 'alcohol',
  'drogerie/baby': 'baby',
  'drogerie/haushalt': 'household',
  'drogerie/wasch-putzmittel': 'household',
  'drogerie/haustiere': 'pet',
  'drogerie/pflege': 'personal-care',
}

// Whole roots: an aisle MPreis adds under food or drinks is still groceries.
const GROCERY_ROOTS = new Set(['lebensmittel', 'getraenke'])

export function mpreisIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(new URL(url).pathname)?.[1] ?? null
}

/** "root/aisle" from the deepest category link, ids stripped -- or the root alone, or null. */
export function mpreisShelf(html: string): string | null {
  let best: string[] | null = null
  for (const link of breadcrumbLinks(html)) {
    const match = /\/shop\/c\/([^?#]+)/.exec(link)
    if (!match) continue
    const segments = match[1].split('/').filter(Boolean).map((s) => s.replace(/-\d+$/, ''))
    if (!best || segments.length > best.length) best = segments
  }
  return best ? best.slice(0, 2).join('/') : null
}

export function mpreisIsGrocery(shelf: string | null): boolean {
  if (shelf === null) return false
  const root = shelf.split('/')[0]
  if (GROCERY_ROOTS.has(root)) return true
  return Object.prototype.hasOwnProperty.call(SHELVES, shelf)
}

export function buildMpreisProduct(product: JsonLdProduct, url: string, shelf: string | null): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = mpreisIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: 'mpreis',
    externalId,
    name,
    brand: usableBrand(product.brand),
    gtin: validGtin(product.gtin),
    price,
    currency: price === null ? null : (product.currency ?? 'EUR'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf !== null ? (SHELVES[shelf] ?? null) : null,
    imageUrl: httpsUrl(product.image),
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class MpreisScraper implements RetailerScraper {
  readonly retailer = 'mpreis'
  readonly country: Market = 'AT'
  readonly domain = 'mpreis.at'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/shop/p/example-1`)) {
      throw new Error('mpreis robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: true,
      urlFilter: (url) => PRODUCT_URL.test(new URL(url).pathname),
      keep: (html) => mpreisIsGrocery(mpreisShelf(html)),
      idOf: (url) => mpreisIdFrom(url),
      build: (product, url, html) => buildMpreisProduct(product, url, mpreisShelf(html)),
    })
  }
}

export const mpreis = new MpreisScraper()
