// Lidl: Nuxt, read through its product sitemap and the schema.org Product block
// on each page. ONE SCRAPER, TEN COUNTRIES.
//
// Every Lidl country runs the same site. The sitemap sits at the same path under
// a country and language (/p/export/DE/de/product_sitemap.xml.gz), the product
// page carries the same Product block, and the id is the same p-number at the end
// of the URL. So the code is written once and LIDL_COUNTRIES says what differs.
// Checked on all ten live sites on 2026-09-14.
//
// ONLY THE GROCERIES. Lidl Romania has no general webshop, so its sitemap is
// mostly what is on the shelves -- mostly, which is how a laser level and a
// women's jacket got into the catalog. Germany, France, Belgium and Spain DO run
// a webshop, and there the sitemap is overwhelmingly beds, drills and jumpers.
// A shopping list wants none of it.
//
// The page says which shelf a product is on, and says it in a form that does not
// depend on the language: `wonCategoryPrimaryPath` is a numeric path that is the
// SAME TREE IN EVERY COUNTRY. 0/17 is food and near-food (detergent and nappies
// included), 0/10 is drinks, and everything else is the non-food shop. That is
// read instead of guessing from product names in eight languages, which is how
// "Butterbirne" -- a pear TREE, on the garden shelf -- passes for butter.
//
// TWO QUIRKS, BOTH REAL AND BOTH FOUND ON LIVE PAGES:
//
//   * availability is bare ("OutOfStock", "InStoreOnly", "OnlineOnly"), not the
//     full schema.org URL Carrefour uses. InStoreOnly is the common case and
//     counts as available -- it is a supermarket, the products are in the shop.
//   * `offers` is an ARRAY and only the in-stock entry carries a price, so a
//     product can legitimately arrive with no price at all. In the UK and
//     Switzerland most in-store food has none. A shopping list still wants it.
//
// It is the only retailer here that publishes a GTIN (on about a third of its
// Romanian products, and on the German webshop ones). Those are the rows that
// merge a Lidl listing with another shop's, across borders too.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, validGtin, httpsUrl, usableBrand } from '../../core/normalize.ts'

export interface LidlCountry {
  /**
   * The catalog_retailers slug. Romania keeps `lidl`, the slug it had before
   * there were others: renaming it for symmetry would orphan every listing.
   */
  readonly slug: string
  readonly country: Market
  /** lidl.<tld> -- 'ro', 'co.uk'. */
  readonly tld: string
  /**
   * The language of the ONE product sitemap read. Belgium publishes the same
   * products in Dutch and in French under the same ids; reading both would rename
   * every listing back and forth each night.
   */
  readonly lang: string
  /** For an offer that names no currency. Every page captured so far names one. */
  readonly currency: string
}

export const LIDL_COUNTRIES: readonly LidlCountry[] = [
  { slug: 'lidl', country: 'RO', tld: 'ro', lang: 'ro', currency: 'RON' },
  { slug: 'lidl-it', country: 'IT', tld: 'it', lang: 'it', currency: 'EUR' },
  { slug: 'lidl-de', country: 'DE', tld: 'de', lang: 'de', currency: 'EUR' },
  { slug: 'lidl-at', country: 'AT', tld: 'at', lang: 'de', currency: 'EUR' },
  { slug: 'lidl-ch', country: 'CH', tld: 'ch', lang: 'de', currency: 'CHF' },
  { slug: 'lidl-es', country: 'ES', tld: 'es', lang: 'es', currency: 'EUR' },
  { slug: 'lidl-fr', country: 'FR', tld: 'fr', lang: 'fr', currency: 'EUR' },
  { slug: 'lidl-be', country: 'BE', tld: 'be', lang: 'nl', currency: 'EUR' },
  { slug: 'lidl-gb', country: 'GB', tld: 'co.uk', lang: 'en', currency: 'GBP' },
  { slug: 'lidl-ie', country: 'IE', tld: 'ie', lang: 'en', currency: 'EUR' },
]

const ROMANIA = LIDL_COUNTRIES[0]

/**
 * The id at the end of a Lidl product URL: /p/{slug}/p{id}, or with a locale
 * segment in front of the slug where a country has several (/p/de-CH/...).
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

/** The shelf a page names: its numeric path, and the coarse label beside it. */
export interface LidlShelf {
  /** `0/17/1739/173911` split: the root is always '0', then the section. */
  path: string[]
  /** "Food", "NonFood", "F+V", "P+F" -- or a whole path on a webshop country. */
  primary: string | null
}

