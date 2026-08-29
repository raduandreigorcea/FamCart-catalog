import { foldName } from './normalize.ts'
import type { SourceProduct } from './sources/types.ts'

// The gate every discovered product passes before it is allowed to exist.
//
// THE ASYMMETRY THIS FILE IS BUILT ON. Rejecting a good product costs one row
// nobody will miss. Accepting a bad one costs the catalog's credibility for as
// long as it sits there, because a shopping list that suggests "test test 123"
// or "PRODUIT TEST" teaches its user to stop reading the suggestions. So the
// rules below are strict about EVIDENCE OF GARBAGE and deliberately permissive
// about ABSENCE OF DATA.
//
// That distinction is §10, and it is the one most likely to be quietly inverted
// by someone tidying this up later:
//
//   REJECT for   a name that is not a name, a placeholder, a product the
//                source itself calls obsolete, a commercial product with
//                nothing that could identify it.
//   NEVER reject for   missing nutrition, missing image, missing brand,
//                missing quantity, missing category, missing country.
//
// "Incomplete does not automatically mean invalid." A banana has no barcode and
// no brand and is a perfectly good catalog row.

export type QualityTier = 'A' | 'B' | 'C'

export interface Verdict {
  ok: boolean
  /** Set when ok. */
  tier?: QualityTier
  /**
   * Set when not ok — a short machine-readable reason, so the metrics can count
   * WHY things are rejected rather than only how many. A rejection rate that
   * suddenly becomes all `no-usable-name` is an upstream shape change, not a
   * quality problem, and the two need different responses.
   */
  reason?: RejectReason
}

export type RejectReason =
  | 'no-usable-name'
  | 'name-too-long'
  | 'name-not-a-name'
  | 'placeholder'
  | 'obsolete'
  | 'unidentifiable'
  | 'bad-barcode'

/**
 * Names that are not names.
 *
 * Every one of these is a real pattern in open product data: test rows people
 * left behind, placeholder text from a scanning app, and the barcode typed into
 * the name field because the app demanded one. Anchored where anchoring is
 * right — `test` alone is a rejection, `Test Match Lager` is not.
 */
const PLACEHOLDER_EXACT = new Set([
  'test', 'testing', 'test test', 'test product', 'produit test', 'testprodukt',
  'prueba', 'producto de prueba', 'prodotto test', 'produs test',
  'unknown', 'unknown product', 'inconnu', 'desconocido', 'sconosciuto',
  'necunoscut', 'unbekannt', 'n/a', 'na', 'none', 'null', 'undefined',
  'sans nom', 'no name', 'sin nombre', 'senza nome', 'ohne namen',
  'produit', 'product', 'producto', 'prodotto', 'produs', 'produkt',
  'aaa', 'abc', 'asdf', 'qwerty', 'xxx', 'zzz', 'aaaa', 'xxxx',
])

// Prefixes, and DELIBERATELY NOT a bare 'test '. That was the first version and
// it rejected "Test Match Lager", which is a beer. A rule that throws away real
// products to catch fake ones has the asymmetry backwards: a placeholder that
// slips through is one bad row, a real product rejected is a permanent hole
// nobody will ever see reported.
const PLACEHOLDER_PREFIX = [
  'test product', 'testproduct', 'testprodukt', 'test item', 'test article',
  'test 1', 'test 2', 'test123', 'test-', 'test_',
  'dummy', 'sample product', 'lorem ipsum', 'do not use', 'ne pas utiliser',
]

/**
 * The shortest name worth storing.
 *
 * Two, not three: real products are named "Ou", "Té", "Öl". One character is
 * never enough to find anything and is almost always a data-entry accident.
 */
const MIN_NAME = 2

/**
 * Matches the `catalog_products_name_length` constraint, which in turn matches
 * the app database's `product_catalog.name`. Rejecting here rather than at the
 * insert means the reason is "name too long" instead of a constraint violation
 * buried in a batch summary.
 */
const MAX_NAME = 120

/** The shape a scanner can actually produce. Same rule as the check constraint. */
const GTIN = /^[0-9]{8,14}$/

/**
 * Is this string a name, or is it something that ended up in the name field?
 *
 * The three cases worth catching, all of which are common upstream:
 *   * a barcode, because some apps put the code in the name when the name is
 *     unknown — and it would then be searchable as text, which §25 forbids;
 *   * a string with no letters at all in any alphabet;
 *   * a single repeated character.
 */
