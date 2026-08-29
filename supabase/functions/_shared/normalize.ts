// The fold, in TypeScript.
//
// THIS IS THE THIRD COPY OF ONE RULE and that is worth saying plainly, because
// the instinct on seeing it is to delete two of them. It cannot be one copy:
// the rule has to run in three places that share no runtime.
//
//   1. `catalog_normalize()` in 002_products.sql — the AUTHORITY. It computes
//      the merge key and the search blob, and it is the only one whose answer
//      is ever stored.
//   2. `normalizeSearchText()` in src/lib/productSearch.ts — the browser's, for
//      the client-side dedupe key when two projects return the same product.
//   3. This one — for the discovery pipeline, which has to decide whether an
//      Open Food Facts result is something the catalog already holds BEFORE it
//      writes anything, and cannot call the database function to find out
//      (catalog_normalize is revoked from every role but the owner, on purpose).
//
// WHAT A DRIFT COSTS, so the risk is understood rather than feared. Nothing
// crashes. A disagreement between (1) and (3) means discovery proposes a row
// the catalog already has, and `catalog_import_products` merges it on the real
// key anyway — one wasted round trip. A disagreement between (1) and (2) means
// a duplicate line in a dropdown. Neither loses data, because (1) is the only
// one that writes. test/catalog/discovery.test.js pins this copy against a
// fixture of answers taken from a running database.
//
// HOW THEY ARE KEPT IN STEP. Postgres' `unaccent` is a DICTIONARY, not a rule:
// it expands `ß` to `ss` and `œ` to `oe`, maps an en-dash to a hyphen and a
// guillemet to `<<`. `NFD` + `\p{Diacritic}` does none of that, because none of
// those are accented letters. So the table below reproduces the part of that
// dictionary product names actually reach, and it was read OUT OF THE DATABASE
// rather than written from memory — test/catalog/fixtures/fold.json holds the
// answers `catalog_normalize()` gave, and test/catalog/discovery.test.js fails
// if this file stops agreeing with them.

/**
 * Everything `unaccent` changes that Unicode decomposition does not.
 *
 * NOT GUESSED. Every entry was read out of the database by asking
 * `catalog_normalize()` directly, one character at a time, and the fixture at
 * test/catalog/fixtures/fold.json pins the whole table against it. That is the
 * only honest way to build this: unaccent is a dictionary, its contents are not
 * derivable from a rule, and the two runtimes disagreeing is silent.
 *
 * TWO KINDS OF ENTRY, and only one of them is obvious:
 *
 *   LETTERS THAT EXPAND. `ß` becomes `ss`, `æ` becomes `ae`, `œ` becomes `oe`.
 *   NFD does not touch these, because they are not accented letters — they are
 *   their own letters with no decomposition. This is the class that actually
 *   bites: "Größe" folded to "große" here and "grosse" in Postgres, so a German
 *   product could be inserted twice and found by neither spelling.
 *
 *   TYPOGRAPHY. Dashes, curly quotes, guillemets, ligatures. These reach
 *   product names constantly because names are copied off packaging and out of
 *   scraped catalogs.
 *
 * Note `«` becomes `<<` rather than `"` — which is what unaccent does, and not
 * what anyone would guess. That is the whole argument for the fixture.
 */
