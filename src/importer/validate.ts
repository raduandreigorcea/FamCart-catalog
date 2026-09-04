// The gate between a scraper and the database.
//
// Everything here is a bound the SQL also enforces, checked early so a bad row
// is a counted rejection with a reason rather than an exception inside a
// 500-row batch. The database remains the authority -- this is not a substitute
// for the constraints in 002_catalog.sql, it is a way of getting a useful count
// out of a run.
//
// The rejection reasons are the interesting output. "4,000 products rejected as
// no-name" is a broken selector; "4,000 rejected as bad-gtin" is a shop that
// changed how it files barcodes. Both look like "the catalog stopped growing"
// without them.

import type { RetailerProduct } from '../core/types.ts'
import { isUnit, isCategory } from '../core/types.ts'
import { validGtin, httpsUrl } from '../core/normalize.ts'

export type RejectReason =
  | 'no-external-id'
  | 'no-name'
  | 'name-too-long'
  | 'no-url'
  | 'bad-price'

export interface ImportRow {
  external_id: string
  name: string
  brand: string | null
  gtin: string | null
  price: number | null
  currency: string | null
  quantity: number | null
  unit: string | null
  category: string | null
  image_url: string | null
  product_url: string
  available: boolean
}

export type Validated =
  | { ok: true; row: ImportRow }
  | { ok: false; reason: RejectReason }

export function validate(product: RetailerProduct): Validated {
  const externalId = String(product.externalId ?? '').trim()
  if (!externalId || externalId.length > 100) return { ok: false, reason: 'no-external-id' }

  const name = String(product.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, reason: 'no-name' }
  // 200 is the column's bound. A longer name is almost always a description that
  // has escaped into the wrong field, so truncating it would store nonsense
  // under a plausible-looking product.
  if (name.length > 200) return { ok: false, reason: 'name-too-long' }

  const productUrl = httpsUrl(product.productUrl, 1000)
  if (!productUrl) return { ok: false, reason: 'no-url' }

  let price: number | null = null
  if (product.price !== null && product.price !== undefined) {
    if (!Number.isFinite(product.price) || product.price < 0 || product.price > 1_000_000) {
      return { ok: false, reason: 'bad-price' }
    }
    // Two decimals, because that is what the column stores and because a price
    // that differs only in the third would otherwise look like a change on every
    // single run and fill previous_price with noise.
    price = Math.round(product.price * 100) / 100
  }

  const quantity =
    product.quantity !== null && product.quantity !== undefined &&
    Number.isFinite(product.quantity) && product.quantity > 0 && product.quantity <= 1_000_000 &&
    isUnit(product.unit)
      ? product.quantity
      : null

  const brand = product.brand?.trim()

  return {
    ok: true,
    row: {
      external_id: externalId,
      name,
      brand: brand && brand.length <= 80 ? brand : null,
      // Re-checked here even though the scrapers already did it: this is the
      // last place before a value becomes the highest-priority match in the
      // importer, and a wrong barcode merges two unrelated products confidently.
      gtin: validGtin(product.gtin),
      price,
      currency: price === null ? null : (product.currency ?? 'RON').toUpperCase().slice(0, 3),
      quantity,
      unit: quantity === null ? null : (product.unit as string),
      category: isCategory(product.category) ? product.category : null,
      image_url: httpsUrl(product.imageUrl, 1000),
      product_url: productUrl,
      available: product.available !== false,
    },
  }
}