function looksLikeAName(folded: string): boolean {
  if (GTIN.test(folded.replace(/\s/g, ''))) return false
  if (!/\p{Letter}/u.test(folded)) return false
  if (/^(.)\1*$/u.test(folded.replace(/\s/g, ''))) return false
  return true
}

function isPlaceholder(folded: string): boolean {
  if (PLACEHOLDER_EXACT.has(folded)) return true
  return PLACEHOLDER_PREFIX.some((p) => folded.startsWith(p))
}

/**
 * Judge one product.
 *
 * `type` is the caller's decision, not this function's, because it is decided
 * by where the product came from rather than by what it contains: anything
 * discovered from an external barcode-keyed source is a commercial product,
 * and generics only ever arrive from the curated seed. Scoring them by one set
 * of rules is what §11 forbids — a generic with no barcode is complete, a
 * commercial one with no barcode and no brand cannot be identified at all.
 */
export function judge(
  product: SourceProduct,
  type: 'generic' | 'commercial' = 'commercial',
): Verdict {
  const folded = foldName(product.name, null)

  // ─── rejections: evidence that this is not a product ──────────────────────

  if (!folded || folded.length < MIN_NAME) return { ok: false, reason: 'no-usable-name' }
  if (product.name.trim().length > MAX_NAME) return { ok: false, reason: 'name-too-long' }
  if (isPlaceholder(folded)) return { ok: false, reason: 'placeholder' }
  if (!looksLikeAName(folded)) return { ok: false, reason: 'name-not-a-name' }

  // The source itself says this product is gone. Believing it is cheaper than
  // discovering it on a shelf.
  if (product.obsolete) return { ok: false, reason: 'obsolete' }

  // A barcode that is not a barcode is evidence the record is corrupt, not
  // merely thin. Note this rejects the PRODUCT rather than dropping the code:
  // if the identifier is wrong, the record it came from is not trustworthy.
  if (product.gtins?.some((g) => !GTIN.test(g))) return { ok: false, reason: 'bad-barcode' }

  // §12: a commercial product needs SOMETHING that identifies it beyond a
  // string. A brand or a barcode will do; neither is a rejection, because two
  // different manufacturers' "Chocolate Bar" would collapse onto one row and
  // whichever arrived second would silently become the other.
  //
  // Not applied to generics, where having neither is the normal case.
  if (type === 'commercial' && !product.brand && !product.gtins?.length) {
    return { ok: false, reason: 'unidentifiable' }
  }

  return { ok: true, tier: tierOf(product, type) }
}

/**
 * How complete this product is, on the explainable three-step scale of §11.
 *
 * Reached only by products that already passed the gate, so C is "usable but
 * thin" rather than "suspect". The tiers feed ranking (worth at most 2 points,
 * far less than one rung of the search ladder) and the admin dashboard; they
 * never decide whether a row exists.
 */
export function tierOf(
  product: SourceProduct,
  type: 'generic' | 'commercial' = 'commercial',
): QualityTier {
  if (type === 'generic') {
    // A generic is complete when it can be found and placed: a name, a
    // category, and somewhere it is sold. No barcode is required and asking for
    // one would tier the entire curated seed as incomplete.
    if (product.category && product.markets?.length) return 'A'
    if (product.category || product.markets?.length) return 'B'
    return 'C'
  }

  const identified = Boolean(product.brand && product.gtins?.length)
  const placed = Boolean(product.markets?.length)
  const described = Boolean(product.quantity || product.imageUrl || product.category)

  // A is deliberately hard to reach and deliberately does NOT require
  // nutrition: §11 says a commercial product with a name, a brand and a barcode
  // is high quality without it, and Open Food Facts records are mostly missing
  // it.
  if (identified && placed && described) return 'A'
  if (identified) return 'B'
  return 'C'
}

/**
 * Run a batch through the gate, keeping the counts.
 *
 * The counts are the point as much as the survivors are. A discovery run that
 * accepts three of fifty is either working perfectly against a noisy query or
 * broken in a way no single-product test would show, and only the tally
 * distinguishes them.
 */
export function gate(
  products: SourceProduct[],
  type: 'generic' | 'commercial' = 'commercial',
): { accepted: SourceProduct[]; rejected: number; reasons: Record<string, number> } {
  const accepted: SourceProduct[] = []
  const reasons: Record<string, number> = {}
  let rejected = 0

  for (const p of products) {
    const v = judge(p, type)
    if (v.ok) {
      accepted.push(p)
    } else {
      rejected++
      const key = v.reason ?? 'unknown'
      reasons[key] = (reasons[key] ?? 0) + 1
    }
  }

  return { accepted, rejected, reasons }
}
