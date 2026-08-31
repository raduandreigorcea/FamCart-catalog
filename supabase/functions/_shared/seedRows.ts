import { MARKETS, LANGUAGES, CANONICAL_LANGUAGE, isLanguage, type Language } from './markets.ts'

// Turning the two seed files into rows catalog_import_products() will accept.
//
// This is the whole of the seed's logic, deliberately separated from the script
// that talks to Supabase, because it is the part that can be wrong in a way a
// human would not notice: a dropped alias, a category attached to the wrong
// product, a synonym promoted to a name. test/catalog/seedRows.test.js checks
// the shape; the database checks the rest.
//
// Pure — it takes the parsed JSON and returns rows. No filesystem, no network,
// no environment.

export interface SeedAlias {
  alias: string
  lang?: string
  type: 'name' | 'synonym' | 'category'
}

export interface ImportRow {
  type: 'generic' | 'commercial'
  name: string
  lang: string
  brand?: string
  category?: string
  markets: string[]
  tier: 'A' | 'B' | 'C'
  weight: number
  source_id: string
  gtins?: string[]
  aliases: SeedAlias[]
}

interface GenericEntry {
  id: string
  cat: string
  w: number
  n: Record<string, string>
  syn?: Record<string, string[]>
}

interface CommercialEntry {
  id: string
  type: 'generic' | 'commercial'
  name: string
  lang: string
  brand?: string
  markets: string[]
  w: number
  tier: 'A' | 'B' | 'C'
  gtins?: string[]
}

type CategoryNames = Record<string, Record<string, string>>

/**
 * Expand the generic concepts.
 *
 * One concept becomes one product: the English name is canonical and the other
 * five become alias rows of type 'name', which is what lets `lapte`, `milch`
 * and `lait` all reach it and what lets search_catalog hand a Romanian phone
 * the Romanian string back.
 *
 * MARKETS IS ALL ELEVEN, and that is a claim about generics rather than an
 * oversight. Milk is sold in every market this catalog covers; a shopping
 * concept has no distribution to be wrong about. It matters because markets
 * demote rather than filter — a generic with no markets at all would sort below
 * every commercial row for every phone, which is precisely backwards for the
 * rows that should answer a vague query.
 *
 * TIER A, for the same reason. A generic is scored by generic rules (§11): it
 * is complete when it has a canonical name, a category, its translations and
 * market relevance, and demanding a barcode of a banana would tier the entire
 * seed as incomplete.
 */
export function genericRows(
  generics: GenericEntry[],
  categories: CategoryNames,
): ImportRow[] {
  return generics.map((g) => {
    const aliases: SeedAlias[] = []

    // The five other names. A missing language is skipped rather than filled in
    // from English: an English string labelled as Romanian is worse than no
    // Romanian name, because search_catalog would then hand it back as the
    // readable one.
    for (const lang of LANGUAGES) {
      if (lang === CANONICAL_LANGUAGE) continue
      const name = g.n[lang]?.trim()
      if (name) aliases.push({ alias: name, lang, type: 'name' })
    }

    // Synonyms, including any in English. 'courgette' and 'zucchini' are both
    // right and only one can be the name.
    for (const [lang, list] of Object.entries(g.syn ?? {})) {
      if (!isLanguage(lang)) continue
      for (const alias of list) {
        const trimmed = alias.trim()
        if (trimmed) aliases.push({ alias: trimmed, lang, type: 'synonym' })
      }
    }

    // The category's own six names, so a query for a shelf ("lactate",
    // "Getränke") reaches every product on it. See catalog/seed/categories.json
    // for what this costs and why it is still worth it.
    const catNames = categories[g.cat]
    if (catNames) {
      for (const lang of LANGUAGES) {
        const name = catNames[lang]?.trim()
        if (name) aliases.push({ alias: name, lang, type: 'category' })
      }
    }

    return {
      type: 'generic',
      name: g.n[CANONICAL_LANGUAGE],
      lang: CANONICAL_LANGUAGE,
      category: g.cat,
      markets: [...MARKETS],
      tier: 'A',
      weight: g.w,
      source_id: g.id,
      aliases,
    }
  })
}

/**
 * Carry the verified commercial rows through unchanged.
 *
 * NO ALIASES AND NO TRANSLATION. Every one of these is the name printed on a
 * pack in Romania, and inventing five more would be inventing five commercial
 * facts (§4). They also get no category aliases, because they have no category:
 * the old catalog did not record one and guessing is the same mistake in a
 * smaller hat.
 */
