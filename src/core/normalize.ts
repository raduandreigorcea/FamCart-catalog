// The fold, and the quantity parser it depends on.
//
// THE FOLD HAS THREE COPIES AND THEY CANNOT BE WRITTEN ONCE:
//
//   * catalog_normalize() in supabase/migrations/002_catalog.sql -- THE
//     AUTHORITY, and the only one whose answer is ever stored.
//   * this one, used by the scrapers before anything reaches the database.
//   * normalizeSearchText() in the app's src/lib/productSearch.ts -- the browser
//     copy, used to dedupe a dropdown showing rows from two databases.
//
// The first two agree, and this file is where that costs something. Postgres
// folds with unaccent, which is a DICTIONARY; JavaScript's NFD plus a
// combining-mark strip is an ALGORITHM, and an algorithm can only remove marks.
// So NFD alone leaves ss, oe, ae, d, 1/2, (r) and * unmade -- it returns ß, œ,
// æ, đ, ½, ® and × untouched. UNACCENT (generated from the database by
// scripts/regenerate-fold-fixture.mjs) is the dictionary half, and
// test/fixtures/fold.json is what the database actually answered, so
// test/fold.test.ts can prove the two still agree.
//
// THE BROWSER COPY IS THE ODD ONE OUT and knowingly so: it is NFD-only, so it
// still differs on those characters. That is pre-existing app behaviour, it
// costs at most a duplicated line in a dropdown, and changing it belongs to the
// app rather than here. It is worth knowing about rather than assuming all
// three are identical.

import { UNACCENT } from './unaccent.generated.ts'

// Matches any character the dictionary knows about. Built once from the table's
// own keys, so adding an entry cannot leave the pattern behind.
const EXPANDABLE = new RegExp(`[${Object.keys(UNACCENT).map(escapeForClass).join('')}]`, 'g')

function escapeForClass(ch: string): string {
  return `\\u${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Strip diacritics, lowercase, collapse whitespace, trim. */
export function fold(text: string | null | undefined): string {
  return String(text ?? '')
    // The dictionary first: NFD would decompose some of these into a base letter
    // plus a mark and lose the second half of the expansion.
    .replace(EXPANDABLE, (ch) => UNACCENT[ch] ?? ch)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The fold with punctuation flattened, matching catalog_key_fold() in SQL.
 *
 * Only the merge key uses this. "Coca-Cola" and "Coca Cola" are one brand
 * written two ways and no shop is consistent about it, but fold() has to keep
 * answering what catalog_normalize() answers -- so the extra strictness lives in
 * a second function rather than being folded into the first.
 */
export function keyFold(text: string | null | undefined): string {
  return fold(text).replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface ParsedQuantity {
  quantity: number
  unit: 'g' | 'kg' | 'ml' | 'l' | 'buc'
}

// The unit words Romanian retailers actually write, mapped to what the catalog
// stores. `cl` is converted rather than stored: 002 has no centilitre.
const UNIT_WORDS: Record<string, { unit: ParsedQuantity['unit']; factor: number }> = {
  kg: { unit: 'kg', factor: 1 }, kilograme: { unit: 'kg', factor: 1 }, kilogram: { unit: 'kg', factor: 1 },
  g: { unit: 'g', factor: 1 }, gr: { unit: 'g', factor: 1 }, grame: { unit: 'g', factor: 1 },
  mg: { unit: 'g', factor: 0.001 },
  l: { unit: 'l', factor: 1 }, litri: { unit: 'l', factor: 1 }, litru: { unit: 'l', factor: 1 },
  ml: { unit: 'ml', factor: 1 }, mililitri: { unit: 'ml', factor: 1 },
  cl: { unit: 'ml', factor: 10 },
  buc: { unit: 'buc', factor: 1 }, bucati: { unit: 'buc', factor: 1 }, bucata: { unit: 'buc', factor: 1 },
  set: { unit: 'buc', factor: 1 },
}

const UNIT_PATTERN = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join('|')

// A number, optionally preceded by "N x" for a multipack, followed by a unit.
//
// The multipack matters more than it looks: "6 x 0,5 L" is three litres and
// "0,5 L" is half of one, and treating them alike would put a crate and a bottle
// in the same row. The size is part of the merge key precisely so it cannot.
const QUANTITY_RE = new RegExp(
  String.raw`(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(${UNIT_PATTERN})\b`,
  'gi',
)

/**
 * Pull the pack size out of a product name.
 *
 * Returns the LAST match, not the first. Romanian product names put the size at
 * the end ("Lapte UHT Zuzu 3.5% 1L") and any earlier number is usually something
 * else -- a fat percentage, a flavour count, a model number.
 *
 * A percentage is never a quantity: `%` is not a unit word, so "3.5%" cannot
 * match. That is worth stating because it is the single most common number in a
 * Romanian dairy aisle.
 */
export function parseQuantity(name: string | null | undefined): ParsedQuantity | null {
  const text = fold(name)
  if (!text) return null

  let last: RegExpExecArray | null = null
  QUANTITY_RE.lastIndex = 0
  for (let m = QUANTITY_RE.exec(text); m !== null; m = QUANTITY_RE.exec(text)) {
    // "3.5%" and friends: a unit word immediately followed by more letters is
    // part of a longer word, not a unit. \b already stops most of it; this
    // catches "1 large" style cases where `l` would otherwise match.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1)
    if (after && /[a-z0-9]/.test(after)) continue
    last = m
  }
  if (!last) return null

  const multiplier = last[1] ? Number(last[1]) : 1
  const amount = Number(last[2].replace(',', '.'))
  const word = UNIT_WORDS[last[3].toLowerCase()]
  if (!word || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(multiplier)) return null

  const quantity = round(amount * word.factor * multiplier)
  if (quantity <= 0 || quantity > 1_000_000) return null
  return { quantity, unit: word.unit }
}

/** Strip a trailing/embedded size token, matching catalog_strip_quantity(). */
export function stripQuantity(name: string): string {
  return name
    .replace(/(\+\/-|\+-|±|\bcca\b|\baprox\.?\b|\bca\.)/gi, ' ')
    .replace(QUANTITY_RE, ' ')
    .replace(/\s*[,;·/+-]+\s*(?=[,;·/+-]|$)|^\s*[,;·/+-]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * A GTIN is 8 to 14 digits AND its check digit has to work out.
 *
 * The length test alone lets through order numbers, internal SKUs and truncated
 * codes, and a wrong barcode is worse than none: it is the highest-priority
 * match in the importer, so one bad code merges two unrelated products with full
 * confidence. Auchan's own data has both -- real EANs and 13-digit internal
 * references for loose produce, which fail this and are correctly dropped.
 */
export function validGtin(code: string | null | undefined): string | null {
  const digits = String(code ?? '').trim()
  if (!/^[0-9]{8,14}$/.test(digits)) return null

  let sum = 0
  // From the right, excluding the check digit: alternate weights 3 and 1.
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight
  }
  const check = (10 - (sum % 10)) % 10
  return check === Number(digits[digits.length - 1]) ? digits : null
}

/** https only, and short enough for the column. */
export function httpsUrl(url: string | null | undefined, maxLength = 1000): string | null {
  const value = String(url ?? '').trim()
  if (!value) return null
  const absolute = value.startsWith('//') ? `https:${value}` : value
  if (!absolute.startsWith('https://')) return null
  return absolute.length <= maxLength ? absolute : null
}
