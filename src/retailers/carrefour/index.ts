// Carrefour Romania: Magento, read through its sitemap and the schema.org
// Product block on each page.
//
// WHY NOT GRAPHQL. Magento exposes /graphql, and a POST to it from anything that
// is not the shop's own front end returns 403 behind a Cloudflare challenge.
// That is Carrefour saying no to that door, so we use the front one: the product
// pages, which are public, indexed, and allowed by robots.txt.
//
// WHAT IT COSTS, AND IT IS MORE THAN IT LOOKS. 85,121 product URLs across the
// index's two files. At one request a second that is about a day and ~25 GB for
// a first run, so it is a job to start deliberately.
//
// The count is easy to get wrong by reading: sitemap_001 opens with hundreds of
// department pages and looks like a category sitemap, and was documented as
// "about 600 category pages" until a live crawl counted 50,000 URLs in it, 46,757
// of them products. Only sitemap_002 is purely products.
//
// Every subsequent run is incremental -- the sitemap carries <lastmod> on every
// entry -- which is why --since matters more for this shop than for the others.
//
// WHAT IS MISSING, PERMANENTLY. Carrefour publishes no GTIN. Not a wrong one, not
// an empty one -- the field is absent from every Product block on the site. So a
// Carrefour listing can only ever be matched to another shop's by the merge key,
// and when the two shops word a product differently the catalog keeps them as two
// products. That is the documented, accepted trade: two rows for one product is
// cosmetic, one row for two products is corrupt.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl } from '../../core/normalize.ts'

const ORIGIN = 'https://carrefour.ro'
const SITEMAP = `${ORIGIN}/pub/sitemap/sitemap.xml`

/**
 * The numeric id at the end of a Carrefour product URL.
 *
 *   /produse/lapte-uht-pentru-cafea-zuzu-barista-3-5-1l-19-15513004
 *                                                          ^^^^^^^^
 *
 * The SKU in the JSON-LD is the same number and is preferred when present; the
 * URL is the fallback, because a listing with no stable id churns -- every run
 * would insert a new one and sweep the old.
 */
export function externalIdFrom(url: string, sku: string | null): string | null {
  if (sku && /^[0-9]{4,}$/.test(sku)) return sku
  const match = /-(\d{5,})\/?$/.exec(url.replace(/\?.*$/, ''))
  return match ? match[1] : null
}

/**
 * Carrefour's URL path names the department, and that is the only category
 * signal on a product page -- the JSON-LD carries none.
 *
 * Only the URLs that came from a department sitemap have one, so this returns
 * null more often than not, which is the honest answer. A guessed shelf is worse
 * than none: the admin dashboard can find the nulls.
 */
export function categoryFromUrl(url: string): Category | null {
  const path = url.replace(ORIGIN, '').toLowerCase()
  if (/bacanie|alimente/.test(path)) return 'pantry'
  if (/lactate|branzeturi/.test(path)) return 'dairy'
  if (/fructe|legume/.test(path)) return 'produce'
  if (/carne|mezeluri/.test(path)) return 'meat'
  if (/peste/.test(path)) return 'fish'
  if (/panificatie|brutarie/.test(path)) return 'bakery'
  if (/congelate/.test(path)) return 'frozen'
  if (/dulciuri|snacks/.test(path)) return 'snacks'
  if (/bauturi/.test(path)) return 'drinks'
  if (/vinuri|bere|spirtoase/.test(path)) return 'alcohol'
  if (/bebelusi|copii/.test(path)) return 'baby'
  if (/curatenie|detergent|menaj/.test(path)) return 'household'
  if (/cosmetice|ingrijire/.test(path)) return 'personal-care'
  if (/animale/.test(path)) return 'pet'
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
    retailer: 'carrefour',
    externalId,
    name,
    brand: product.brand && product.brand.length <= 80 ? product.brand : null,
    // Kept even though Carrefour has never once populated it: the day they start
    // is the day their listings begin merging with Auchan's, and nobody should
    // have to remember to turn that on.
    gtin: validGtin(product.gtin),
    price,
    currency: price === null ? null : (product.currency ?? 'RON'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: categoryFromUrl(url),
    imageUrl: httpsUrl(product.image),
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class CarrefourScraper implements RetailerScraper {
  readonly retailer = 'carrefour'
  readonly country: Market = 'RO'
  readonly domain = 'carrefour.ro'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    // A full page fetch is ~300 KB and there are tens of thousands of them. One
    // per second is the pace a shop should not notice; going faster to finish a
    // ten-hour job in five is exactly the trade this repository does not make.
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/produse/example-1-12345678`)) {
      throw new Error('carrefour robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: true,
      urlFilter: (url) => url.includes('/produse/'),
      build: (product, url) => buildProduct(product, url),
    })
  }
}

export const carrefour = new CarrefourScraper()
