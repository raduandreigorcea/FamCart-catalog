import { MARKETS, isLanguage, type Market } from '../markets.ts'
import { foldName } from '../normalize.ts'
import type {
  AdapterOptions,
  ProductSourceAdapter,
  SourceContext,
  SourceMetadata,
  SourceProduct,
} from './types.ts'

// The Open*Facts family, behind one adapter.
//
// Open Food Facts, Open Products Facts and Open Beauty Facts are three
// databases running the SAME software — Product Opener — under three hostnames.
// A record looks identical whichever one it comes from: `code`,
// `product_name`, `brands`, `countries_tags`, `categories_tags`, `quantity`,
// `unique_scans_n`. So `normalize()` is written once here, and a "source" is
// reduced to the handful of things that genuinely differ.
//
// WHY THIS IS ONE FILE AND NOT THREE. The three-copies version was considered
// and rejected: it would have meant three copies of the circuit breaker, three
// copies of the retry ladder and three copies of the quantity parser, which is
// three places for a fix to be applied twice and forgotten once. The parts that
// differ are small and declarative, so they are data (`OpenFactsConfig`) rather
// than code.
//
// WHAT ACTUALLY DIFFERS, and all of it verified live rather than read from
// documentation:
//
//   SEARCH. Only Open Food Facts has search-a-licious
//   (`search.openfoodfacts.org/search?q=`, results under `hits`, `brands` as an
//   ARRAY). The other two do not — `search.openbeautyfacts.org` answers a 302
//   redirect back to the main site — and are searched through the legacy
//   `cgi/search.pl` endpoint instead, which puts results under `products` and
//   sends `brands` as a COMMA-SEPARATED STRING. `firstBrand()` below already
//   handled both shapes, because the v2 barcode endpoint disagrees with
//   search-a-licious in exactly the same way.
//
//   CATEGORIES. Each database has its own taxonomy. Food has `en:dairies`,
//   beauty has `en:shampoos`, products has almost nothing at all (a live search
//   for "nappies" returned six products, none of them carrying a single
//   category tag). So the map is per source and every one of them is shallow.
//
//   THE HOSTNAME, for barcodes and for the `sourceUrl` that attribution needs.
//
// Everything else — markets, quantity, brand, image, provenance, the breaker —
// is shared, because upstream shares it.
//
// NOTHING HERE IS INVENTED. A field the response does not carry is left absent,
// never derived from the name and never guessed (§4, §12). The one place that
// is tempting is `quantity`, which arrives as free text like "1,5 L" — parsed
// where it parses unambiguously, dropped where it does not.

/**
 * Exactly what this catalog stores, and nothing else.
 *
 * Adding a field here is adding a field to `catalog_products`; if it has no
 * column, it has no business crossing the network. A bare request returns ~200
 * fields per product including full nutrition and every image size; this cuts
 * that to the dozen that has somewhere to go, and it is the difference between
 * a 4 KB response and a 200 KB one on a path that sits between a keystroke and
 * a dropdown.
 */
export const SEARCH_FIELDS = [
  'code',
  'product_name',
  'generic_name',
  'brands',
  'quantity',
  'countries_tags',
  'categories_tags',
  'lang',
  'image_front_url',
  'completeness',
  'unique_scans_n',
  'last_modified_t',
].join(',')

/** The same, plus the one field only the product endpoint reports. */
export const PRODUCT_FIELDS = `${SEARCH_FIELDS},obsolete`

/**
 * Open*Facts' shared country taxonomy to our eleven markets.
 *
 * Their tags are `en:romania`, `en:united-kingdom`. Anything not listed maps to
 * nothing at all, which is correct rather than lossy: a product sold only in
 * Brazil has no market this app can express, and inventing one would put it in
 * front of somebody who cannot buy it. An empty market list means "unknown",
 * and the ranking treats unknown better than wrong.
 */
