import type { Language, Market } from '../markets.ts'

// The shape every external product source has to present.
//
// WHY AN INTERFACE AT ALL, when there is exactly one implementation. Because
// the thing most likely to change here is not the code, it is Open Food Facts.
// Their search moved from `cgi/search.pl` to a v2 API to a separate
// search-a-licious service, and each of those returns a different JSON shape
// for the same product — `brands` is a comma-separated string in one and a
// string array in another. An adapter is what keeps that churn from reaching
// the quality gate, the dedupe rule, or the database.
//
// The second reason is the one spec §18 gives: other sources will follow, and
// "do not add paid providers until explicitly approved" is a rule about which
// adapters exist rather than about whether the seam does.
//
// Framework-free and dependency-free — no Supabase, no Node built-ins, nothing
// but `fetch` — because this is imported by Deno inside an edge function, by
// Node from a script, and by vitest.

/**
 * A product as this catalog understands it, after an adapter has translated its
 * source's shape into ours.
 *
 * EVERY FIELD BUT `name` IS OPTIONAL, and that is the whole posture of §10:
 * incomplete is not invalid. A product with no brand, no barcode, no image, no
 * quantity and no country is still a product, and discarding it because the
 * upstream record was thin would throw away most of what is out there.
 *
 * Nothing here is invented by an adapter. A field the source did not state is
 * absent, never guessed at, never derived from the name (§4, §12).
 */
export interface SourceProduct {
  /** As published, in `lang`. Never translated by an adapter. */
  name: string
  /** The language the source says the name is in, when it says. */
  lang?: Language
  /** The first brand the source names, when it names one. */
  brand?: string
  /** GTINs, digits only. Never fabricated, never checksum-repaired. */
  gtins?: string[]
  /** Markets, mapped from the source's own country vocabulary to ours. */
  markets?: Market[]
  quantity?: number
  quantityUnit?: 'g' | 'kg' | 'ml' | 'l' | 'cl' | 'piece'
  /** https only. An adapter drops anything else rather than passing it on. */
  imageUrl?: string
  /** The source's category vocabulary, already mapped to ours where possible. */
  category?: string

  // ─── provenance, which is not optional ──────────────────────────────────
  /** Which source. Must be one the database's `catalog_sources` check allows. */
  source: SourceName
  /** This product's id upstream. What makes a re-import update, not duplicate. */
  sourceId: string
  sourceUrl?: string
  sourceUpdatedAt?: string

  // ─── evidence the quality gate reads, and nothing else does ─────────────
  /**
   * Roughly how complete the upstream record is, 0-1, when the source offers
   * such a number. A ranking and tiering signal only: a low value never rejects
   * a product on its own, because §10 forbids rejecting for missing optional
   * fields and this number is mostly a count of them.
   */
  completeness?: number
  /**
   * How many distinct people have scanned this product upstream. The single
   * best evidence that a record describes something real rather than a test
   * row somebody typed into a form.
   */
  uniqueScans?: number
  /** Upstream says this product is discontinued or otherwise unusable. */
  obsolete?: boolean
}

/** The sources `catalog_sources.source_name` will accept. Keep the two in step. */
export type SourceName =
  | 'openfoodfacts'
  | 'openproductsfacts'
  | 'openbeautyfacts'

/**
 * What the caller knows about the person searching.
 *
 * All of it is optional and all of it is a HINT. An adapter may use any of it
 * to ask a better question upstream; none of it may become a hard filter, for
 * the same reason market is a ranking signal and not a filter in the database:
 * an empty result is indistinguishable from "we have never heard of that".
 */
export interface SourceContext {
  language?: Language
  market?: Market
  maxResults?: number
  /**
   * Cancellation, which matters more here than anywhere else in this codebase.
   * An external call sits between a person typing and a dropdown filling, so
   * the caller has to be able to give up on it — and every adapter must pass
   * this through to `fetch` rather than accepting it and ignoring it.
   */
  signal?: AbortSignal
}

/** Static facts about a source, for provenance and for the admin dashboard. */
export interface SourceMetadata {
  name: SourceName
  /** Shown to people. */
  label: string
  /**
   * The data licence. A licensing fact, not a nicety: Open Food Facts is ODbL,
   * which is why `catalog_sources` exists and why rows are attributed rather
   * than absorbed.
   */
  licence: string
  homepage: string
}

/**
 * The seam. §18's `ProductSourceAdapter`.
 *
 * `normalize` is on the interface rather than hidden inside each adapter
 * because it is the part worth testing on its own: given a raw upstream record,
 * what does this catalog think it is? A test that goes through `search` needs
 * the network; a test of `normalize` needs a fixture, and a fixture is what
 * pins the adapter against a real response shape.
 */
export interface ProductSourceAdapter<Raw = unknown> {
  readonly meta: SourceMetadata

  /**
   * Free-text search. Returns [] rather than throwing when the source is
   * unreachable — §19: the local catalog must keep working when OFF is down,
   * and an adapter that throws makes that every caller's problem to remember.
   */
  search(query: string, ctx?: SourceContext): Promise<SourceProduct[]>

  /**
   * Exact lookup by one or more equivalent encodings of one scanned code.
   * Returns null on a miss and on a failure — the two are the same thing to a
   * caller, which is "no product", and neither is an error worth surfacing on
   * top of a scan.
   */
  getByBarcode(codes: string[], ctx?: SourceContext): Promise<SourceProduct | null>

  /** One raw upstream record to our shape, or null if it cannot be read at all. */
  normalize(raw: Raw): SourceProduct | null
}

/**
 * Everything an adapter is allowed to be configured with.
 *
 * `fetchImpl` is here so the tests never touch the network and never need a
 * global stub: a suite that monkey-patches `globalThis.fetch` leaks that patch
 * into every other file in the run, and the failure it causes surfaces
 * somewhere else entirely.
 */
export interface AdapterOptions {
  /** Milliseconds before a single attempt is abandoned. */
  timeoutMs?: number
  /** How many times to retry a failed attempt, with backoff between. */
  retries?: number
  /**
   * Identifies us to the source. Open Food Facts asks for this explicitly and
   * rate-limits anonymous traffic harder; sending a real contact address is
   * both the polite and the practical thing.
   */
  userAgent?: string
  fetchImpl?: typeof fetch
  /** Injectable clock, so backoff and the circuit breaker are testable. */
  now?: () => number
  /** Injectable sleep, so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>
}
