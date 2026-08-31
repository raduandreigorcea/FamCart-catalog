import { OpenFactsAdapter } from './openFacts.ts'
import { OPEN_FOOD_FACTS } from './openFoodFacts.ts'
import { OPEN_PRODUCTS_FACTS } from './openProductsFacts.ts'
import { OPEN_BEAUTY_FACTS } from './openBeautyFacts.ts'
import type { AdapterOptions } from './types.ts'

export { OpenFactsAdapter, usableBrand } from './openFacts.ts'
export { OpenFoodFactsAdapter, OPEN_FOOD_FACTS } from './openFoodFacts.ts'
export { OpenProductsFactsAdapter, OPEN_PRODUCTS_FACTS } from './openProductsFacts.ts'
export { OpenBeautyFactsAdapter, OPEN_BEAUTY_FACTS } from './openBeautyFacts.ts'

/**
 * Every source this catalog is allowed to ask, built once.
 *
 * ORDER IS MEANINGFUL, and only in one place: a barcode is an exact key that
 * can match in more than one database (a product mis-filed as food and as
 * cosmetics), so the first non-null answer wins and food is tried first because
 * it is by far the largest and best curated of the three. For free-text search
 * the order means nothing — the results are unioned and the pipeline ranks
 * them by completeness.
 *
 * SEPARATE INSTANCES, NOT ONE SHARED ONE, and that is the point of building
 * them here rather than reaching for a singleton. Each carries its own circuit
 * breaker, so Open Beauty Facts being down fails fast for beauty queries while
 * the other two keep answering. A shared breaker would let one sick database
 * silence all three.
 *
 * Typed as the concrete class rather than `ProductSourceAdapter[]` because the
 * caller needs `circuitOpen` and `lastRequestFailed` to decide what may be
 * cached, and neither belongs on the interface: they are facts about this
 * family's transport, not about being a source.
 */
export function createAdapters(options: AdapterOptions = {}): OpenFactsAdapter[] {
  return [
    new OpenFactsAdapter(OPEN_FOOD_FACTS, options),
    new OpenFactsAdapter(OPEN_PRODUCTS_FACTS, options),
    new OpenFactsAdapter(OPEN_BEAUTY_FACTS, options),
  ]
}
