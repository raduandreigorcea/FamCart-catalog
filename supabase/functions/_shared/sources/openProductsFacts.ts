import {
  OpenFactsAdapter,
  legacySearchUrl,
  readLegacyEnvelope,
  type OpenFactsConfig,
} from './openFacts.ts'
import type { AdapterOptions, SourceContext } from './types.ts'

// Open Products Facts. Everything that is not food and not cosmetics —
// cleaning products, batteries, nappies, pet supplies, kitchenware.
//
// WHY THIS SOURCE EXISTS IN THE CATALOG AT ALL. It is the half of a shopping
// list that Open Food Facts cannot answer. Measured live, against a page of 20
// and after the pipeline's own relevance filter: batteries 6, nappies 6, cat
// litter 16, dish soap 9, detergent 9 usable products — every one of which was
// zero before this file.
//
// NO SEARCH-A-LICIOUS. `search.openproductsfacts.org` answers a 302 back to the
// main site; only Open Food Facts has that service. So this goes through the
// legacy `cgi/search.pl`, which works and is fast (~0.3s) but has NO RELEVANCE
// SORT — it returns by popularity, so a query matches things whose names do not
// contain it. That is not a problem to fix here: `relevantTo()` in the pipeline
// already drops them, and it is why a page of 20 is fetched to keep 8.
//
// THE CATEGORY MAP IS NEARLY EMPTY ON PURPOSE. A live search for "nappies"
// returned six products and not one of them carried a single `categories_tags`
// entry. This database is thinly categorised, so the few tags below are what
// there is; the rest of the products arrive with no category, which costs them
// the category-alias reach and nothing else.

const PRODUCT_HOST = 'https://world.openproductsfacts.org'
const SEARCH_HOST = 'world.openproductsfacts.org'

const CATEGORY_TAGS: Record<string, string> = {
  'en:cleaning-products': 'household',
  'en:laundry-products': 'household',
  'en:laundry-detergents': 'household',
  'en:dishwashing-products': 'household',
  'en:household-products': 'household',
  'en:paper-products': 'household',
  'en:toilet-papers': 'household',
  'en:batteries': 'home',
  'en:light-bulbs': 'home',
  'en:kitchenware': 'home',
  'en:tableware': 'home',
  'en:stationery': 'home',
  'en:textiles': 'home',
  'en:toys': 'home',
  'en:baby-products': 'baby',
  'en:diapers': 'baby',
  'en:nappies': 'baby',
  'en:pet-food': 'pet',
  'en:pet-products': 'pet',
  'en:cat-litters': 'pet',
  'en:medicines': 'health',
  'en:food-supplements': 'health',
}

export const OPEN_PRODUCTS_FACTS: OpenFactsConfig = {
  meta: {
    name: 'openproductsfacts',
    label: 'Open Products Facts',
    licence: 'ODbL 1.0',
    homepage: PRODUCT_HOST,
  },
  productHost: PRODUCT_HOST,
  buildSearchUrl: (query: string, ctx: SourceContext) =>
    legacySearchUrl(SEARCH_HOST, query, ctx),
  readSearchEnvelope: readLegacyEnvelope,
  categoryTags: CATEGORY_TAGS,
}

export class OpenProductsFactsAdapter extends OpenFactsAdapter {
  constructor(options: AdapterOptions = {}) {
    super(OPEN_PRODUCTS_FACTS, options)
  }
}
