import { foldName, foldQuery, matchesAllTokens } from './normalize.ts'
import { gate, tierOf } from './quality.ts'
import type { SourceName, SourceProduct } from './sources/types.ts'

// The decisions between "somebody typed something" and "a row exists".
//
// Kept apart from the adapter and from the database on purpose: this is the
// part with judgement in it, and judgement is what deserves tests that run in
// milliseconds without a network or a Postgres.
//
// The order, which is §5:
//
//   1. Are the LOCAL results already good enough?   -> stop, ask nobody
//   2. Ask the source
//   3. Does each result actually match what was typed?
//   4. Quality gate
//   5. Deduplicate against what is already here, conservatively
//   6. Hand what survives to catalog_import_products
//
// Steps 1 and 3 are the two that stop this from being a firehose, and they are
// the two that look redundant until you watch an external search return
// "Chocolat au lait" for the query "lapte".

/** What the local catalog returned; the shape search_catalog() gives back. */
export interface LocalRow {
  name: string
  maker: string | null
  popularity: number
}

/**
 * How many BUYABLE local answers count as the question being answered.
 *
 * Six, which is what the dropdown shows on a phone. The rule it replaces was
 * "at least one row contains every word typed", and that rule had a failure
 * nobody predicted until it was watched in production: it is satisfied by the
 * curated seed's own GENERIC rows.
 *
 * Searching "apa" (water) returned a seed row literally named "Apă", which
 * contains every word typed, so discovery was declared unnecessary and NEVER
 * RAN — not once, not ever, for one of the most common words in the catalog's
 * main language. The result was frozen at the six waters the seed shipped with
 * while AQUA Carpatica, Azuga and Bucovina sat one API call away. The same was
 * true of lapte, paine, oua and every other everyday word the seed covers:
 * obscure queries grew the catalog and common ones could not.
 *
 * So the question is no longer "did anything match" but "could this person fill
 * a dropdown with things they can actually buy". A row with no brand is a
 * concept rather than a product — "Apă" tells somebody holding the list
 * nothing — so only branded rows count toward the total.
 *
 * The cost is one external call for a query whose local answer is thin, and the
 * per-source cache absorbs the repeat: a hit is remembered for fourteen days
 * and the products it found are local from then on.
 */
export const SUFFICIENT_MATCHES = 6

/**
 * Is the local catalog's answer good enough to skip the external call?
 *
 * THE MOST IMPORTANT FUNCTION HERE, because it is the one that decides how
 * often anything external happens at all, and how fast the catalog can grow.
 *
 * Two things have to be true. The words have to match — one row containing
 * every token, which is the same test the database's own search makes with
 * `like all (...)`, and which stops ten category matches from passing as an
 * answer to "pepsi zero". AND there have to be enough of them to choose from,
 * counted in BRANDED rows only. See SUFFICIENT_MATCHES for why the second half
 * exists; without it the seed's generic rows answer for their whole category
 * forever.
 *
 * `minQueryLength` is 3 by §6: below that an external search returns noise
 * proportional to how common the letters are, and the local prefix match is
 * already the better answer.
 */
export type ConceptIntent = 'generic' | 'branded' | 'mixed'

export interface SufficiencyOptions {
  minQueryLength?: number
  sufficientMatches?: number
  /**
   * What the word MEANS, from catalog_concept_lookup(), or null when no concept
   * claims it.
   *
   * NULL IS TREATED AS 'branded', and that default is the reason `chorizo`
   * works. A word no concept knows is a word the catalog has never been asked
   * about, and the useful assumption about it is that somebody is looking for a
   * product we do not stock yet. Assuming 'generic' instead would answer every
   * unknown word with whatever happened to match its letters and never ask
   * anybody.
   */
  intent?: ConceptIntent | null
}

export function isLocalSufficient(
  rows: LocalRow[],
  query: string,
  opts: SufficiencyOptions = {},
): boolean {
  const folded = foldQuery(query)
  if (folded.length < (opts.minQueryLength ?? 3)) return true
  if (!rows.length) return false

  const answers = rows.filter((r) => matchesAllTokens(`${r.name} ${r.maker ?? ''}`, query))
  if (!answers.length) return false

  // ─── a generic concept is answered by the bare row ────────────────────────
  //
  // THE HALF THAT WAS MISSING, and it was a real regression rather than a
  // theoretical one. Counting branded rows fixed `apa`, where the seed's own
  // "Apă" had been suppressing discovery forever — and it broke `cartofi` in
  // the opposite direction, because potatoes have no brands and never will, so
  // every produce query started paying for an external call that could not
  // possibly return anything better than the row already on screen.
  //
  // No row count is right for both. The difference between water and potatoes
  // is not a quantity, it is a fact about the word, and this is the line where
  // knowing that fact pays for the whole concept layer.
  if (opts.intent === 'generic') return true

  // Branded and mixed both want real products, and for the same reason: a row
  // with no maker is a concept, and a list saying "Apă" makes whoever is
  // holding it guess. Mixed differs in how the results are RANKED, not in
  // whether it is worth asking — `lapte` should have Zuzu and Napolact in it,
  // and the one external call that fetches them is cached for a fortnight.
  const buyable = answers.filter((r) => (r.maker ?? '').trim().length > 0)
  return buyable.length >= (opts.sufficientMatches ?? SUFFICIENT_MATCHES)
}

