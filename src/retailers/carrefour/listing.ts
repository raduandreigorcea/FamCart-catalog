// Reading a Carrefour DEPARTMENT page instead of 24 product pages.
//
// WHY THIS EXISTS. The product-page crawl is correct and unaffordable: 85,119
// pages at the polite rate is about forty-five hours, against a six-hour job.
// It was being cut into slices that never finished and never earned the right
// to sweep, so nothing at Carrefour was ever marked as no longer sold.
//
// A department listing carries twenty-four products in one 370 KB page, in a
// Google Analytics payload the page publishes for its own tracking:
//
//   var impressionData = {"ecommerce":{"currencyCode":"RON","impressions":[
//     {"id":"10510721","name":"Vin Australian Chardonnay 0.75L",
//      "brand":"Australian Bush","price":24.49,"category":"Bacanie & Lichide",
//      "dimension10":"available", ...}, ... ]}}
//
// That is every field the product page gave us, PLUS the category, which a
// Carrefour product page has never carried -- categoryFromUrl() can only read a
// department out of a URL, and 85,119 of their URLs are a flat /produse/<slug>.
// So this is 24x cheaper and strictly better informed.
//
// WHAT IT COSTS IN STABILITY, stated plainly. The JSON-LD on a product page is
// there because Google requires it for rich results, which is about as close to
// a contract as scraping gets. An analytics blob has no such promise: it can be
// renamed or dropped in a deploy, with no warning and no reason for anybody at
// the shop to think twice.
//
// The mitigation is that the failure is LOUD rather than quiet. A page whose
// payload cannot be read yields nothing, the run's count collapses, and the
// sanity floor in catalog_run_complete() refuses to sweep on it -- so the worst
// case is a stale catalog and a red row on the dashboard, never a catalog that
// deletes itself. That is the same machinery that already caught Lidl halving.

import type { RetailerProduct, Category } from '../../core/types.ts'
import { parseQuantity, httpsUrl, usableBrand } from '../../core/normalize.ts'

/** One product as the department page's own analytics describes it. */
export interface Impression {
  id: string
  name: string
  brand?: string | null
  price?: number | null
  category?: string | null
  /** The shop's word for stock state; "available" is the only positive value seen. */
  dimension10?: string | null
}

/**
 * Pull the analytics payload out of a department page.
 *
 * Brace-matched rather than regex-matched. The payload is nested, so a lazy
 * `\{[\s\S]*?\}` stops at the first inner brace and yields something that
 * parses as JSON but holds a fraction of the products -- which would look like
 * a shop that had quietly shrunk, and is exactly the failure the sanity floor
 * would then have to catch. Better not to produce it.
 */
export function parseImpressions(html: string): Impression[] | null {
  const marker = html.indexOf('var impressionData')
  if (marker < 0) return null
  const start = html.indexOf('{', marker)
  if (start < 0) return null

  let depth = 0
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth !== 0) continue
      try {
        const parsed = JSON.parse(html.slice(start, i + 1)) as {
          ecommerce?: { impressions?: unknown }
        }
        const rows = parsed.ecommerce?.impressions
        return Array.isArray(rows) ? (rows as Impression[]) : null
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * The product images, keyed by the id in their filename.
 *
 *   .../cache/aac64a.../1/0/10510721_2_.webp
 *                           ^^^^^^^^
 *
 * Lazy-loaded, so they sit in data-src rather than src. Keyed by filename
 * rather than by document order on purpose: order ties an image to a position
 * in the markup, and a single extra tile -- a promotion, a sponsored slot --
 * would shift every product's picture by one without anything failing.
 */
export function imagesById(html: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of html.matchAll(/data-(?:src|original)="(https:\/\/[^"]+?\/(\d{4,})_[^"/]*\.(?:webp|jpg|jpeg|png))"/gi)) {
    const [, url, id] = match
    if (!found.has(id)) found.set(id, url)
  }
  return found
}