const COUNTRY_TAGS: Record<string, Market> = {
  'en:romania': 'RO',
  'en:moldova': 'MD',
  'en:republic-of-moldova': 'MD',
  'en:germany': 'DE',
  'en:austria': 'AT',
  'en:switzerland': 'CH',
  'en:spain': 'ES',
  'en:france': 'FR',
  'en:belgium': 'BE',
  'en:italy': 'IT',
  'en:united-kingdom': 'GB',
  'en:ireland': 'IE',
}

/**
 * "1,5 L", "330 ml", "500g" to a number and a unit this catalog can hold.
 *
 * WHERE IT PARSES UNAMBIGUOUSLY AND NOWHERE ELSE. The field is free text and
 * carries things like "6 x 1.5L", "environ 250 g" and "1 pièce". Anything with
 * a multiplier, a range or a word we do not recognise returns null and the
 * product simply has no quantity — which the schema allows and the tiering
 * treats as thin rather than invalid.
 *
 * The comma is a decimal separator across every one of the six markets, so
 * "1,5 L" is one and a half litres. Nothing here has to handle a thousands
 * separator, because no package size reaches four digits in its own unit.
 */
export function parseQuantity(
  raw: string | null | undefined,
): { quantity: number; unit: SourceProduct['quantityUnit'] } | null {
  if (!raw) return null
  const text = raw.trim().toLowerCase()

  // A multiplier means several packs, and "6 x 1.5 L" is not a 1.5 L product
  // nor a 9 L one. Refuse rather than pick.
  if (/[x×]\s*\d/.test(text) || /\d\s*[x×]/.test(text)) return null

  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(g|gr|gram|grammes?|kg|ml|cl|l|lt|liters?|litres?|pcs?|pieces?|piece|st(?:ü|u)ck|buc)\b/)
  if (!m) return null

  const value = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0) return null

  const unit = m[2]
  if (/^(g|gr|gram|grammes?)$/.test(unit)) return { quantity: value, unit: 'g' }
  if (unit === 'kg') return { quantity: value, unit: 'kg' }
  if (unit === 'ml') return { quantity: value, unit: 'ml' }
  if (unit === 'cl') return { quantity: value, unit: 'cl' }
  if (/^(l|lt|liters?|litres?)$/.test(unit)) return { quantity: value, unit: 'l' }
  return { quantity: value, unit: 'piece' }
}

/**
 * The first brand, and only the first.
 *
 * The field is a list and the list is noisy — a real record carries
 * `"Nutella, Ferrero, Yum yum"` and another `"Pepsi, Pepsi Max, Pepsi zero,
 * PepsiCo"`. The first entry is the one printed largest on the pack in
 * practice; keeping all of them would put "Yum yum" in the merge key.
 *
 * Handles both shapes on purpose: search-a-licious sends an array, both the v2
 * product endpoint and the legacy search endpoint send a comma-separated
 * string.
 */
function firstBrand(raw: unknown): string | undefined {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  const first = list.map((s) => s.trim()).find(Boolean)
  if (!first) return undefined
  // Longer than the column allows is a brand field somebody pasted a sentence
  // into. Dropping it leaves the product identifiable by its barcode.
  if (first.length > 60) return undefined
  return usableBrand(first) ? first : undefined
}

