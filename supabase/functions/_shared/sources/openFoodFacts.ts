import { MARKETS, isLanguage, type Market } from '../markets.ts'
import type {
  AdapterOptions,
  ProductSourceAdapter,
  SourceContext,
  SourceMetadata,
  SourceProduct,
} from './types.ts'

// The first external source. Open Food Facts, behind the adapter seam so that
// its churn stops here.
//
// TWO ENDPOINTS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS.
//
//   search   https://search.openfoodfacts.org/search?q=...
//            The "search-a-licious" service. This is the only Open Food Facts
//            endpoint that does arbitrary full-text search — spec §8 says the
//            v2 API does not, and that is still true: v2 filters by tag, so
//            asking it for "pepsi zero" is not a thing it can be asked.
//   barcode  https://world.openfoodfacts.org/api/v2/product/<code>.json
//            The v2 product endpoint, which is exact and always has been.
//
// THEIR JSON DISAGREES, and that disagreement is most of why this file exists.
// The same product comes back as `{"brands": ["Pepsi"]}` from one and
// `{"brands": "Pepsi, Pepsi Max, PepsiCo"}` from the other; one wraps results
// in `hits`, the other in `product`. Verified against both live before this was
// written, rather than assumed from documentation.
//
// EVERY FIELD IS REQUESTED EXPLICITLY. A bare request returns ~200 fields per
// product including full nutrition, ingredient lists and every image size;
// `fields=` cuts that to the dozen this catalog stores. §8 asks for it, and it
// is the difference between a 4 KB response and a 200 KB one on a path that
// sits between a keystroke and a dropdown.
//
// NOTHING HERE IS INVENTED. A field the response does not carry is left absent,
// never derived from the name and never guessed (§4, §12). The one place that
// is tempting is `quantity`, which arrives as free text like "1,5 L" — parsed
// where it parses unambiguously, dropped where it does not.

const SEARCH_HOST = 'https://search.openfoodfacts.org'
const PRODUCT_HOST = 'https://world.openfoodfacts.org'

/**
 * Exactly what this catalog stores, and nothing else.
 *
 * Adding a field here is adding a field to `catalog_products`; if it has no
 * column, it has no business crossing the network.
 */
