// The two vocabularies the catalog and the app have to agree on: which markets
// exist, and which languages a name can be written in.
//
// NEITHER LIST IS FREE TO DRIFT, and the failure mode when one does is silent
// in both directions:
//
//   * A market the app can SEND that the catalog never WRITES matches no
//     product at all. Every product is demoted for that phone, the dropdown
//     fills with foreign names, and it looks like a ranking bug rather than a
//     missing string. src/lib/region.ts derives a market from the timezone and
//     can emit any of the eleven below; the check constraint in
//     002_products.sql accepts exactly those eleven, and
//     test/catalog/markets.test.js pins this file against region.ts so a change
//     to either one fails a test rather than a search.
//   * A language the catalog stores that the app cannot render is a product
//     nobody can read. The six are the ones src/locales/ actually ships.
//
// Framework-free on purpose — no Vue, no Supabase, no Node built-ins — because
// the same module is imported by a Node script, by the Deno edge function, and
// by the vitest suite.

/**
 * The markets the catalog can speak about.
 *
 * ELEVEN, THOUGH THE SPECIFICATION NAMES SIX. GB, DE, ES, RO, FR and IT are the
 * primary markets and the ones the seed covers. MD, AT, CH, BE and IE are here
 * because src/lib/region.ts maps timezones to them — Chisinau, Vienna, Zurich,
 * Brussels, Dublin — and a phone in one of those cities has to be able to send
 * a market code the catalog recognises. They will be thin until discovery
 * fills them, which is the correct kind of empty: no rows yet, rather than rows
 * that can never match.
 */
export const MARKETS = ['RO', 'MD', 'DE', 'AT', 'CH', 'ES', 'FR', 'BE', 'IT', 'GB', 'IE'] as const

export type Market = (typeof MARKETS)[number]

/**
 * The six markets the specification names as primary, and the only ones the
 * curated seed claims coverage of.
 *
 * Kept separate from MARKETS rather than folded into it because they answer
 * different questions. MARKETS is "what may be stored"; this is "where we have
 * actually done the work". Discovery uses this to decide which country tags
 * from an external source are worth treating as evidence.
 */
export const PRIMARY_MARKETS: readonly Market[] = ['GB', 'DE', 'ES', 'RO', 'FR', 'IT']

/**
 * The languages a product name may be written in — the six FamCart's interface
 * speaks, and therefore the six a name can be read in.
 *
 * A name in a seventh language is not stored: it would look present in the
 * table and be unreadable to every user of the app, which is worse than absent
 * because it also occupies the merge key for that product.
 */
export const LANGUAGES = ['en', 'de', 'es', 'ro', 'fr', 'it'] as const

export type Language = (typeof LANGUAGES)[number]

/**
 * English, and why it is named rather than assumed.
 *
 * Generic concepts are canonically English and translated through aliases, so
 * every other language for a generic is an alias row. Commercial products keep
 * whatever language their pack is printed in — a brand name is not a word to be
 * translated (spec §4, §14).
 */
export const CANONICAL_LANGUAGE: Language = 'en'

export function isMarket(value: unknown): value is Market {
  return typeof value === 'string' && (MARKETS as readonly string[]).includes(value)
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}
