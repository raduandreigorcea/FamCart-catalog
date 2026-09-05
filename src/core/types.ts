// The shape every retailer produces, whatever their site is made of.
//
// A scraper's whole job is to turn one shop's idea of a product into one of
// these. Everything downstream -- validation, matching, the importer, the run
// accounting -- reads only this, which is what makes adding a retailer a matter
// of adding a directory rather than editing the pipeline.

/** The eleven markets src/lib/region.ts can derive from a phone's timezone. */
export const MARKETS = ['RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE'] as const
export type Market = (typeof MARKETS)[number]

export function isMarket(value: unknown): value is Market {
  return typeof value === 'string' && (MARKETS as readonly string[]).includes(value)
}

/**
 * The units the catalog stores, matching the check constraint in 002_catalog.sql.
 * Everything else a shop writes is converted into one of these or dropped.
 */
export const UNITS = ['g', 'kg', 'ml', 'l', 'buc'] as const
export type Unit = (typeof UNITS)[number]

export function isUnit(value: unknown): value is Unit {
  return typeof value === 'string' && (UNITS as readonly string[]).includes(value)
}

/** The seventeen shelves, matching catalog_products_category_check. */
export const CATEGORIES = [
  'produce', 'dairy', 'bakery', 'meat', 'fish', 'pantry', 'frozen', 'snacks',
  'drinks', 'alcohol', 'baby', 'household', 'personal-care', 'health', 'pet',
  'home', 'other',
] as const
export type Category = (typeof CATEGORIES)[number]

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

/**
 * One product as one retailer currently lists it.
 *
 * `externalId` is THE RETAILER'S OWN ID and it identifies a listing, never a
 * product across shops. Auchan's 199749 and Carrefour's 15513004 mean nothing to
 * each other, which is why matching goes through GTIN and the merge key instead.
 * It has to be stable across runs, though -- if a shop reissues ids, every run
 * inserts a fresh listing and the old one is swept, so the catalog churns.
 *
 * `price` is in major units (lei, not bani) and may be absent: Lidl publishes a
 * price only while a product is in stock, and a product with no price is still
 * worth having in a shopping list.
 */
export interface RetailerProduct {
  retailer: string
  externalId: string
  name: string
  brand?: string | null
  gtin?: string | null
  price?: number | null
  currency?: string | null
  quantity?: number | null
  unit?: Unit | null
  category?: Category | null
  imageUrl?: string | null
  productUrl: string
  available: boolean
}

/** What the CLI hands a scraper. */
export interface ScrapeContext {
  /** Stop after this many products. --limit, for a cheap smoke run. */
  limit?: number
  /**
   * Only fetch what changed since this moment, where the retailer's discovery
   * mechanism can tell. Carrefour's sitemap carries a lastmod; Auchan's API does
   * not, so its scraper ignores this and says so.
   */
  since?: Date
  /** Somewhere to say what is happening. */
  log: Logger
  /**
   * Say that the crawl ended before it had seen everything.
   *
   * THIS IS NOT LOGGING. A generator that stops early looks exactly like one
   * that finished, because both simply stop yielding -- so without this the CLI
   * closes the run as `completed` and the run becomes eligible to sweep on the
   * strength of a fraction of a shop.
   *
   * It is the gap that let the first full Auchan run report `completed` after
   * the circuit opened at 9,523 products of roughly 60,000. Nothing was swept
   * only because a first run has no previous run to be measured against; the
   * second would have been measured against that 9,523 and looked healthy.
   */
  reportIncomplete?: (reason: string) => void
  /** Injected so tests can drive a scraper entirely from test/fixtures/. */
  fetchImpl?: typeof fetch
  /**
   * Override the per-host request gap, in milliseconds. TEST SEAM ONLY -- the
   * CLI never sets it, so the polite default in each scraper is what a real run
   * uses. It exists because a fixture-driven test would otherwise spend a real
   * second per page proving something about parsing.
   */
  minIntervalMs?: number
  signal?: AbortSignal
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * A retailer, and the one thing it has to be able to do.
 *
 * `discoverProducts` is an async generator rather than a function returning an
 * array so the importer can batch and checkpoint as products arrive. Auchan has
 * 60,013 of them and a Carrefour crawl takes hours; neither should be held in
 * memory, and a run that dies at hour six should have imported the first five.
 */
export interface RetailerScraper {
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  /**
   * False for a retailer that has been analysed and cannot be read. The CLI
   * names it and moves on rather than skipping it silently -- a scraper that is
   * absent for a reason should be visible next to the ones that work.
   */
  readonly implemented: boolean
  /** Why, in one line, when implemented is false. See docs/retailers.md. */
  readonly note?: string
  discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct>
}

/** What a run reports, per the observability section of the README. */
export interface ScrapeStats {
  retailer: string
  found: number
  valid: number
  rejected: number
  errors: number
}

export function emptyStats(retailer: string): ScrapeStats {
  return { retailer, found: 0, valid: 0, rejected: 0, errors: 0 }
}
