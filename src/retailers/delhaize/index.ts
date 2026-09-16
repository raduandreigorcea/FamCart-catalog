// Delhaize Belgium: read through its Dutch product sitemap and the schema.org
// Product block on each page. Checked with this crawler's own user agent on
// 2026-09-14.
//
// 14,583 products, every sitemap entry dated, so a nightly run fetches what moved.
// The price sits one level down, in the offer's priceSpecification -- the reader
// already handles that shape for Mega Image, which runs on the same platform. A
// second ld+json block on every page, for the MyDelhaize app, carries a price of
// 0.00; it is not a Product and is never read as one.
//
// ONE LANGUAGE. Every product is published in Dutch and in French under the same
// id. The Dutch sitemap (/sitemapnl/) lists only the Dutch pages, so reading it
// alone keeps a listing from being renamed twice a night.
//
// NO BARCODE. Like Mega Image, a Delhaize listing merges with another shop's only
// when the names and sizes fold identically.
//
// ONLY THE GROCERIES, by the department in the URL, and like Mega Image it is a
// DENYLIST: Delhaize is a supermarket, and of its twenty-odd departments only the
// kitchen-home-and-leisure aisle and the festive party accessories are not
// groceries -- decorations, plants, electrics, seasonal goods. Kitchen utensils,
// paper goods and fire lighters in that same aisle stay.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

const ORIGIN = 'https://www.delhaize.be'
const SITEMAP = `${ORIGIN}/sitemapnl/delhaizesitemapindex.xml`
const PRODUCT_URL = /^\/nl\/shop\/(.+)\/p\/([A-Z0-9]+)\/?$/

// Read from the Dutch sitemap on 2026-09-14.
const NOT_GROCERIES: RegExp[] = [
  /^Keuken-wonen-en-vrije-tijd\/(Huisdecoratie|Insecten-en-planten|Elektriciteit|Seizoensgebonden|Divers)\//i,
  /^Eindejaarsproducten\/Feest-accessoires\//i,
]

const DEPARTMENTS: Record<string, Category | null> = {
  'Verse-groenten-en-fruit': 'produce',
  'Vlees-vis-en-vegetarische-producten': null,
  'Zuivel-kaas-en-plantaardige-alternatieven': 'dairy',
  'Bakkerij-en-banket': 'bakery',
  'Zoete-kruidenierswaren': null,
  'Zoute-kruidenierswaren': 'pantry',
  Conserven: 'pantry',
  Diepvries: 'frozen',
  'Apero-en-voorgerechten': 'snacks',
  'Koude-en-warme-dranken': 'drinks',
  'Wijn-and-bubbels': 'alcohol',
  'Bieren-Alcohol-and-Alcoholvrij': 'alcohol',
  'Onderhoud-en-huishouden': 'household',
  'Keuken-wonen-en-vrije-tijd': 'household',
  'Hygiene-en-verzorging': 'personal-care',
  'Sport-and-Gezondheid': 'health',
  Baby: 'baby',
  Huisdieren: 'pet',
}

function pathOf(url: string): string {
  return new URL(url).pathname
}

export function delhaizeIdFrom(url: string): string | null {
  return PRODUCT_URL.exec(pathOf(url))?.[2] ?? null
}

export function delhaizeIsGrocery(url: string): boolean {
  const match = PRODUCT_URL.exec(pathOf(url))
  if (!match) return false
  return !NOT_GROCERIES.some((pattern) => pattern.test(`${match[1]}/`))
}

export function buildDelhaizeProduct(product: JsonLdProduct, url: string): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const match = PRODUCT_URL.exec(pathOf(url))
  if (!match) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null
  const department = match[1].split('/')[0]

  return {
    retailer: 'delhaize',
    externalId: match[2],
    name,
    brand: usableBrand(product.brand),
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? 'EUR'),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: DEPARTMENTS[department] ?? null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class DelhaizeScraper implements RetailerScraper {
  readonly retailer = 'delhaize'
  readonly country: Market = 'BE'
  readonly domain = 'delhaize.be'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/nl/shop/Verse-groenten-en-fruit/Voorbeeld/p/F1`)) {
      throw new Error('delhaize robots.txt disallows product pages; refusing to crawl')
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [SITEMAP],
      supportsIncremental: true,
      urlFilter: (url) => PRODUCT_URL.test(pathOf(url)),
      // The URL names the department, so a non-grocery page is never fetched.
      skip: (url) => !delhaizeIsGrocery(url),
      idOf: (url) => delhaizeIdFrom(url),
      build: (product, url) => buildDelhaizeProduct(product, url),
    })
  }
}

export const delhaize = new DelhaizeScraper()
