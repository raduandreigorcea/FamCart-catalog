// Auchan runs on VTEX, and VTEX has a public catalog API that the shop's own
// front end uses. Reading that is both cheaper and kinder than rendering pages:
// one request returns fifty complete products, with the EAN, the price, the
// stock level and the category path already structured.
//
// The response shape below was read off the live endpoint, not from VTEX's
// documentation, because the two differ in the ways that matter (`items[].ean`
// is present and populated; `productReference` is sometimes an EAN and sometimes
// an internal code for loose produce, which is why it goes through a check-digit
// test before it is believed).

import type { RetailerProduct, Unit, Category } from '../../core/types.ts'
import { parseQuantity, validGtin, httpsUrl } from '../../core/normalize.ts'

export interface VtexCommercialOffer {
  Price?: number
  ListPrice?: number
  AvailableQuantity?: number
  IsAvailable?: boolean
}

export interface VtexSeller {
  sellerId?: string
  sellerDefault?: boolean
  commertialOffer?: VtexCommercialOffer
}

export interface VtexItem {
  itemId?: string
  name?: string
  nameComplete?: string
  ean?: string
  referenceId?: Array<{ Key?: string; Value?: string }>
  measurementUnit?: string
  unitMultiplier?: number
  images?: Array<{ imageUrl?: string }>
  sellers?: VtexSeller[]
}

export interface VtexProduct {
  productId?: string
  productName?: string
  brand?: string
  linkText?: string
  link?: string
  productReference?: string
  categories?: string[]
  categoriesIds?: string[]
  description?: string
  items?: VtexItem[]
}

/** VTEX answers a page request with `resources: from-to/total`. */
export function parseResourcesHeader(value: string | null): { from: number; to: number; total: number } | null {
  if (!value) return null
  const match = /^\s*(\d+)-(\d+)\/(\d+)\s*$/.exec(value)
  if (!match) return null
  return { from: Number(match[1]), to: Number(match[2]), total: Number(match[3]) }
}

/**
 * Auchan's own category names, mapped onto the catalog's seventeen shelves.
 *
 * The FIRST segment of the path is used, not the last: "/Bauturi si Tutun/Apa/"
 * is drinks whatever the leaf is called, and leaf names are numerous, seasonal
 * and occasionally marketing copy. Anything unrecognised is left null rather
 * than forced into 'other' -- a null category is honest and the admin dashboard
 * can find them; a wrong one is invisible.
 */
const CATEGORY_BY_ROOT: Array<[RegExp, Category]> = [
  [/^fructe si legume/i, 'produce'],
  [/^lactate/i, 'dairy'],
  [/^brutarie|patiserie|cofetarie/i, 'bakery'],
  [/^carne|mezeluri|peste/i, 'meat'],
  [/^bauturi si tutun/i, 'drinks'],
  [/^bacanie|alimente/i, 'pantry'],
  [/^congelate/i, 'frozen'],
  [/^dulciuri|snack/i, 'snacks'],
  [/^bebe/i, 'baby'],
  [/^casa si curatenie|curatenie/i, 'household'],
  [/^ingrijire personala|cosmetice/i, 'personal-care'],
  [/^farmacie|sanatate/i, 'health'],
  [/^animale|petshop/i, 'pet'],
  [/^casa|electrocasnice|bricolaj|gradina|textile/i, 'home'],
]

export function categoryOf(categories: string[] | undefined): Category | null {
  const first = categories?.[categories.length - 1] ?? categories?.[0]
  if (!first) return null
  const root = first.split('/').filter(Boolean)[0] ?? ''
  for (const [pattern, category] of CATEGORY_BY_ROOT) {
    if (pattern.test(root)) return category
  }
  return null
}

/**
 * VTEX's measurementUnit, where it says anything useful.
 *
 * "un" means "a unit of the thing" and tells us nothing about size, so it is
 * ignored and the name is parsed instead. "kg" on loose produce is real: a
 * banana listing priced per kilogram genuinely is a kilogram.
 */
function unitFromItem(item: VtexItem | undefined): { quantity: number; unit: Unit } | null {
  const raw = (item?.measurementUnit ?? '').toLowerCase()
  const multiplier = item?.unitMultiplier
  if (!multiplier || !Number.isFinite(multiplier) || multiplier <= 0) return null
  if (raw === 'kg') return { quantity: multiplier, unit: 'kg' }
  if (raw === 'g') return { quantity: multiplier, unit: 'g' }
  if (raw === 'l') return { quantity: multiplier, unit: 'l' }
  if (raw === 'ml') return { quantity: multiplier, unit: 'ml' }
  return null
}

/**
 * One VTEX product to one RetailerProduct, or null when the row is unusable.
 *
 * The default seller's offer is the one that counts. Auchan lists marketplace
 * sellers alongside its own for some ranges, and a third party's price is not
 * Auchan's price.
 */
export function toRetailerProduct(product: VtexProduct, retailer = 'auchan'): RetailerProduct | null {
  const externalId = String(product.productId ?? '').trim()
  const name = String(product.productName ?? '').trim()
  if (!externalId || !name) return null

  const item = product.items?.[0]
  const seller =
    item?.sellers?.find((s) => s.sellerDefault) ?? item?.sellers?.find((s) => s.sellerId === '1') ?? item?.sellers?.[0]
  const offer = seller?.commertialOffer

  // The EAN first, then productReference -- and both through the check digit,
  // because Auchan files loose produce under 13-digit internal codes that look
  // exactly like barcodes and are not.
  const gtin = validGtin(item?.ean) ?? validGtin(product.productReference)

  const measured = unitFromItem(item)
  const parsed = measured ?? parseQuantity(name)

  const url = product.link
    ? httpsUrl(product.link)
    : product.linkText
      ? `https://www.auchan.ro/${product.linkText}/p`
      : null
  if (!url) return null

  const price = typeof offer?.Price === 'number' && offer.Price > 0 ? offer.Price : null

  return {
    retailer,
    externalId,
    name,
    brand: normalizeBrand(product.brand),
    gtin,
    price,
    currency: price === null ? null : 'RON',
    quantity: parsed?.quantity ?? null,
    unit: parsed?.unit ?? null,
    category: categoryOf(product.categories),
    imageUrl: httpsUrl(item?.images?.[0]?.imageUrl),
    productUrl: url,
    // AvailableQuantity is 99999 for anything in stock and 0 for anything not,
    // so it is a boolean wearing a number's clothes.
    available: offer?.IsAvailable === true || (offer?.AvailableQuantity ?? 0) > 0,
  }
}

/**
 * "Non-brand" is VTEX's placeholder for produce and loose goods, not a brand.
 * Storing it would put a made-up maker under every apple in the dropdown.
 */
function normalizeBrand(brand: string | undefined): string | null {
  const value = String(brand ?? '').trim()
  if (!value) return null
  if (/^(non[- ]?brand|generic|fara marca|n\/a)$/i.test(value)) return null
  return value.length <= 80 ? value : null
}

/** The ancestor chain a product carries, longest first: /1000000/1020000/1021000/ */
export function categoryPathsOf(product: VtexProduct): string[] {
  return (product.categoriesIds ?? []).filter((p) => /^\/[\d/]+\/$/.test(p))
}