const UNACCENT: Record<string, string> = {
  // Letters with no decomposition, which NFD therefore cannot reach.
  'ß': 'ss',
  'æ': 'ae',
  'œ': 'oe',
  'ø': 'o',
  'đ': 'd',
  'ð': 'd',
  'ł': 'l',
  'ŀ': 'l',
  'þ': 'th',
  'ı': 'i',
  'ĳ': 'ij',
  'ŉ': "'n",

  // Ligatures, which turn up in PDF-scraped names.
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',

  // Dashes. Every one of these is used as a separator on packaging.
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',

  // Quotes. The apostrophe in "Lay's" is typeset as U+2019 more often than not.
  '‘': "'",
  '’': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': ',,',
  '«': '<<',
  '»': '>>',
  '‹': '<',
  '›': '>',

  '…': '...',

  // Symbols. The trademark and copyright marks are on half the branded product
  // names in an external catalog, and the fractions turn up in package sizes
  // written as "1½ L".
  //
  // NOTE THE LEADING SPACES on the fractions: unaccent expands '½' to ' 1/2',
  // so "1½" becomes "1 1/2" rather than "11/2". Reproducing that exactly is the
  // difference between the two runtimes agreeing and almost agreeing, and it is
  // not something anyone would have written from memory — see the fixture.
  '®': '(r)',
  '©': '(c)',
  '№': 'no',
  '½': ' 1/2',
  '¼': ' 1/4',
  '¾': ' 3/4',
  '⅓': ' 1/3',
  '⅔': ' 2/3',
  '⅛': ' 1/8',
  '×': '*',
  '÷': '/',
  '±': '+/-',
  '¡': '!',
  '¿': '?',
}

/**
 * Applied per code point rather than through a regex.
 *
 * A character class built from the keys would need every one of them escaped,
 * and a table this long is exactly where an escaping mistake hides — it would
 * not throw, it would silently stop mapping one character. Walking the string
 * cannot be wrong, and these strings are product names rather than documents.
 */
function expand(text: string): string {
  let out = ''
  for (const ch of text) out += UNACCENT[ch] ?? ch
  return out
}

/**
 * Fold a name (and optionally a brand) to its matching key.
 *
 * Lowercase, strip diacritics, normalise punctuation, collapse whitespace. The
 * brand is appended rather than compared separately, which is what makes
 * "Pepsi Zero" by Pepsi and "Pepsi Zero" by anyone else two different products
 * — the same decision `catalog_normalize(p_name, p_brand)` makes.
 *
 * An empty or whitespace-only name folds to the empty string, and every caller
 * treats that as "no usable name" rather than as a key.
 */
export function foldName(name: string | null | undefined, brand?: string | null): string {
  const base = (name ?? '').trim()
  const maker = (brand ?? '').trim()
  const joined = maker ? `${base} ${maker}` : base

  // LOWERCASE FIRST, so the table only needs the lowercase forms. It also does
  // the right thing with the awkward ones for free: 'İ' lowercases to 'i' plus
  // a combining dot, which the NFD step then strips, and 'ẞ' lowercases to 'ß',
  // which the table then expands.
  return expand(joined.toLowerCase())
    // NFD splits an accented letter into letter + combining mark; the second
    // step deletes the marks. Together they are what unaccent does to the
    // letters that DO decompose, which is most of them.
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The query side of the same fold.
 *
 * Separate from foldName only so the call sites read as what they are — there
 * is no brand to append to a search box — and so a future change to one cannot
 * be made without noticing it applies to the other.
 */
export function foldQuery(query: string | null | undefined): string {
  return foldName(query, null)
}

/**
 * The words a query is made of, bounded.
 *
 * Six, matching `max_tokens` in search_catalog(). More than that is a pasted
 * paragraph rather than a product, and every token past the sixth only narrows
 * an already-narrow match.
 */
export function tokens(query: string | null | undefined, limit = 6): string[] {
  const folded = foldQuery(query)
  if (!folded) return []
  return folded.split(' ').filter(Boolean).slice(0, limit)
}

/**
 * Does this folded haystack contain every token of the query?
 *
 * The same test `search_catalog` makes with `like all (...)`, in the one place
 * discovery needs to answer it without a round trip: deciding whether a result
 * that came back from an external source is actually a match for what the
 * person typed, or merely something the external search felt like returning.
 */
export function matchesAllTokens(haystack: string, query: string): boolean {
  const want = tokens(query)
  if (!want.length) return false
  const hay = foldQuery(haystack)
  return want.every((t) => hay.includes(t))
}
