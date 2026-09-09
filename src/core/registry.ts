// Every retailer the catalog knows about, including the one it cannot read.
//
// ADDING A RETAILER MEANS ADDING A LINE HERE and a directory under
// src/retailers/. Nothing else in the pipeline needs to change, which is the
// property the whole abstraction exists to have.
//
// THE UNIMPLEMENTED ONE IS LISTED ON PURPOSE. A retailer that was analysed and
// found unreadable is a fact worth keeping next to the ones that work -- deleting
// the entry would mean the next person re-does the analysis and reaches the same
// conclusion. `npm run scrape:all` names it and moves on rather than skipping it
// silently. It has no row in catalog_retailers, because a row there is a claim
// that data can arrive.
//
// AND IT IS DATED, because the entry below this one was not. Mega Image sat here
// as unreadable for a month after it stopped being unreadable, on the strength of
// a note that read like a permanent fact.

import type { RetailerScraper, Market } from './types.ts'
import { auchan } from '../retailers/auchan/index.ts'
import { carrefour } from '../retailers/carrefour/index.ts'
import { lidl } from '../retailers/lidl/index.ts'
import { megaImage } from '../retailers/mega-image/index.ts'

/** A retailer that has been looked at and cannot currently be read. */
class UnimplementedScraper implements RetailerScraper {
  readonly implemented = false
  readonly retailer: string
  readonly country: Market
  readonly domain: string
  readonly note: string

  // Written out rather than declared as constructor parameters: `node
  // --experimental-strip-types` removes types without rewriting anything, and a
  // parameter property is a type annotation that has to GENERATE an assignment.
  // tsconfig's erasableSyntaxOnly refuses it here so it cannot reach a scheduled
  // run and crash there instead.
  constructor(retailer: string, country: Market, domain: string, note: string) {
    this.retailer = retailer
    this.country = country
    this.domain = domain
    this.note = note
  }

  // eslint-disable-next-line require-yield
  async *discoverProducts(): AsyncGenerator<never> {
    throw new Error(`${this.retailer} has no scraper: ${this.note}`)
  }
}

export const kaufland = new UnimplementedScraper(
  'kaufland',
  'RO',
  'kaufland.ro',
  'kaufland.ro has no online assortment (checked 2026-09-09): its sitemap is 3,472 URLs and ' +
    'holds 2,283 recipes, 502 pages of an ingredient encyclopedia, brand and blog pages, and no ' +
    'product. It DOES publish the weekly leaflet as structured data on ' +
    '/oferte/oferte-saptamanale/saptamana-curenta.html -- 371 offers with prices, in a window.SSR ' +
    'blob -- but that is this week promotions rather than an assortment, so a shop badge from it ' +
    'would mean "on offer here until Sunday" where every other badge means "sold here".',
)

// MEGA IMAGE WAS AN UnimplementedScraper HERE, and the note it carried had gone
// stale. It said the pages weigh ~730 KB and publish no price; they weigh ~235 KB
// and the price is there, one level down in a priceSpecification. 8,879 products
// is about two and a half hours and two gigabytes a run, the same order as
// Carrefour.
//
// The entry is worth remembering for what it cost: an analysis with no date on it
// reads as a permanent fact, and this one closed the shop off for a month after
// it stopped being true. Kaufland's note above now carries the date it was
// checked, for that reason.

export const SCRAPERS: RetailerScraper[] = [auchan, carrefour, lidl, megaImage, kaufland]

export const IMPLEMENTED: RetailerScraper[] = SCRAPERS.filter((s) => s.implemented)

export function scraperFor(slug: string): RetailerScraper | null {
  return SCRAPERS.find((s) => s.retailer === slug) ?? null
}
