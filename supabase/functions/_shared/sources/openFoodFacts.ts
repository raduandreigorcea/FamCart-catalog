import {
  OpenFactsAdapter,
  SEARCH_FIELDS,
  type OpenFactsConfig,
} from './openFacts.ts'
import type { AdapterOptions, SourceContext } from './types.ts'

// Open Food Facts. The first source, and the only one of the three with a
// modern search service.
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
// THEIR JSON DISAGREES, and that disagreement is most of why the shared
// adapter exists. The same product comes back as `{"brands": ["Pepsi"]}` from
// one and `{"brands": "Pepsi, Pepsi Max, PepsiCo"}` from the other; one wraps
// results in `hits`, the other in `product`. Verified against both live before
// this was written, rather than assumed from documentation.

const SEARCH_HOST = 'https://search.openfoodfacts.org'
const PRODUCT_HOST = 'https://world.openfoodfacts.org'

/**
 * Open Food Facts' category taxonomy to ours, at the top level only.
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

export const OPEN_FOOD_FACTS: OpenFactsConfig = {
  meta: {
    name: 'openfoodfacts',
    label: 'Open Food Facts',
    // ODbL is why catalog_sources exists. Attribution is a condition of use,
    // not a courtesy, and the row that records it is the mechanism.
    licence: 'ODbL 1.0',
    homepage: PRODUCT_HOST,
  },
  productHost: PRODUCT_HOST,

  buildSearchUrl(query: string, ctx: SourceContext): string {
    const params = new URLSearchParams({
      q: query,
      page_size: String(Math.min(Math.max(ctx.maxResults ?? 20, 1), 50)),
      fields: SEARCH_FIELDS,
    })
    // A HINT, NOT A FILTER. It biases which language's name field is searched
    // and ranked; it does not exclude anything, which matters because a
    // Romanian household searching "nutella" must still reach a product whose
    // record is French.
    if (ctx.language) params.set('langs', ctx.language)
    return `${SEARCH_HOST}/search?${params}`
  },

  readSearchEnvelope(body: unknown): unknown[] {
    const hits = (body as { hits?: unknown } | null)?.hits
    return Array.isArray(hits) ? hits : []
  },

  categoryTags: CATEGORY_TAGS,
}

/**
 * Kept as its own class rather than a bare `new OpenFactsAdapter(OPEN_FOOD_FACTS)`
 * because this name is what the tests and the edge function already import, and
 * a rename with no behaviour behind it is churn.
 */
export class OpenFoodFactsAdapter extends OpenFactsAdapter {
  constructor(options: AdapterOptions = {}) {
    super(OPEN_FOOD_FACTS, options)
  }
}

// The quantity parser moved to the shared module with the rest of the
// normalisation. Re-exported because it is worth testing on its own and the
// suite reaches for it here.
export { parseQuantity } from './openFacts.ts'