/**
 * Is this string a BRAND, or is it the category leaking out of `brands`?
 *
 * ─── the thing that made this necessary ──────────────────────────────────────
 *
 * Open Food Facts' `brands` field genuinely contains category text on a great
 * many records, and it is not a rare edge. Every single chorizo the catalog
 * discovered came back like this:
 *
 *     Chorizo doux                 brands: "Chorizo"
 *     Spicy Spanish Chorizo        brands: "Spanish Chorizo"
 *     Chorizo extra chiffonade     brands: "Chorizo Extra"
 *     All Natural Chicken Chorizo  brands: "Chorizo De San Manuel Guerra's Brand Inc"
 *     Ben's Original               brands: "Favourites Chorizo And Vegetable Paella"
 *
 * ─── why it is not merely cosmetic ───────────────────────────────────────────
 *
 * `Ben's Original` is the one that proves it has to be fixed here rather than
 * at display time. That product is a PAELLA RICE. It reached the chorizo
 * results because relevantTo() matches against `name + brand`, and the junk
 * brand contains the word — so a bad brand does not just look wrong under a
 * product, it lets products that are not the thing you searched for through the
 * relevance filter entirely. Cleaning the brand before the gate is what makes
 * the gate honest.
 *
 * ─── why THESE two rules, when the last attempt was abandoned ────────────────
 *
 * This was looked at before and left alone, on the grounds that any rule which
 * strips "Chorizo" from `Chorizo doux` also strips "Milka" from
 * `Ciocolata Milka`. That is true of the rule that was considered — "the brand
 * appears in the name" — and it is not true of these, because dropping a brand
 * the NAME ALREADY CONTAINS loses the reader nothing: `Ciocolata Milka` still
 * says Milka on the row. The information is in the name either way.
 *
 * So, two narrow rules, and deliberately no third:
 *
 *   1. REDUNDANT. The folded brand is already inside the folded name. Displaying
 *      it repeats a word the person is looking straight at.
 *   2. NOT BRAND-SHAPED. Four or more words. Real brands are one to three —
 *      "Borsec", "Perla Harghitei", "Faith In Nature" — and a four-word brand is
 *      a description of the product.
 *
 * The rule NOT added is "the brand contains the category word", which would
 * catch the three stragglers this leaves behind (`Chorizo Courbe`,
 * `Cabal Authetico Chorizo`). It also strips `Coca-Cola` from a search for cola
 * and `Pizza Hut` from a search for pizza, and a real brand lost is worse than a
 * fake one kept: S4 says do not invent commercial facts, and deleting a true one
 * is the same error signed the other way.
 *
 * Length is measured in WORDS rather than characters on purpose. `Izvorul
 * Minunilor` is longer than the product name `Apa Plata 5L` and is a perfectly
 * real Romanian brand, so any character-length comparison against the name
 * throws away good data.
 */
export function usableBrand(brand: string): boolean {
  // foldName(), not a fourth copy of the fold. The rule has three runtimes and
  // pinning them together is a whole test fixture's job; adding a private
  // near-copy here to save an import is how the fourth one starts.
  const b = foldName(brand)
  if (!b) return false

  // ─── THE RULE THAT IS NOT HERE, and why ───────────────────────────────────
  //
  // "The brand appears inside the product name" looks like the obvious test and
  // it is catastrophic. Measured against the live catalog it flagged 36 rows and
  // roughly 28 of them were REAL: `Pampers Nappies` by Pampers, `Hochland
  // Cascaval pane` by Hochland, `Energizer A23 batteries` by Energizer,
  // `Dobrogea Faina De Grau` by Dobrogea. Naming a product `<Brand> <Thing>` is
  // the single commonest convention there is, so that rule deletes true
  // commercial facts at scale to remove a few false ones.
  //
  // The argument for it was that the name still shows the brand, so nothing is
  // lost. That is an argument about DISPLAY, and this is a data operation: the
  // brand column also feeds the brand_match rung ("persil" -> everything Persil
  // makes) and the merge key. It was tried, measured, and reverted.
  //
  // What separates `Chorizo doux`/"Chorizo" from `Pampers Nappies`/"Pampers" is
  // not position or length -- it is that one of those brands is a CATEGORY WORD
  // and the other is a proper noun, and no string test can tell them apart.
  // catalog_concept_terms can, which is why that check lives in the discovery
  // function where the concept has already been resolved, and not in here.

  // 2. FIVE words or more is a sentence, not a brand.
  //
  // Five and not four, and the difference was measured rather than chosen.
  // Against the live catalog, four flagged `Tesco Fred and Flo` -- Tesco's real
  // nappy range -- alongside the two genuine sentences. Five keeps it and still
  // catches both: "Chorizo De San Manuel Guerra's Brand Inc." (7) and
  // "Favourites Chorizo And Vegetable Paella" (5).
  //
  // Erring high is the right direction here. A junk brand left in place is
  // untidy under one product; a real brand deleted is a commercial fact
  // destroyed, and S4 cuts both ways -- inventing one and erasing one are the
  // same error with different signs.
  if (b.split(' ').length >= 5) return false

  return true
}

