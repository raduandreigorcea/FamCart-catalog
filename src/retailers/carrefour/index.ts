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
import { collectSitemapEntries } from '../../core/pageCrawl.ts'
import { crawlDepartments } from './departments.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl, usableBrand } from '../../core/normalize.ts'

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
    brand: usableBrand(product.brand),
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

    // THE DEPARTMENTS, NOT THE PRODUCTS. The same sitemap holds both: 85,119
    // /produse/ pages and 3,243 department pages. Reading the departments gets
    // twenty-four products per request instead of one, which is the difference
    // between forty-five hours and about two -- so the whole shop fits in a
    // single nightly job, and a run that has seen the whole shop is the only
    // kind allowed to mark anything as no longer sold.
    //
    // buildProduct() and the product-page parser stay, and stay tested. They are
    // the fallback if the analytics payload ever goes, and they are what the
    // fixtures pin the JSON-LD reading against.
    const entries = await collectSitemapEntries(http, ctx, [SITEMAP])
    const departments = entries
      .map((entry) => entry.loc)
      .filter((loc) => loc.startsWith(ORIGIN) && !loc.includes('/produse/'))
      // Longest first, so the specific leaves are read before the parents that
      // contain them. Same products either way -- they are deduplicated -- but
      // this way a product's category comes from the narrowest department that
      // claims it rather than from whichever happened to be crawled first.
      .sort((a, b) => b.length - a.length)

    if (departments.length === 0) {
      // The sitemap answered and held no departments at all. Not an empty shop:
      // something changed. Saying so stops the run concluding anything.
      ctx.reportIncomplete?.('carrefour: the sitemap listed no department pages')
      return
    }

    ctx.log.info('carrefour: departments read', {
      departments: departments.length,
      productUrlsIgnored: entries.length - departments.length,
    })

    // THE CRAWL CHECKS ITS OWN COVERAGE, and this is the part that earns it the
    // right to sweep.
    //
    // Reading departments is an indirect route to the products: a product that
    // sits in no department, or in one the sitemap forgot, is simply never seen.
    // On the product-page path that could not happen -- the list of products WAS
    // the list of products. Here it can, and "did not see it" is what the sweep
    // reads as "no longer sold". The first completed run would have marked every
    // missed product gone, with the sanity floor no help at all, because a floor
    // compares against a previous completed run and there has never been one.
    //
    // So the sitemap's own product list is kept as the yardstick, and the run
    // reports incomplete unless the departments accounted for nearly all of it.
    // Checked every night rather than proved once by hand: coverage is not a
    // property of the code, it is a property of how the shop is arranged today.
    const sitemapIds = new Set<string>()
    for (const entry of entries) {
      const match = /-(\d{5,})\/?$/.exec(entry.loc.replace(/\?.*$/, ''))
      if (entry.loc.includes('/produse/') && match) sitemapIds.add(match[1])
    }

    const counters = { departments: 0, pages: 0, unreadable: 0, emitted: 0 }
    const seen = new Set<string>()
    try {
      for await (const product of crawlDepartments({ http, ctx, departments, counters })) {
        seen.add(product.externalId)
        yield product
      }
    } finally {
      ctx.log.info('carrefour: crawl finished', { ...counters })
    }

    if (sitemapIds.size > 0 && !ctx.limit) {
      let covered = 0
      for (const id of sitemapIds) if (seen.has(id)) covered++
      const ratio = covered / sitemapIds.size
      ctx.log.info('carrefour: coverage', {
        sitemapProducts: sitemapIds.size,
        seen: covered,
        percent: Math.round(ratio * 1000) / 10,
      })
      // Nineteen in twenty. Below that, the departments are not describing the
      // same shop the sitemap is, and whatever the reason -- a reorganised
      // aisle, a department that failed to load, a payload that moved -- the run
      // has no standing to declare the difference delisted.
      if (ratio < 0.95) {
        ctx.reportIncomplete?.(
          `carrefour: departments covered ${covered} of ${sitemapIds.size} sitemap products ` +
            `(${Math.round(ratio * 100)}%), below the 95% needed to conclude anything about the rest`,
        )
      }
    }
  }
}

export const carrefour = new CarrefourScraper()
