// Aldi: Aldi Süd's platform, read through its product sitemap and the schema.org
// blocks on each page. ONE SCRAPER, SIX COUNTRIES.
//
// Aldi Süd in Germany, Hofer in Austria, Aldi Suisse, Aldi Italia, Aldi UK and
// Aldi Ireland share one site: /sitemap_products.xml, a product URL ending in a
// long numeric id, a Product block with a price and a stock state, and a
// BreadcrumbList. Checked on all six live sites on 2026-09-14. (Aldi Nord --
// Germany's north, Spain, France, Belgium -- is a different company with a
// different site that publishes no product pages, and is not here.)
//
// NO BARCODE, ANYWHERE. So an Aldi listing merges with another shop's only when
// the names and sizes fold identically, the same accepted cost as Carrefour and
// Mega Image.
//
// ONLY THE GROCERIES, decided by the breadcrumb. Its third item links the
// product's top-level category -- /produkte/milchprodukte-eier/k/1588161425467093
// -- and that slug is the shop's own key for the shelf, stable where the label
// beside it is marketing copy in five languages. Each country lists which of its
// shelves are groceries; anything else, or a product with no category at all, is
// refused. That is an ALLOWLIST on purpose: Aldi's weekly "special buys" of
// clothes, tools and garden furniture are exactly what a missing entry must not
// let in.
//
// The cost of the allowlist lands on Hofer: about half its products carry no
// category (pasta and balsamic vinegar among them, next to a street sweeper), so
// Hofer imports a smaller share of its food than the others. A missing product is
// the smaller mistake.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market, Category } from '../../core/types.ts'
import { HttpClient } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { crawlProductPages } from '../../core/pageCrawl.ts'
import { isAvailable } from '../../core/jsonld.ts'
import { breadcrumbLinks } from '../../core/breadcrumb.ts'
import type { JsonLdProduct } from '../../core/jsonld.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

export interface AldiCountry {
  /** The catalog_retailers slug. Austria's Aldi trades as Hofer, and is `hofer`. */
  readonly slug: string
  readonly country: Market
  readonly origin: string
  /**
   * Where a product URL starts, and which sitemap lists them. Switzerland
   * publishes every product in German, French and Italian under the same id;
   * reading one language keeps a listing from being renamed three times a night.
   */
  readonly productPrefix: string
  readonly sitemap: string
  readonly currency: string
  /** Top-level category slug to the catalog's shelf. Only these are imported. */
  readonly shelves: Readonly<Record<string, Category | null>>
}

// A null shelf is a grocery aisle that is not one of ours: "organic", "vegan",
// "Italian specialities". Imported, with no category, rather than guessed.
const GERMANY: Record<string, Category | null> = {
  'milchprodukte-eier': 'dairy',
  kaese: 'dairy',
  'fleisch-fisch': 'meat',
  'wurst-aufschnitt': 'meat',
  'backwaren-aufstriche-cerealien': 'bakery',
  tiefkuehlung: 'frozen',
  'suessigkeiten-salzige-snacks': 'snacks',
  getraenke: 'drinks',
  'alkoholische-getraenke': 'alcohol',
  'saucen-oele-gewuerze': 'pantry',
  'konserven-fertiggerichte': 'pantry',
  'backzutaten-mehl-zucker': 'pantry',
  'nudeln-reis-huelsenfruechte': 'pantry',
  'drogerie-kosmetik': 'personal-care',
  haushaltsartikel: 'household',
  babyartikel: 'baby',
  tierbedarf: 'pet',
  'vegetarisch-vegan': null,
  proteinprodukte: null,
  'bio-produkte': null,
  'fairtrade-produkte': null,
  'italienischer-genuss': null,
  'griechischer-genuss': null,
  'bayrischer-genuss': null,
  'asiatische-vielfalt': null,
}

const AUSTRIA: Record<string, Category | null> = {
  milchprodukte: 'dairy',
  'fleisch-und-wurstwaren': 'meat',
  'fisch-und-meeresfruechte': 'fish',
  'brot-und-backwaren': 'bakery',
}

const SWITZERLAND: Record<string, Category | null> = {
  'milchprodukte-eier': 'dairy',
  'gekuehlte-produkte': null,
  fleisch: 'meat',
  fisch: 'fish',
  'brot-backwaren': 'bakery',
  'tiefgekuehlte-produkte': 'frozen',
  'suessigkeiten-snacks': 'snacks',
  'alkoholfreie-getraenke': 'drinks',
  'alkohol-tabakwaren': 'alcohol',
  vorraete: 'pantry',
  fruehstueck: 'pantry',
  'gesundheit-koerperpflege-baby': 'personal-care',
  'haushalt-wohnen': 'household',
  'vegetarisch-vegan': null,
  gourmet: null,
  'saveurs-suisses': null,
  'retour-aux-sources-bio-': null,
  tiefpreisversprechen: null,
}

const ITALY: Record<string, Category | null> = {
  dispensa: 'pantry',
  'prodotti-refrigerati': null,
  'carne-fresca-pesce-e-salumi': 'meat',
  'farina-e-prodotti-da-forno': 'bakery',
  freezer: 'frozen',
  'bevande-analcoliche': 'drinks',
  'bevande-alcoliche': 'alcohol',
  'igiene-e-pulizia-della-casa': 'household',
  'mondo-baby': 'baby',
  'animali-e-pet-care': 'pet',
  'vegetariani-e-vegani': null,
  proteico: null,
}