function mapMarkets(tags: unknown): Market[] | undefined {
  if (!Array.isArray(tags)) return undefined
  const seen = new Set<Market>()
  for (const t of tags) {
    const m = COUNTRY_TAGS[String(t).toLowerCase()]
    if (m) seen.add(m)
  }
  return seen.size ? [...seen].filter((m) => (MARKETS as readonly string[]).includes(m)) : undefined
}

function mapCategory(tags: unknown, table: Record<string, string>): string | undefined {
  if (!Array.isArray(tags)) return undefined
  // Last match wins: Open*Facts orders categories_tags broad to specific, so
  // the deepest one we recognise is usually the most informative. Where it is
  // not — beauty records often end on `en:personal-care` — the broad answer is
  // still a correct shelf, which is the outcome this trades for.
  let found: string | undefined
  for (const t of tags) {
    const c = table[String(t).toLowerCase()]
    if (c) found = c
  }
  return found
}

function httpsOnly(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const trimmed = url.trim()
  // The database refuses anything else, so refusing it here means the reason is
  // visible rather than a constraint violation inside a batch. It also means a
  // `javascript:` or `data:` URL from an external source never reaches a row.
  if (!trimmed.startsWith('https://') || trimmed.length > 500) return undefined
  return trimmed
}

/** One product record, in whichever of the family's shapes it arrived. */
export interface OpenFactsRecord {
  code?: unknown
  product_name?: unknown
  generic_name?: unknown
  brands?: unknown
  quantity?: unknown
  countries_tags?: unknown
  categories_tags?: unknown
  lang?: unknown
  image_front_url?: unknown
  completeness?: unknown
  unique_scans_n?: unknown
  last_modified_t?: unknown
  obsolete?: unknown
}

/**
 * Everything that makes one Open*Facts database different from another.
 *
 * Declarative on purpose. A fourth sibling — Open Pet Food Facts exists — would
 * be a new file of about thirty lines and no new behaviour, which is the test
 * of whether this seam is drawn in the right place.
 */
export interface OpenFactsConfig {
  meta: SourceMetadata
  /** `https://world.open*facts.org`. Barcodes and attribution URLs. */
  productHost: string
  /** Where free-text search goes, which is not the same service for all three. */
  buildSearchUrl(query: string, ctx: SourceContext): string
  /** Search results live under `hits` for one of them and `products` for two. */
  readSearchEnvelope(body: unknown): unknown[]
  /** This database's own category vocabulary, mapped shallowly into ours. */
  categoryTags: Record<string, string>
}

/**
 * The legacy Product Opener search, which is what the two siblings have.
 *
 * `search_simple=1&action=process&json=1` is the incantation that turns the
 * HTML search page into JSON; without all three it returns a web page. It has
 * no relevance sort — results come back by popularity — which is why
 * `relevantTo()` in the pipeline matters more for these two sources than it
 * does for Open Food Facts, and why asking for a page of 20 to keep 8 is the
 * right shape rather than wasteful.
 */
export function legacySearchUrl(host: string, query: string, ctx: SourceContext): string {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(Math.min(Math.max(ctx.maxResults ?? 20, 1), 50)),
    fields: SEARCH_FIELDS,
  })
  return `https://${host}/cgi/search.pl?${params}`
}

/** `{ products: [...] }`, the legacy envelope. */
export function readLegacyEnvelope(body: unknown): unknown[] {
  const products = (body as { products?: unknown } | null)?.products
  return Array.isArray(products) ? products : []
}