/**
 * Read the shelf out of the page's Nuxt state. The first occurrence is the
 * product's own: every page captured carries the field exactly once.
 */
export function lidlShelf(html: string): LidlShelf {
  const path = /"wonCategoryPrimaryPath"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? ''
  const primary = /"categoryPrimary"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? ''
  return { path: path.split('/').filter(Boolean), primary: primary || null }
}

// 17 is food and near-food, 10 is drinks. The rest of the tree is the non-food
// shop: 11 kitchen and household appliances, 12 DIY and garden, 13 sport, 14
// home and electronics, 15 fashion, 16 kids, 19 pet accessories.
const GROCERY_SECTIONS = new Set(['10', '17'])
// Plants and flowers, filed under food because they stand by the tills. Italy
// labels them P+F; Austria labels the same shelf NonFood, so the number decides.
const PLANTS = '1732'
// A few British pages name the label and leave the path empty.
const GROCERY_LABELS = new Set(['Food', 'F+V'])

/**
 * Whether a product belongs on a shopping list.
 *
 * A page that names no shelf at all is refused. If a redesign drops the field,
 * every page is refused, the run imports nothing, and catalog_run_complete will
 * not sweep on the strength of it: loud, rather than quietly importing the
 * furniture again.
 */
export function isGroceryShelf(shelf: LidlShelf): boolean {
  if (shelf.primary === 'P+F') return false
  const [, section, aisle] = shelf.path
  if (section) return GROCERY_SECTIONS.has(section) && aisle !== PLANTS
  return shelf.primary !== null && GROCERY_LABELS.has(shelf.primary)
}

/**
 * Lidl's URL slug as a category hint, for ROMANIA ONLY: it is a product name in
 * Romanian rather than a department, so it recognises very little and nothing at
 * all in another language. Null is the honest answer elsewhere; the admin
 * dashboard can list the products with no shelf.
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

export function buildProduct(
  product: JsonLdProduct,
  url: string,
  country: LidlCountry = ROMANIA,
): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = externalIdFrom(url, product.sku)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: country.slug,
    externalId,
    name,
    brand: usableBrand(product.brand),
    gtin: validGtin(product.gtin),
    price,
    currency: price === null ? null : (product.currency ?? country.currency),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: country.country === 'RO' ? categoryFromSlug(url) : null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class LidlScraper implements RetailerScraper {
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  readonly implemented = true
  private readonly config: LidlCountry

  // Written out rather than as parameter properties: erasableSyntaxOnly, see the
  // note on UnimplementedScraper in core/registry.ts.
  constructor(config: LidlCountry = ROMANIA) {
    this.config = config
    this.retailer = config.slug
    this.country = config.country
    this.domain = `lidl.${config.tld}`
  }

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const config = this.config
    const origin = `https://www.lidl.${config.tld}`
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), origin)
    // Lidl disallows /q/search and a handful of asset paths, not /p/. Checking a
    // representative product URL rather than the origin is the point: a rule that
    // appears later could disallow exactly the thing we came for.
    if (!isAllowed(robots, `${origin}/p/example/p11000000`)) {
      throw new Error(`${config.slug} robots.txt disallows product pages; refusing to crawl`)
    }

    if (ctx.since) {
      ctx.log.info(`${config.slug} publishes no lastmod; crawling every product page`)
    }

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [`${origin}/p/export/${config.country}/${config.lang}/product_sitemap.xml.gz`],
      // No lastmod in this sitemap, so an incremental run would silently fetch
      // everything anyway. Saying so is better than implying a saving.
      supportsIncremental: false,
      urlFilter: (url) => /\/p\/(?:[a-z]{2}-[A-Z]{2}\/)?[^/]+\/p\d+/.test(url),
      keep: (html) => isGroceryShelf(lidlShelf(html)),
      idOf: (url) => externalIdFrom(url, null),
      build: (product, url) => buildProduct(product, url, config),
    })
  }
}

export const LIDL_SCRAPERS: readonly LidlScraper[] = LIDL_COUNTRIES.map((c) => new LidlScraper(c))

/** Lidl Romania, the one that came first. */
export const lidl = LIDL_SCRAPERS[0]
