import { foldName, foldQuery, matchesAllTokens } from './normalize.ts'
import { gate, tierOf } from './quality.ts'
import type { SourceProduct } from './sources/types.ts'

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
 * Is the local catalog's answer good enough to skip the external call?
 *
 * THE MOST IMPORTANT FUNCTION HERE, because it is the one that decides how
 * often anything external happens at all. Get it too eager and every keystroke
 * that survives the debounce becomes an outbound request; get it too reluctant
 * and the catalog never grows.
 *
 * The rule is deliberately about MATCH QUALITY rather than count. Ten rows that
 * all reached the query through a category alias are not an answer to "pepsi
 * zero" — they are the shelf it might be on. One row whose name contains every
 * word typed is a better answer than twenty that do not, so:
 *
 *   sufficient  =  at least one local row contains every token of the query
 *                  OR the query is too short to be worth asking about
 *
 * `minQueryLength` is 3 by §6: below that an external search returns noise
 * proportional to how common the letters are, and the local prefix match is
 * already the better answer.
 */
export function isLocalSufficient(
  rows: LocalRow[],
  query: string,
  opts: { minQueryLength?: number } = {},
): boolean {
  const folded = foldQuery(query)
  if (folded.length < (opts.minQueryLength ?? 3)) return true
  if (!rows.length) return false

  return rows.some((r) => matchesAllTokens(`${r.name} ${r.maker ?? ''}`, query))
}

/**
 * Drop results that do not actually answer the question.
 *
 * An external full-text search ranks by its own relevance and will happily
 * return its best guesses rather than nothing — search-a-licious answers
 * "lapte" with "Chocolat au lait" because the words share a stem in its index.
 * Storing those would fill the catalog with products that are correct data and
 * wrong answers, and they would then be returned locally forever after.
 *
 * The test is the same one the database's search makes: does the product's own
 * text contain every word that was typed? Nothing about ranking, nothing about
 * closeness. A result that cannot pass it was never a match for this query,
 * whatever the source thought.
 */
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

export function pipeline(
  products: SourceProduct[],
  query: string,
  local: LocalRow[],
  opts: { maxAccepted?: number } = {},
): PipelineResult {
  const returned = products.length
  const cap = opts.maxAccepted ?? MAX_ACCEPTED

  const relevant = relevantTo(products, query)
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