export function commercialRows(products: CommercialEntry[]): ImportRow[] {
  return products.map((p) => ({
    type: p.type,
    name: p.name,
    lang: p.lang,
    ...(p.brand ? { brand: p.brand } : {}),
    markets: p.markets,
    tier: p.tier,
    weight: p.w,
    source_id: p.id,
    ...(p.gtins ? { gtins: p.gtins } : {}),
    aliases: [],
  }))
}

/**
 * Everything the seed has to say, in import order.
 *
 * GENERICS FIRST, and the order is load-bearing rather than cosmetic. Both
 * files can name the same folded string — "Lapte" the concept and a Romanian
 * shop line that happens to fold to it — and the first row through wins the
 * merge key. The generic winning is the right outcome: it is the one with six
 * names, a category and a market list, and the commercial row would arrive with
 * one name and no category and overwrite none of it (blanks may be filled, but
 * a filled field is never blanked) while contributing its own weight.
 */
export function buildSeedRows(
  generics: GenericEntry[],
  categories: CategoryNames,
  commercial: CommercialEntry[],
): ImportRow[] {
  return [...genericRows(generics, categories), ...commercialRows(commercial)]
}

/**
 * Every problem the database would reject a row for, found before the network
 * call rather than in a batch summary.
 *
 * Not a substitute for the constraints — those are the authority and they run
 * whatever this says. This exists because a rejected row inside a 500-row batch
 * comes back as one line of `errors` and nothing that says which seed file to
 * open, and a seed that silently ships 237 of its 238 concepts is exactly the
 * kind of quiet loss the whole project is written against.
 */
export function validateSeedRows(rows: ImportRow[]): string[] {
  const problems: string[] = []
  const seenId = new Map<string, number>()

  rows.forEach((row, i) => {
    const where = `${row.source_id || `#${i}`}`

    if (!row.name?.trim()) problems.push(`${where}: no name`)
    if (row.name && row.name.length > 120) problems.push(`${where}: name over 120 characters`)
    if (!isLanguage(row.lang)) problems.push(`${where}: name_lang '${row.lang}' is not one of the six`)
    if (row.brand && row.brand.length > 60) problems.push(`${where}: brand over 60 characters`)

    for (const m of row.markets) {
      if (!(MARKETS as readonly string[]).includes(m)) problems.push(`${where}: unknown market '${m}'`)
    }

    for (const a of row.aliases) {
      if (!a.alias.trim()) problems.push(`${where}: empty alias`)
      if (a.lang && !isLanguage(a.lang)) problems.push(`${where}: alias in unknown language '${a.lang}'`)
    }

    // One name per language is a unique index in the database, so a second one
    // is silently dropped by `on conflict do nothing` rather than raised. That
    // makes it invisible in the import summary and worth catching here.
    const namesByLang = new Map<string, string>()
    for (const a of row.aliases) {
      if (a.type !== 'name' || !a.lang) continue
      const existing = namesByLang.get(a.lang)
      if (existing) problems.push(`${where}: two ${a.lang} names ('${existing}', '${a.alias}')`)
      namesByLang.set(a.lang, a.alias)
    }

    for (const g of row.gtins ?? []) {
      if (!/^[0-9]{8,14}$/.test(g)) problems.push(`${where}: '${g}' is not a barcode`)
    }

    const prev = seenId.get(row.source_id)
    if (prev !== undefined) problems.push(`${where}: duplicate source id, also at #${prev}`)
    seenId.set(row.source_id, i)
  })

  return problems
}

export type { Language }

// ─── concepts ────────────────────────────────────────────────────────────────
// The second half of the seed, and it does NOT produce products.
//
// See catalog/seed/concepts.json for what a concept is and why the file has two
// halves. The shape here mirrors that split exactly:
//
//   * A concept derived from generics.json takes its NAMES from there. Restating
//     six translations in a second file would be two copies of one fact and the
//     copies would drift; only the intent is authored in concepts.json, and only
//     where it differs from the default.
//   * A concept in the `concepts` array has no product and is not meant to. It
//     carries its own six names because there is nowhere else for them to live.
//
// `productSourceId` is the thread back to a product. It is the generic's seed id,
// which is what catalog_sources records as source_product_id, and it is how the
// backfill attaches 188 rows to their concepts without matching on names.

export interface ConceptTerm {
  term: string
  lang?: string
  type: 'label' | 'synonym'
}

export interface ConceptRow {
  slug: string
  intent: 'generic' | 'branded' | 'mixed'
  category?: string
  weight: number
  terms: ConceptTerm[]
  /** The seed id of the generic product this concept came from, where there is one. */
  productSourceId?: string
}

export type ConceptIntent = ConceptRow['intent']

interface ConceptEntry {
  id: string
  cat?: string
  intent: ConceptIntent
  w: number
  n: Record<string, string>
  syn?: Record<string, string[]>
}