const SEARCH_FIELDS = [
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

const PRODUCT_FIELDS = [
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
  'obsolete',
].join(',')

/**
 * Open Food Facts' country taxonomy to our eleven markets.
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
 * Their category taxonomy to ours, at the top level only.
 *
 * DELIBERATELY SHALLOW. Open Food Facts has thousands of categories in a deep
 * tree, and mapping more of it would be inventing a classification rather than
 * reading one. A product whose categories we cannot place gets no category,
 * which costs it the category-alias reach and nothing else — better than a
 * confident wrong shelf.
 */
const CATEGORY_TAGS: Record<string, string> = {
  'en:dairies': 'dairy',
  'en:milks': 'dairy',
  'en:cheeses': 'dairy',
  'en:yogurts': 'dairy',
  'en:eggs': 'dairy',
  'en:beverages': 'drinks',
  'en:waters': 'drinks',
  'en:sodas': 'drinks',
  'en:juices': 'drinks',
  'en:coffees': 'pantry',
  'en:teas': 'pantry',
  'en:alcoholic-beverages': 'alcohol',
  'en:beers': 'alcohol',
  'en:wines': 'alcohol',
  'en:snacks': 'snacks',
  'en:sweet-snacks': 'snacks',
  'en:salty-snacks': 'snacks',
  'en:chips-and-fries': 'snacks',
  'en:chocolates': 'snacks',
  'en:biscuits': 'snacks',
  'en:breads': 'bakery',
  'en:breakfasts': 'pantry',
  'en:cereals-and-potatoes': 'pantry',
  'en:pastas': 'pantry',
  'en:rice': 'pantry',
  'en:groceries': 'pantry',
  'en:condiments': 'pantry',
  'en:sauces': 'pantry',
  'en:meats': 'meat',
  'en:poultry': 'meat',
  'en:hams': 'meat',
  'en:sausages': 'meat',
  'en:seafood': 'fish',
  'en:fishes': 'fish',
  'en:fruits': 'produce',
  'en:vegetables': 'produce',
  'en:fresh-foods': 'produce',
  'en:frozen-foods': 'frozen',
  'en:ice-creams': 'frozen',
  'en:baby-foods': 'baby',
  'en:baby-milks': 'baby',
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
 * Handles both shapes on purpose: search-a-licious sends an array, the v2
 * product endpoint sends a comma-separated string.
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
  return first.length <= 60 ? first : undefined
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

function mapCategory(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined
  // Last match wins: Open Food Facts orders categories_tags broad to specific,
  // so the deepest one we recognise is the most informative.
  let found: string | undefined
  for (const t of tags) {
    const c = CATEGORY_TAGS[String(t).toLowerCase()]
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

interface OffRecord {
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

export class OpenFoodFactsAdapter implements ProductSourceAdapter<OffRecord> {
  readonly meta: SourceMetadata = {
    name: 'openfoodfacts',
    label: 'Open Food Facts',
    // ODbL is why catalog_sources exists. Attribution is a condition of use,
    // not a courtesy, and the row that records it is the mechanism.
    licence: 'ODbL 1.0',
    homepage: 'https://world.openfoodfacts.org',
  }

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
  private failures = 0
  private openUntil = 0
  private static readonly TRIP_AFTER = 4
  private static readonly COOLDOWN_MS = 60_000

  constructor(options: AdapterOptions = {}) {
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

  /** True while the breaker is open. Exposed for metrics, not for control. */
  get circuitOpen(): boolean {
    return this.now() < this.openUntil
  }

  async search(query: string, ctx: SourceContext = {}): Promise<SourceProduct[]> {
    const q = query.trim()
    if (!q) return []

    const params = new URLSearchParams({
      q,
      page_size: String(Math.min(Math.max(ctx.maxResults ?? 20, 1), 50)),
      fields: SEARCH_FIELDS,
    })
    // A HINT, NOT A FILTER. It biases which language's name field is searched
    // and ranked; it does not exclude anything, which matters because a
    // Romanian household searching "nutella" must still reach a product whose
    // record is French.
    if (ctx.language) params.set('langs', ctx.language)

    const body = await this.request<{ hits?: unknown }>(
      `${SEARCH_HOST}/search?${params}`,
      ctx.signal,
    )
    if (!body || !Array.isArray(body.hits)) return []

    return body.hits
      .map((h) => this.normalize(h as OffRecord))
      .filter((p): p is SourceProduct => p !== null)
  }

  async getByBarcode(codes: string[], ctx: SourceContext = {}): Promise<SourceProduct | null> {
    // The app expands one scan into its equivalent encodings; each is an exact
    // key, so they are tried in order and the first hit wins. Never more than a
    // handful, and the loop stops at the first answer.
    for (const code of codes.slice(0, 4)) {
      if (!/^[0-9]{8,14}$/.test(code)) continue

      const body = await this.request<{ status?: unknown; product?: unknown }>(
        `${PRODUCT_HOST}/api/v2/product/${encodeURIComponent(code)}.json?fields=${PRODUCT_FIELDS}`,
        ctx.signal,
      )
      if (!body || body.status !== 1 || !body.product) continue

      const product = this.normalize(body.product as OffRecord)
      // The response omits `code` inside `product` for some records; the code
      // that found it is the authoritative one either way.
      if (product) return { ...product, gtins: [code], sourceId: code }
    }
    return null
  }

  normalize(raw: OffRecord): SourceProduct | null {
    if (!raw || typeof raw !== 'object') return null

    // generic_name is the fallback rather than the preference: it is the
    // category-ish description ("Chocolate spread"), useful when the product
    // has no name at all and misleading when it has one.
    const name = String(raw.product_name ?? '').trim() || String(raw.generic_name ?? '').trim()
    if (!name) return null

    const code = String(raw.code ?? '').trim()
    // Provenance needs an upstream id, and for this source the barcode IS the
    // id. Without one there is nothing to make a re-import idempotent against.
    if (!code) return null

    const lang = String(raw.lang ?? '').toLowerCase()
    const size = parseQuantity(typeof raw.quantity === 'string' ? raw.quantity : null)
    const markets = mapMarkets(raw.countries_tags)
    const category = mapCategory(raw.categories_tags)
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

      source: 'openfoodfacts',
      sourceId: code,
      sourceUrl: `${PRODUCT_HOST}/product/${code}`,
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
   * caller's job. There is exactly one caller today and it would remember;
   * there will be more.
   */
  private async request<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    if (this.circuitOpen) return null

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
        // a 404 does not mean the source is down.
        if (res.status < 500 && res.status !== 429) return null
      } catch {
        // Timeout, abort, DNS, TLS, malformed JSON. All the same to a caller.
        // The caller giving up is not the source failing, so it must not trip
        // the breaker for everyone else.
        if (signal?.aborted) return null
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      // Backoff before the next attempt, and none after the last.
      if (attempt < this.retries) await this.sleep(200 * 2 ** attempt)
    }

    this.failures++
    if (this.failures >= OpenFoodFactsAdapter.TRIP_AFTER) {
      this.openUntil = this.now() + OpenFoodFactsAdapter.COOLDOWN_MS
      this.failures = 0
    }
    return null
  }
}