// The shop's own department names, folded onto the catalog's seventeen. Read
// from the payload rather than guessed from a URL, so "Bacanie & Lichide" is
// the shop telling us where the product sits rather than us inferring it.
const CATEGORIES: Array<[RegExp, Category]> = [
  [/lactate|branzet|oua/i, 'dairy'],
  [/fructe|legume/i, 'produce'],
  [/mezel|carne|pasare/i, 'meat'],
  [/peste|fructe de mare/i, 'fish'],
  [/panificat|brutar|patiser/i, 'bakery'],
  [/congelat/i, 'frozen'],
  [/dulciur|snack|gustar|biscuit|ciocolat/i, 'snacks'],
  [/vin|bere|spirtoase|alcool|whisky/i, 'alcohol'],
  [/bautur|lichide|apa|suc|cafea|ceai/i, 'drinks'],
  [/bebelus|copii|scutec/i, 'baby'],
  [/curaten|detergent|menaj|casa/i, 'household'],
  [/cosmetic|ingrijire|igien|frumusete/i, 'personal-care'],
  [/animale|petshop/i, 'pet'],
  [/bacanie|aliment|conserve|paste|orez/i, 'pantry'],
]

/**
 * THE LEADING SHELF WINS, and that is a rule rather than an ordering.
 *
 * Several of Carrefour's departments name two shelves -- "Bacanie & Lichide" is
 * groceries and drinks in one aisle -- and both halves match. Deciding by which
 * pattern happens to sit higher in the list above is deciding by luck: the first
 * version of this returned `drinks` for that department purely because the
 * drinks rule was written first.
 *
 * The shop puts the department's primary shelf first in its own name, so that is
 * what is matched first. Only if the leading part says nothing does the whole
 * label get a look, which is what keeps a single-shelf name working unchanged.
 */
export function categoryFromLabel(label: string | null | undefined): Category | null {
  if (!label) return null
  const lead = label.split(/[&,/|]/)[0]?.trim()
  if (lead) {
    for (const [pattern, category] of CATEGORIES) if (pattern.test(lead)) return category
  }
  for (const [pattern, category] of CATEGORIES) if (pattern.test(label)) return category
  return null
}

/** One impression, as the catalog wants it. Null when it is not a usable row. */
export function buildFromImpression(
  row: Impression,
  images: Map<string, string>,
): RetailerProduct | null {
  const name = String(row.name ?? '').trim()
  const externalId = String(row.id ?? '').trim()
  if (!name || !/^\d{4,}$/.test(externalId)) return null

  const parsed = parseQuantity(name)
  const price = typeof row.price === 'number' && row.price > 0 ? row.price : null

  return {
    retailer: 'carrefour',
    externalId,
    name,
    brand: usableBrand(row.brand ?? null),
    // Carrefour publishes no GTIN anywhere, and the analytics payload is no
    // exception. Kept null rather than omitted so the shape stays one thing.
    gtin: null,
    price,
    currency: price === null ? null : 'RON',
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: categoryFromLabel(row.category),
    imageUrl: httpsUrl(images.get(externalId) ?? null),
    // The canonical product URL is not in the payload, and guessing the slug
    // would produce a URL that 404s. The id is what the listing is keyed on
    // anyway, and this form is the one the site itself redirects from.
    productUrl: `https://carrefour.ro/produse/${externalId}`,
    // "available" is the only positive value the field has been seen to take.
    // Anything else, including absent, is treated as not on the shelf -- and
    // absence never deletes anything, it only stops a listing being offered.
    available: (row.dimension10 ?? '').toLowerCase() === 'available',
  }
}

/** Everything a department page holds, or null when the payload is unreadable. */
export function parseListingPage(html: string): RetailerProduct[] | null {
  const rows = parseImpressions(html)
  if (rows === null) return null
  const images = imagesById(html)
  return rows.map((row) => buildFromImpression(row, images)).filter((p): p is RetailerProduct => p !== null)
}
