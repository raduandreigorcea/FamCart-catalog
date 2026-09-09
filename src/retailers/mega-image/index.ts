// Mega Image Romania: SAP Commerce, read through its sitemap and the schema.org
// Product block on each page.
//
// LISTED AS UNREADABLE FOR A MONTH, AND THE NOTE WAS OUT OF DATE. The registry
// said the pages carry no price and weigh ~730 KB, and neither is true now: the
// price is there, in a nested priceSpecification, and a page is ~235 KB. 8,879
// products at one request a second is about two and a half hours and two
// gigabytes, which is the same order as Carrefour and affordable nightly. The
// lesson is that "analysed and rejected" needs a date on it.
//
// THE BEST CATEGORY DATA OF THE FOUR, and it costs nothing. Every product URL
// carries the shop's own department path three levels deep --
// /Lactate-si-oua/Lapte/Lapte-UHT/<name>/p/<id> -- so the shelf is read rather
// than guessed. Lidl has to infer a category from words in a product name and
// gets it right for a fraction of its assortment.
//
// WHAT IT DOES NOT HAVE IS A BARCODE. Not a wrong one, not an empty one: no
// product page publishes a GTIN. That is the same accepted cost as Carrefour --
// a Mega Image listing merges with another shop's only when the folded name and
// size agree, and often they will not. Two rows for one product is cosmetic; one
// row for two products is corrupt.
//
// TWO THINGS THE SITE GETS WRONG, both worked around in core rather than here
// because neither is really about this shop:
//
//   * every <loc> in the sitemap is EMPTY, with the address in the xhtml:link
//     beside it (src/core/sitemap.ts)
//   * the price is in offers.priceSpecification rather than offers.price
//     (src/core/jsonld.ts)

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.mega-image.ro'
const SITEMAP = `${ORIGIN}/sitemap/delhaizesitemapindex.xml`

/** A product page: .../<name>/p/<id>. A department is .../c/<id>. */
const PRODUCT_URL = /\/p\/(\d+)$/

/**
 * The shop's own id, off the end of the URL.
 *
 * There is nothing else to use: these pages publish no sku and no gtin, so the
 * path segment is the only stable handle on a listing. It is the id SAP Commerce
 * uses internally, so it survives a rename of the product or its department --
 * which matters, because a changed id is a new listing plus a swept old one on
 * every run.
 */
export function externalIdFrom(url: string): string | null {
  const match = PRODUCT_URL.exec(new URL(url).pathname)
  return match ? match[1] : null
}

/**
 * The shelf, from the department path the URL already carries.
 *
 * Ordered, and the ORDER IS THE RULE: the two-segment entries come first because
 * two departments hold more than one of our shelves. Bauturi is soft drinks and
 * beer and spirits; the breakfast aisle is bread and coffee and cereal. Matching
 * the top level alone would file beer under drinks, which is wrong in the one
 * direction that matters -- `catalog_products_category_check` has an `alcohol`
 * shelf precisely so it can be treated differently.
 *
 * An unrecognised department answers null rather than 'other'. Null is a
 * question the admin dashboard can list; 'other' is a wrong answer that looks
 * like a right one.
 */
const SHELVES: Array<[RegExp, Category]> = [
  // The mixed departments, most specific first.
  [/^\/Bauturi\/(Bere|Vin|Spirtoase|Bauturi-alcoolice)/i, 'alcohol'],
  [/^\/Bauturi\//i, 'drinks'],
  [/^\/Paine-cafea-cereale-si-mic-dejun\/(Cafea|Ceai)/i, 'drinks'],
  [/^\/Paine-cafea-cereale-si-mic-dejun\/(Musli|Cereale)/i, 'pantry'],
  [/^\/Paine-cafea-cereale-si-mic-dejun\//i, 'bakery'],
  // The rest map whole.
  [/^\/Lactate-si-oua\//i, 'dairy'],
  [/^\/Mezeluri-carne-si-ready-meal\//i, 'meat'],
  [/^\/Peste-si-fructe-de-mare\//i, 'fish'],
  [/^\/Fructe-si-legume-proaspete\//i, 'produce'],
  [/^\/Produse-congelate\//i, 'frozen'],
  [/^\/Dulciuri-si-snacks\//i, 'snacks'],
  [/^\/Ingrediente-culinare\//i, 'pantry'],
  [/^\/Apa-si-sucuri\//i, 'drinks'],
  [/^\/Cosmetice-si-ingrijire-personala\//i, 'personal-care'],
  [/^\/Curatenie-si-nealimentare\//i, 'household'],
  [/^\/Mama-si-ingrijire-copil\//i, 'baby'],
  [/^\/Animale-de-companie\//i, 'pet'],
  [/^\/Equilibrium\//i, 'health'],
]

export function categoryFromPath(url: string): Category | null {
  const path = new URL(url).pathname
  for (const [pattern, category] of SHELVES) {
    if (pattern.test(path)) return category
  }
  return null
}

export function buildProduct(product: JsonLdProduct, url: string): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = externalIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: 'mega-image',
    externalId,
    name,
    brand: usableBrand(product.brand),
    // Stated rather than left to default. No page here publishes one, and
    // writing it out is what stops somebody "fixing" the omission later.
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? 'RON'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: categoryFromPath(url),
    imageUrl: httpsUrl(product.image),
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class MegaImageScraper implements RetailerScraper {
  readonly retailer = 'mega-image'
  readonly country: Market = 'RO'
  readonly domain = 'mega-image.ro'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    // Checked against a representative PRODUCT url rather than the origin. Mega
    // Image disallows /login, /checkout, /my-account and every */search*, none of
    // which this crawl wants -- but a rule added later could disallow exactly the
    // thing we came for, and the origin would still look fine.
    if (!isAllowed(robots, `${ORIGIN}/Lactate-si-oua/Lapte/Lapte-UHT/Exemplu/p/1`)) {
      throw new Error('mega-image robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      // Their sitemap dates every entry, and the dates are real -- the fixture
      // spans June to September rather than all being today. So a nightly run
      // fetches what moved instead of all 8,879 pages.
      supportsIncremental: true,
      // 1,828 of the 10,707 entries are department and landing pages carrying no
      // Product block. Fetching them to find that out costs half an hour and
      // buries the real "this page had no product" signal under noise.
      urlFilter: (url) => PRODUCT_URL.test(new URL(url).pathname),
      build: (product, url) => buildProduct(product, url),
    })
  }
}

export const megaImage = new MegaImageScraper()