// The UK and Ireland share a category tree, apart from a few seasonal edges.
const BRITISH_ISLES: Record<string, Category | null> = {
  'fresh-food': null,
  'chilled-food': null,
  'food-cupboard': 'pantry',
  bakery: 'bakery',
  'frozen-food': 'frozen',
  drinks: 'drinks',
  alcohol: 'alcohol',
  'health-beauty': 'personal-care',
  'home-essentials': 'household',
  'baby-toddler': 'baby',
  'pet-care': 'pet',
  'picky-bits': 'snacks',
  'vegetarian-plant-based': null,
  'higher-protein-food-drink': null,
  'specially-selected': null,
  'back-to-school-meals': null,
  food: null,
}

export const ALDI_COUNTRIES: readonly AldiCountry[] = [
  { slug: 'aldi-de', country: 'DE', origin: 'https://www.aldi-sued.de', productPrefix: '/produkt/', sitemap: '/sitemap_products.xml', currency: 'EUR', shelves: GERMANY },
  { slug: 'hofer', country: 'AT', origin: 'https://www.hofer.at', productPrefix: '/produkt/', sitemap: '/sitemap_products.xml', currency: 'EUR', shelves: AUSTRIA },
  { slug: 'aldi-ch', country: 'CH', origin: 'https://www.aldi-suisse.ch', productPrefix: '/de/produkt/', sitemap: '/de/sitemap_products.xml', currency: 'CHF', shelves: SWITZERLAND },
  { slug: 'aldi-it', country: 'IT', origin: 'https://www.aldi.it', productPrefix: '/prodotto/', sitemap: '/sitemap_products.xml', currency: 'EUR', shelves: ITALY },
  { slug: 'aldi-gb', country: 'GB', origin: 'https://www.aldi.co.uk', productPrefix: '/product/', sitemap: '/sitemap_products.xml', currency: 'GBP', shelves: BRITISH_ISLES },
  { slug: 'aldi-ie', country: 'IE', origin: 'https://www.aldi.ie', productPrefix: '/product/', sitemap: '/sitemap_products.xml', currency: 'EUR', shelves: BRITISH_ISLES },
]

/** The numeric id every Aldi product URL ends in, or null for any other page. */
export function aldiIdFrom(url: string): string | null {
  return /-(\d{12,})\/?$/.exec(url)?.[1] ?? null
}

// A category link, in any of the platform's languages: /produkte/<shelf>/...k/<id>.
const CATEGORY_LINK = /\/(?:produkte|prodotti|products|produits)\/([a-z0-9-]+)\/(?:[^?#]*\/)?k\/\d+/

/** The product's top-level category slug, read from its breadcrumb, or null. */
export function aldiShelf(html: string): string | null {
  for (const link of breadcrumbLinks(html)) {
    const match = CATEGORY_LINK.exec(link)
    if (match) return match[1]
  }
  return null
}

export function isAldiGrocery(country: AldiCountry, shelf: string | null): boolean {
  return shelf !== null && Object.prototype.hasOwnProperty.call(country.shelves, shelf)
}

export function buildAldiProduct(
  product: JsonLdProduct,
  url: string,
  country: AldiCountry,
  shelf: string | null,
): RetailerProduct | null {
  const name = product.name?.trim()
  if (!name) return null
  const externalId = aldiIdFrom(url)
  if (!externalId) return null

  const parsed = parseQuantity(name)
  const price = product.price !== null && product.price > 0 ? product.price : null

  return {
    retailer: country.slug,
    externalId,
    name,
    brand: usableBrand(product.brand),
    // Stated rather than left to default: no Aldi page publishes one.
    gtin: null,
    price,
    currency: price === null ? null : (product.currency ?? country.currency),
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: shelf !== null ? (country.shelves[shelf] ?? null) : null,
    productUrl: httpsUrl(url) ?? url,
    available: isAvailable(product.availability),
  }
}

export class AldiScraper implements RetailerScraper {
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  readonly implemented = true
  private readonly config: AldiCountry

  // Written out rather than as parameter properties: erasableSyntaxOnly, see the
  // note on UnimplementedScraper in core/registry.ts.
  constructor(config: AldiCountry) {
    this.config = config
    this.retailer = config.slug
    this.country = config.country
    this.domain = config.origin.replace(/^https:\/\/www\./, '')
  }

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const config = this.config
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      timeoutMs: 45_000,
      retries: 2,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), config.origin)
    if (!isAllowed(robots, `${config.origin}${config.productPrefix}example-000000000000000000`)) {
      throw new Error(`${config.slug} robots.txt disallows product pages; refusing to crawl`)
    }

    const prefix = config.productPrefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    const isProduct = new RegExp(`${prefix}[^/]+-\\d{12,}/?$`)

    yield* crawlProductPages({
      retailer: this.retailer,
      http,
      ctx,
      sitemapUrls: [`${config.origin}${config.sitemap}`],
      // Every entry is dated, so a run with --since fetches what moved.
      supportsIncremental: true,
      // The same sitemap lists category pages; they carry no Product.
      urlFilter: (url) => isProduct.test(new URL(url).pathname),
      keep: (html) => isAldiGrocery(config, aldiShelf(html)),
      idOf: (url) => aldiIdFrom(url),
      build: (product, url, html) => buildAldiProduct(product, url, config, aldiShelf(html)),
    })
  }
}

export const ALDI_SCRAPERS: readonly AldiScraper[] = ALDI_COUNTRIES.map((c) => new AldiScraper(c))