/**
 * How many products one search may add, given what was asked and what was here.
 *
 * TWO CONDITIONS, and both matter. The local answer has to be thin — there is
 * no point flooding a category the catalog already covers — AND the query has
 * to look like BROWSING rather than like a specific product.
 *
 * One word is the browse signal. "apa", "lapte", "bere", "chorizo" are asked by
 * somebody who wants to see what there is, and answering them eight at a time
 * means the ninth costs the next person another round trip: a live "apa" run
 * accepted 8 and discarded 15 more that had already passed every filter.
 *
 * Two or more words is somebody naming a thing. "milka oreo" returned nineteen
 * records that were the same biscuit under four brand attributions, which is
 * exactly what §29.2's cap exists to refuse, and raising it there would undo
 * that. So a multi-word query keeps the original eight however thin the local
 * answer was.
 */
export function capFor(
  local: LocalRow[],
  query: string,
  intent: ConceptIntent | null = null,
): number {
  // The same threshold that decided to ask at all, not a weaker one. Asking
  // "is there at least one branded row" was the first version and it never
  // fired: a category with two products in it has one, so "faina" kept taking
  // eight and leaving eleven behind.
  if (isLocalSufficient(local, query, { intent })) return MAX_ACCEPTED
  const browsing = foldQuery(query).split(' ').filter(Boolean).length === 1
  return browsing ? MAX_ACCEPTED_COLD : MAX_ACCEPTED
}

/**
 * Take the category back out of the brand, using the words we actually know.
 *
 * ─── the problem no string rule can solve ────────────────────────────────────
 *
 * Open Food Facts' `brands` field frequently holds category text. A live
 * chorizo search returned `Chorizo doux` with brand "Chorizo"; a shampoo search
 * returned `Alpecin HYBRID Caffeine Shampoo` with brand "Shampoo".
 *
 * Every attempt to catch that by inspecting the strings alone failed, and failed
 * in the expensive direction. "The brand is inside the name" flags `Pampers
 * Nappies` by Pampers and `Hochland Cascaval` by Hochland -- measured against
 * the live catalog it was wrong about 28 rows out of 36. The difference between
 * "Chorizo" and "Pampers" is not length, position or shape. It is that one is a
 * common noun and the other is a proper one, and a string cannot tell you which.
 *
 * ─── what makes it solvable now ──────────────────────────────────────────────
 *
 * catalog_concept_terms is a list of exactly the common nouns this catalog
 * knows, in six languages. A brand that IS one of them is the category leaking
 * out of the source's brand field, and a brand that is not is left completely
 * alone. Nothing is guessed: the check is equality against a curated word list.
 *
 * ─── why it runs before the relevance filter ─────────────────────────────────
 *
 * `Ben's Original` is a PAELLA RICE that reached the chorizo results, because
 * relevantTo() matches on `name + brand` and its brand was "Favourites Chorizo
 * And Vegetable Paella". A junk brand does not merely look wrong under a
 * product -- it walks products that are not the thing you searched for straight
 * through the gate. Cleaning first is what makes the gate honest.
 *
 * The brand is CLEARED, never rewritten. A product with no brand is findable
 * and correct; a product with an invented one is a commercial fact nobody
 * checked (S4).
 */
