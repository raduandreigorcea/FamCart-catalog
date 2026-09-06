// Lidl Romania: Nuxt, read through its product sitemap and the schema.org
// Product block on each page.
//
// THE SMALL ONE, AND THE BEST DATA. 511 products -- Lidl RO has no general
// webshop, so these are assortment pages for what is on the shelves rather than
// a catalog you can order from. Small enough to crawl in full every run, which
// means no incremental machinery and no lastmod (the sitemap carries none).
//
// It is the ONLY retailer here that publishes a GTIN, on about a third of its
// products. Those are the rows that let a Lidl listing merge with an Auchan one
// for the same article, and they are worth more than their number suggests: a
// merged product gets both shops' wording in its search blob and both prices.
//
// TWO QUIRKS, BOTH REAL AND BOTH FOUND ON LIVE PAGES:
//
//   * availability is bare ("OutOfStock", "InStoreOnly"), not the full
//     schema.org URL Carrefour uses. InStoreOnly is the common case and counts
//     as available -- it is a supermarket, the products are in the shop.
//   * `offers` is an ARRAY and only the in-stock entry carries a price, so a
//     product can legitimately arrive with no price at all. A shopping list
//     still wants it.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.lidl.ro'
const SITEMAP = `${ORIGIN}/p/export/RO/ro/product_sitemap.xml.gz`

/**
 * The id at the end of a Lidl product URL: /p/{slug}/p{id}
 *
 * Preferred over the JSON-LD sku, which is variant-level and longer -- the page
 * for p11000189 reports sku "11000189121". Using the sku would make a listing's
 * id change the moment Lidl reorganises a variant, and a changed id is a new
 * listing plus a swept old one on every run.
 */
export function externalIdFrom(url: string, sku: string | null): string | null {
  const match = /\/p(\d{4,})(?:\?|#|$)/.exec(url)
  if (match) return match[1]
  return sku && /^[0-9]{4,}$/.test(sku) ? sku : null
}

/**
 * Lidl's URL slug is the only category hint, and it is a product name rather
 * than a department, so this recognises very little. Null is the honest answer;
 * the admin dashboard can list the products with no shelf.
 */
export function categoryFromSlug(url: string): Category | null {
  const slug = url.toLowerCase()
  if (/lapte|iaurt|branza|smantana|unt|cascaval/.test(slug)) return 'dairy'
  if (/paine|focaccia|bougatsa|croissant|cornuri/.test(slug)) return 'bakery'
  if (/pui|porc|vita|sunca|carnati|salam|mezel/.test(slug)) return 'meat'
  if (/peste|somon|ton|creveti/.test(slug)) return 'fish'
  if (/ciocolata|biscuiti|napolitane|chips|snack/.test(slug)) return 'snacks'
  if (/detergent|balsam-rufe|clor|degresant/.test(slug)) return 'household'
  if (/sampon|gel-de-dus|deodorant|pasta-de-dinti/.test(slug)) return 'personal-care'
  if (/bere|vin|whisky|vodka/.test(slug)) return 'alcohol'
  if (/apa|suc|nectar|cafea|ceai/.test(slug)) return 'drinks'
  if (/legume|fructe|mere|banane|rosii|cartofi/.test(slug)) return 'produce'
  return null
}

export function buildProduct(product: JsonLdProduct, url: string): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = externalIdFrom(url, product.sku)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: 'lidl',
    externalId,
    name,
    brand: usableBrand(product.brand),
    gtin: validGtin(product.gtin),
    price,
    currency: price === null ? null : (product.currency ?? 'RON'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: categoryFromSlug(url),
    imageUrl: httpsUrl(product.image),
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class LidlScraper implements RetailerScraper {
  readonly retailer = 'lidl'
  readonly country: Market = 'RO'
  readonly domain = 'lidl.ro'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    // Lidl disallows /q/search and a handful of asset paths, not /p/. Checking a
    // representative product URL rather than the origin is the point: a rule that
    // appears later could disallow exactly the thing we came for.
    if (!isAllowed(robots, `${ORIGIN}/p/example/p11000000`)) {
      throw new Error('lidl robots.txt disallows product pages; refusing to crawl')
    }

    if (ctx.since) {
      ctx.log.info('lidl publishes no lastmod; crawling all 500-odd products, which is cheap')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      // No lastmod in this sitemap, so an incremental run would silently fetch
      // everything anyway. Saying so is better than implying a saving.
      supportsIncremental: false,
      urlFilter: (url) => /\/p\/[^/]+\/p\d+/.test(url),
      build: (product, url) => buildProduct(product, url),
    })
  }
}

export const lidl = new LidlScraper()