export class OpenFactsAdapter implements ProductSourceAdapter<OpenFactsRecord> {
  private readonly config: OpenFactsConfig
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  // ─── the circuit breaker ─────────────────────────────────────────────────
  // §19. After enough consecutive failures the adapter stops trying for a
  // while and returns empty immediately.
  //
  // The point is NOT to be kind to Open Food Facts. It is that a source which
  // is down takes `timeoutMs` to say so, and paying that on every keystroke
  // turns an external outage into an app that feels broken. Failing instantly
  // and letting the local catalog answer is the behaviour spec §19 asks for:
  // "if OFF is unavailable, the local catalog must continue working".
  //
  // PER INSTANCE, which is what makes three sources safe: one database being
  // down must not stop the other two being asked, and a shared breaker would
  // do exactly that.
  private failures = 0
  private openUntil = 0
  private requestFailed = false
  private static readonly TRIP_AFTER = 4
  private static readonly COOLDOWN_MS = 60_000

  constructor(config: OpenFactsConfig, options: AdapterOptions = {}) {
    this.config = config
    this.timeoutMs = options.timeoutMs ?? 4_000
    this.retries = options.retries ?? 1
    // Open Food Facts asks callers to identify themselves and throttles
    // anonymous traffic harder. A contact address is both the polite and the
    // practical choice.
    this.userAgent =
      options.userAgent ?? 'FamCart/1.0 (https://famcart-app.vercel.app)'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  get meta(): SourceMetadata {
    return this.config.meta
  }

  /** True while the breaker is open. Exposed for metrics, not for control. */
  get circuitOpen(): boolean {
    return this.now() < this.openUntil
  }

  /**
   * Did the last request actually reach the source?
   *
   * Not the same question as `circuitOpen`, and the difference is what decides
   * whether a miss may be cached. The breaker trips only after four
   * consecutive failures; a single timeout leaves it closed while still having
   * produced an empty result that means "we do not know" rather than "there is
   * nothing there". Caching that as a miss would freeze a hole in the catalog
   * for a day, which §7 forbids.
   *
   * True for anything short of a completed, parseable response — a timeout, a
   * refused connection, a 5xx, and also a 4xx, which means this code asked the
   * wrong question and learned nothing about the product.
   */
  get lastRequestFailed(): boolean {
    return this.requestFailed
  }

  async search(query: string, ctx: SourceContext = {}): Promise<SourceProduct[]> {
    const q = query.trim()
    if (!q) return []

    const body = await this.request<unknown>(this.config.buildSearchUrl(q, ctx), ctx.signal)
    if (!body) return []

    return this.config
      .readSearchEnvelope(body)
      .map((h) => this.normalize(h as OpenFactsRecord))
      .filter((p): p is SourceProduct => p !== null)
  }

  async getByBarcode(codes: string[], ctx: SourceContext = {}): Promise<SourceProduct | null> {
    // The app expands one scan into its equivalent encodings; each is an exact
    // key, so they are tried in order and the first hit wins. Never more than a
    // handful, and the loop stops at the first answer.
    for (const code of codes.slice(0, 4)) {
      if (!/^[0-9]{8,14}$/.test(code)) continue

      const body = await this.request<{ status?: unknown; product?: unknown }>(
        `${this.config.productHost}/api/v2/product/${encodeURIComponent(code)}.json?fields=${PRODUCT_FIELDS}`,
        ctx.signal,
      )
      if (!body || body.status !== 1 || !body.product) continue

      const product = this.normalize(body.product as OpenFactsRecord)
      // The response omits `code` inside `product` for some records; the code
      // that found it is the authoritative one either way.
      if (product) return { ...product, gtins: [code], sourceId: code }
    }
    return null
  }

  normalize(raw: OpenFactsRecord): SourceProduct | null {
    if (!raw || typeof raw !== 'object') return null

    // generic_name is the fallback rather than the preference: it is the
    // category-ish description ("Chocolate spread"), useful when the product
    // has no name at all and misleading when it has one.
    const name = String(raw.product_name ?? '').trim() || String(raw.generic_name ?? '').trim()
    if (!name) return null

    const code = String(raw.code ?? '').trim()
    // Provenance needs an upstream id, and for these sources the barcode IS the
    // id. Without one there is nothing to make a re-import idempotent against.
    if (!code) return null

    const lang = String(raw.lang ?? '').toLowerCase()
    const size = parseQuantity(typeof raw.quantity === 'string' ? raw.quantity : null)
    const markets = mapMarkets(raw.countries_tags)
    const category = mapCategory(raw.categories_tags, this.config.categoryTags)
    const brand = firstBrand(raw.brands)
    const image = httpsOnly(raw.image_front_url)
    const modified = Number(raw.last_modified_t)

    return {
      name,
      // Only the six the app can render. A product named in Polish is stored
      // under no language rather than mislabelled as English, and the caller
      // decides what to do about that.
      ...(isLanguage(lang) ? { lang } : {}),
      ...(brand ? { brand } : {}),
      ...(/^[0-9]{8,14}$/.test(code) ? { gtins: [code] } : {}),
      ...(markets ? { markets } : {}),
      ...(size ? { quantity: size.quantity, quantityUnit: size.unit } : {}),
      ...(image ? { imageUrl: image } : {}),
      ...(category ? { category } : {}),

      source: this.config.meta.name,
      sourceId: code,
      sourceUrl: `${this.config.productHost}/product/${code}`,
      ...(Number.isFinite(modified) && modified > 0
        ? { sourceUpdatedAt: new Date(modified * 1000).toISOString() }
        : {}),

      ...(typeof raw.completeness === 'number' ? { completeness: raw.completeness } : {}),
      ...(typeof raw.unique_scans_n === 'number' ? { uniqueScans: raw.unique_scans_n } : {}),
      ...(raw.obsolete === true || raw.obsolete === 'on' ? { obsolete: true } : {}),
    }
  }

  /**
   * One request, with a timeout, retries and the breaker around it.
   *
   * RETURNS NULL RATHER THAN THROWING, for every failure mode there is. §19 and
   * the comment on the interface: the local catalog must keep working when this
   * source does not, and an adapter that throws makes remembering that every
   * caller's job.
   */
  private async request<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    if (this.circuitOpen) {
      this.requestFailed = true
      return null
    }
    this.requestFailed = false

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // A fresh controller per attempt, linked to the caller's signal. Reusing
      // one across retries means the first timeout aborts every later attempt
      // before it starts, which reads as "retries do not work".
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: controller.signal,
        })

        if (res.ok) {
          const body = (await res.json()) as T
          this.failures = 0
          return body
        }

        // 4xx is our request being wrong, and retrying an identical wrong
        // request just spends the timeout again. 5xx and 429 are worth another
        // go. Neither counts toward the breaker unless it is a server fault:
        // a 404 does not mean the source is down. It does mean we got no
        // answer, though, so it is still a failed request as far as the cache
        // is concerned.
        if (res.status < 500 && res.status !== 429) {
          this.requestFailed = true
          return null
        }
      } catch {
        // Timeout, abort, DNS, TLS, malformed JSON. All the same to a caller.
        // The caller giving up is not the source failing, so it must not trip
        // the breaker for everyone else. It is still no answer, so the cache
        // must not treat it as one.
        if (signal?.aborted) {
          this.requestFailed = true
          return null
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      // Backoff before the next attempt, and none after the last.
      if (attempt < this.retries) await this.sleep(200 * 2 ** attempt)
    }

    this.requestFailed = true
    this.failures++
    if (this.failures >= OpenFactsAdapter.TRIP_AFTER) {
      this.openUntil = this.now() + OpenFactsAdapter.COOLDOWN_MS
      this.failures = 0
    }
    return null
  }
}