/**
 * Drop results that are only the concept's own word with nothing attached.
 *
 * ─── what these look like ────────────────────────────────────────────────────
 *
 * Open Food Facts holds a great many records that are a barcode, the bare word
 * ("Pâine", "Batterien", "Pilas", "Air freshener"), and nothing else. They pass
 * the quality gate honestly -- a barcode identifies them -- and they are still
 * useless on a shopping list, because they are indistinguishable from the
 * generic concept while claiming to be a product. A dropdown that answers
 * "paine" with the word "Pâine" four times has told the reader nothing.
 *
 * They are also the worst possible rows in the best possible position:
 * `name_exact` scores 100, so they outrank every real product. Searching
 * "paine" put five of them above Dobrogea's sliced loaf.
 *
 * ─── the same judgement the seed already made ────────────────────────────────
 *
 * Fifty concepts were cut from the curated seed for exactly this, under the
 * test "is the bare word enough to shop from". This applies that test to what
 * discovery brings back, rather than only to what a person authored.
 *
 * ─── why a brand rescues it ──────────────────────────────────────────────────
 *
 * "Pâine" by Bacus IS shoppable: it names a bakery, so whoever is holding the
 * list can buy the right thing. Only the rows with no maker at all are refused,
 * which measured against the live catalog is 170 rows out of 8,407 -- the ones
 * that carry no information whatsoever beyond a word the catalog already knows.
 *
 * A quantity is not enough on its own to keep the name, but it changes the
 * name: `Lapte 3.5% 1L` is not the bare word and never reaches this filter.
 */
export function withoutBareConcepts(
  products: SourceProduct[],
  categoryTerms: string[],
): SourceProduct[] {
  if (!categoryTerms.length) return products
  const words = new Set(categoryTerms.map((t) => foldQuery(t)).filter(Boolean))
  if (!words.size) return products

  return products.filter((p) => {
    if (p.brand && p.brand.trim()) return true
    return !words.has(foldQuery(p.name))
  })
}

export function stripCategoryBrands(
  products: SourceProduct[],
  categoryTerms: string[],
): SourceProduct[] {
  if (!categoryTerms.length) return products
  const words = new Set(categoryTerms.map((t) => foldQuery(t)).filter(Boolean))
  if (!words.size) return products

  return products.map((p) => {
    if (!p.brand || !words.has(foldQuery(p.brand))) return p
    const { brand: _dropped, ...rest } = p
    return rest
  })
}

export function relevantTo(products: SourceProduct[], query: string): SourceProduct[] {
  return products.filter((p) => matchesAllTokens(`${p.name} ${p.brand ?? ''}`, query))
}

/**
 * Remove anything the catalog already has.
 *
 * CONSERVATIVE IN ONE DIRECTION ONLY, and the direction matters. This function
 * decides what NOT to send; being wrong here costs a wasted row in a batch that
 * `catalog_import_products` merges correctly anyway, because the database holds
 * the real merge key and this does not. So it errs toward sending.
 *
 * §15's strong match is a shared GTIN, and that is checked in the database
 * where the identifier table lives. What can be checked here is the folded
 * name, which is the same key the unique index uses — near enough to catch the
 * common case (the product is already in the catalog, verbatim) and not
 * pretending to more.
 *
 * It deliberately does NOT try "same brand + similar name + compatible
 * quantity". That is §15's *potential* match, and a potential match is exactly
 * what must stay two rows until stronger evidence arrives.
 */
export function withoutKnown(products: SourceProduct[], local: LocalRow[]): SourceProduct[] {
  const known = new Set(local.map((r) => foldName(r.name, r.maker)))
  const knownNameOnly = new Set(local.map((r) => foldName(r.name, null)))

  return products.filter((p) => {
    const withBrand = foldName(p.name, p.brand ?? null)
    if (known.has(withBrand)) return false
    // A local row with no maker and the same name is the same product: the
    // curated seed stores "Lapte" with no brand, and an external record calling
    // it "Lapte" by "Zuzu" is a different row that the database will keep
    // separate anyway. Only an exact nameless match is treated as known.
    if (!p.brand && knownNameOnly.has(foldName(p.name, null))) return false
    return true
  })
}

/**
 * Collapse duplicates WITHIN one batch.
 *
 * External searches return the same product several times under different
 * barcodes — a relabelled pack, a regional variant, the same drink in two
 * sizes with the size missing from both names. Sending all of them lets the
 * database merge them one at a time, each merge a separate subtransaction, with
 * the last writer's blanks winning arbitrarily.
 *
 * Merging here instead means one row with every barcode attached, which is what
 * `catalog_identifiers` is shaped for. The keeper is the most complete record
 * rather than the first, because "first" is the external service's ranking and
 * has nothing to do with which record describes the product best.
 */