const INTENTS: readonly ConceptIntent[] = ['generic', 'branded', 'mixed']

/** Six labels plus any synonyms, skipping languages the entry does not have. */
function termsOf(names: Record<string, string>, syn?: Record<string, string[]>): ConceptTerm[] {
  const terms: ConceptTerm[] = []

  for (const lang of LANGUAGES) {
    const name = names[lang]?.trim()
    if (name) terms.push({ term: name, lang, type: 'label' })
  }

  for (const [lang, list] of Object.entries(syn ?? {})) {
    if (!isLanguage(lang)) continue
    for (const term of list) {
      const trimmed = term.trim()
      if (trimmed) terms.push({ term: trimmed, lang, type: 'synonym' })
    }
  }

  return terms
}

/**
 * Every concept the seed has to say, from both halves of the file.
 *
 * THE DEFAULT IS 'generic', and that is a claim about this seed rather than
 * about shopping. generics.json was deliberately built out of things you can
 * buy without choosing a brand — fifty concepts that needed one were removed
 * from it — so a row in there with no override is one nobody has to make a
 * commercial decision about. The overrides are the exceptions, which is why
 * they are the half that is written down.
 */
export function conceptRows(
  generics: GenericEntry[],
  intents: Record<string, string>,
  concepts: ConceptEntry[],
): ConceptRow[] {
  const fromGenerics: ConceptRow[] = generics.map((g) => ({
    slug: g.id,
    intent: (INTENTS as readonly string[]).includes(intents[g.id])
      ? (intents[g.id] as ConceptIntent)
      : 'generic',
    ...(g.cat ? { category: g.cat } : {}),
    weight: g.w,
    terms: termsOf(g.n, g.syn),
    productSourceId: g.id,
  }))

  const standalone: ConceptRow[] = concepts.map((c) => ({
    slug: c.id,
    intent: c.intent,
    ...(c.cat ? { category: c.cat } : {}),
    weight: c.w,
    terms: termsOf(c.n, c.syn),
  }))

  return [...fromGenerics, ...standalone]
}

/**
 * Every problem the database would reject a concept for, found before the call.
 *
 * The two that are worth catching here rather than in a batch summary:
 *
 *   * A DUPLICATE SLUG silently becomes an update in catalog_import_concepts,
 *     so the second entry quietly overwrites the first's intent and the summary
 *     reports a healthy run.
 *   * A TERM COLLIDING ACROSS CONCEPTS is legal in the database on purpose
 *     (`prune` is fresh plums in Romanian and dried plums in English), so
 *     nothing downstream will complain. It is reported here as a WARNING rather
 *     than a problem, because it is usually deliberate and occasionally a typo,
 *     and only a person can tell which.
 */
export function validateConceptRows(rows: ConceptRow[]): string[] {
  const problems: string[] = []
  const seenSlug = new Map<string, number>()

  rows.forEach((row, i) => {
    const where = row.slug || `#${i}`

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.slug)) problems.push(`${where}: slug is not kebab-case`)
    if (!(INTENTS as readonly string[]).includes(row.intent)) {
      problems.push(`${where}: intent '${row.intent}' is not generic, branded or mixed`)
    }
    if (!row.terms.length) problems.push(`${where}: no terms, so nothing can ever resolve to it`)

    const seenTerm = new Map<string, string>()
    for (const t of row.terms) {
      if (!t.term.trim()) problems.push(`${where}: empty term`)
      if (t.lang && !isLanguage(t.lang)) problems.push(`${where}: term in unknown language '${t.lang}'`)

      // WITHIN ONE LANGUAGE ONLY, and the distinction is the whole reason this
      // check is narrow. The same string being the label in several languages
      // is ordinary and correct -- "Mozzarella" is the name in all six, and so
      // are Broccoli, Dill and Vodka. The database holds one term row per
      // concept per folded string, so five of those six are dropped by
      // `on conflict do nothing` and resolution still works: the surviving row
      // carries whichever language won, and the string is identical anyway.
      //
      // A repeat inside ONE language is different. That is a label and a
      // synonym that say the same thing, or the same word typed twice, and
      // there is no reading of it that was intended.
      const key = `${t.lang ?? '-'}:${t.term.trim().toLowerCase()}`
      const prev = seenTerm.get(key)
      if (prev) problems.push(`${where}: '${t.term}' repeats '${prev}' in the same language`)
      seenTerm.set(key, t.term)
    }

    const prev = seenSlug.get(row.slug)
    if (prev !== undefined) problems.push(`${where}: duplicate slug, also at #${prev}`)
    seenSlug.set(row.slug, i)
  })

  return problems
}