export function collapse(products: SourceProduct[]): SourceProduct[] {
  const byKey = new Map<string, SourceProduct>()

  for (const p of products) {
    const key = foldName(p.name, p.brand ?? null)
    if (!key) continue

    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...p, gtins: [...(p.gtins ?? [])] })
      continue
    }

    // Keep every barcode; they are all exact keys for the same product.
    const gtins = new Set([...(existing.gtins ?? []), ...(p.gtins ?? [])])
    // Union the markets, for the same reason the database unions them: a source
    // that only knows about France is not evidence against Romania.
    const markets = new Set([...(existing.markets ?? []), ...(p.markets ?? [])])

    const keeper = completeness(p) > completeness(existing) ? p : existing
    byKey.set(key, {
      ...keeper,
      gtins: [...gtins],
      ...(markets.size ? { markets: [...markets] } : {}),
      // Blanks filled from whichever record has them, never overwritten. Same
      // rule as the import RPC, applied one step earlier so the batch is
      // already coherent when it arrives.
      brand: keeper.brand ?? existing.brand ?? p.brand,
      category: keeper.category ?? existing.category ?? p.category,
      imageUrl: keeper.imageUrl ?? existing.imageUrl ?? p.imageUrl,
      quantity: keeper.quantity ?? existing.quantity ?? p.quantity,
      quantityUnit: keeper.quantityUnit ?? existing.quantityUnit ?? p.quantityUnit,
    })
  }

  return [...byKey.values()]
}

/**
 * How much this record actually says, for choosing between two of the same
 * product. Not a quality score and not stored — `quality.ts` owns tiering.
 */
function completeness(p: SourceProduct): number {
  return (
    (p.brand ? 2 : 0) +
    (p.gtins?.length ? 2 : 0) +
    (p.markets?.length ? 1 : 0) +
    (p.category ? 1 : 0) +
    (p.quantity ? 1 : 0) +
    (p.imageUrl ? 1 : 0) +
    (p.completeness ?? 0) +
    // Real people have scanned it. The strongest single piece of evidence that
    // a record describes a product that exists, so it is worth more than any
    // individual field — but capped, so a popular record cannot win on scans
    // alone against one that actually carries the data.
    Math.min(p.uniqueScans ?? 0, 3)
  )
}

/** A row in the shape catalog_import_products(p_rows, p_source) expects. */
export interface ImportRow {
  type: 'commercial' | 'generic'
  name: string
  lang: string
  brand?: string
  category?: string
  markets: string[]
  quantity?: number
  unit?: string
  image_url?: string
  tier: 'A' | 'B' | 'C'
  gtins?: string[]
  source_id: string
  source_url?: string
  source_updated_at?: string
  /**
   * Which database this row came from.
   *
   * NOT read by `catalog_import_products` — that RPC takes one `p_source` for
   * the whole batch and writes it into `catalog_sources` itself. It is carried
   * here so the caller can GROUP by it before calling, because provenance is a
   * per-row fact once more than one source is being asked and an ODbL
   * attribution recorded against the wrong database is simply wrong.
   */
  source: SourceName
}

/**
 * Split accepted rows by which source they came from.
 *
 * The shape `catalog_import_products(p_rows, p_source)` needs: one call per
 * source, each batch honestly attributed. Insertion order is preserved so a
 * single-source result still produces a single call with the rows in the order
 * the pipeline ranked them.
 */
export function groupBySource(rows: ImportRow[]): Map<SourceName, ImportRow[]> {
  const groups = new Map<SourceName, ImportRow[]>()
  for (const row of rows) {
    const existing = groups.get(row.source)
    if (existing) existing.push(row)
    else groups.set(row.source, [row])
  }
  return groups
}

/**
 * Translate accepted products into what the import RPC takes.
 *
 * `weight` is absent on purpose and would be ignored if present: editorial
 * weight belongs to the curated seed, and the RPC refuses to set it for any
 * source but `curated`. A discovered product starts at zero and earns every
 * point of its ranking from people actually adding it.
 *
 * `lang` falls back to English rather than to the searcher's language. Labelling
 * a French product's name as Romanian because a Romanian searched for it would
 * put an unreadable string where `search_catalog` looks for a readable one.
 */
export function toImportRows(products: SourceProduct[]): ImportRow[] {
  return products.map((p) => ({
    type: 'commercial' as const,
    name: p.name.trim(),
    lang: p.lang ?? 'en',
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.category ? { category: p.category } : {}),
    markets: p.markets ?? [],
    ...(p.quantity && p.quantityUnit ? { quantity: p.quantity, unit: p.quantityUnit } : {}),
    ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
    tier: tierOf(p, 'commercial'),
    ...(p.gtins?.length ? { gtins: p.gtins } : {}),
    source: p.source,
    source_id: p.sourceId,
    ...(p.sourceUrl ? { source_url: p.sourceUrl } : {}),
    ...(p.sourceUpdatedAt ? { source_updated_at: p.sourceUpdatedAt } : {}),
  }))
}

export interface PipelineResult {
  rows: ImportRow[]
  stats: {
    returned: number
    irrelevant: number
    bare: number
    rejected: number
    alreadyKnown: number
    collapsed: number
    accepted: number
    overflow: number
    reasons: Record<string, number>
  }
}

/**
 * Everything between the source's answer and the database's input, in order.
 *
 * One function so the order is stated once and cannot drift between callers,
 * and so the stats come out as a single object the metrics can record. The
 * order is load-bearing:
 *
 *   relevance BEFORE quality, because judging a product that was never an
 *   answer to this query wastes the judgement and pollutes the rejection
 *   counts with things that were fine but irrelevant;
 *
 *   quality BEFORE dedupe, because a rejected row must not suppress a good
 *   duplicate of itself;
 *
 *   collapse BEFORE the known-check, so a product that arrives three times and
 *   is already in the catalog is counted once, not three times.
 */
/**
 * How many products one search may add to the catalog.
 *
 * §29.2: "Do not save every external API result." Without a cap this is not a
 * theoretical concern — a live run of "milka oreo" returned nineteen records
 * and accepted FIFTEEN of them, because upstream carries the same biscuit under
 * "Milka Oreo" by Milka, by Oreo, by "Milka Oreo", and as "Milka oreo sandwich".
 * Every one of those is a real record that passes the gate, and collapse()
 * correctly refuses to merge them: they differ by brand, and §15 says an
 * uncertain match stays two rows.
 *
 * So the answer is not a cleverer dedupe — a cleverer dedupe here would be
 * exactly the confident wrong merge the spec forbids. The answer is to take
 * the best few and let the rest arrive later if anyone actually looks for them.
 * Eight is more than a dropdown shows and far less than a query's worth of
 * upstream noise.
 */
const MAX_ACCEPTED = 8

/**
 * The cap when the local catalog had nothing useful to say.
 *
 * Bigger, because this is the case where the catalog is being FILLED rather
 * than topped up, and the products beyond the eighth are not noise — they are
 * the AQUA Carpaticas and Azugas of the next query, already ranked by
 * completeness and about to be thrown away. See capFor().
 */
const MAX_ACCEPTED_COLD = 20

export function pipeline(
  products: SourceProduct[],
  query: string,
  local: LocalRow[],
  opts: {
    maxAccepted?: number
    intent?: ConceptIntent | null
    /** The resolved concept's own words, in six languages. See stripCategoryBrands. */
    categoryTerms?: string[]
  } = {},
): PipelineResult {
  const returned = products.length
  const cap = opts.maxAccepted ?? capFor(local, query, opts.intent ?? null)

  // FIRST, because a junk brand walks irrelevant products through the gate
  // below rather than merely looking wrong underneath a relevant one.
  const cleaned = stripCategoryBrands(products, opts.categoryTerms ?? [])

  // Then the rows that are only the concept's word. AFTER the brand clean, on
  // purpose: a product whose brand was the category ("Chorizo doux" by
  // "Chorizo") loses that brand above and becomes eligible here, which is
  // correct -- with the junk removed it really does carry nothing.
  const substantive = withoutBareConcepts(cleaned, opts.categoryTerms ?? [])
  const bare = cleaned.length - substantive.length

  const relevant = relevantTo(substantive, query)
  const irrelevant = returned - relevant.length

  const { accepted: passed, rejected, reasons } = gate(relevant, 'commercial')

  const collapsed = collapse(passed)
  const merged = passed.length - collapsed.length

  const fresh = withoutKnown(collapsed, local)
  const alreadyKnown = collapsed.length - fresh.length

  // Best first, then capped. Ordering matters as much as the cap does: taking
  // the first eight of the source's own ranking would keep whichever records it
  // felt like returning, and the whole point is to keep the ones that say the
  // most about the product.
  const best = [...fresh].sort((a, b) => completeness(b) - completeness(a))
  const kept = best.slice(0, cap)

  return {
    rows: toImportRows(kept),
    stats: {
      returned,
      irrelevant,
      // Counted rather than folded into `irrelevant`: these DID match the
      // query, which is precisely the problem with them.
      bare,
      rejected,
      alreadyKnown,
      collapsed: merged,
      accepted: kept.length,
      // What the cap turned away. Counted rather than dropped silently: a
      // number that is regularly large means either the cap is too tight or a
      // query is matching far too broadly, and neither is visible without it.
      overflow: fresh.length - kept.length,
      reasons,
    },
  }
}
