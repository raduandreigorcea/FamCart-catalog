// Every retailer the catalog knows about, including the two it cannot read.
//
// ADDING A RETAILER MEANS ADDING A LINE HERE and a directory under
// src/retailers/. Nothing else in the pipeline needs to change, which is the
// property the whole abstraction exists to have. docs/adding-a-retailer.md is
// the checklist.
//
// THE UNIMPLEMENTED ONES ARE LISTED ON PURPOSE. A retailer that was analysed and
// found unreadable is a fact worth keeping next to the ones that work -- deleting
// the entry would mean the next person re-does the analysis and reaches the same
// conclusion. `npm run scrape:all` names them and moves on rather than skipping
// them silently. Neither has a row in catalog_retailers, because a row there is a
// claim that data can arrive.

import type { RetailerScraper, Market } from './types.ts'
import { auchan } from '../retailers/auchan/index.ts'
import { carrefour } from '../retailers/carrefour/index.ts'
import { lidl } from '../retailers/lidl/index.ts'

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
  'kaufland.ro is a leaflet and recipe site with no online assortment: /produse.html is a 404 ' +
    'and the sitemap holds category pages, an ingredient encyclopedia and contest rules. There is ' +
    'no product to read, politely or otherwise. See docs/retailers.md.',
)

export const megaImage = new UnimplementedScraper(
  'mega-image',
  'RO',
  'mega-image.ro',
  'Readable but deliberately deferred. 8,879 product URLs, each a ~730 KB Next.js page whose ' +
    '__NEXT_DATA__ carries the name, images and stock state but NO price and NO barcode -- those ' +
    'need a store and delivery context. 6.5 GB a run for the weakest data of the five. ' +
    'See docs/retailers.md.',
)

export const SCRAPERS: RetailerScraper[] = [auchan, carrefour, lidl, kaufland, megaImage]

export const IMPLEMENTED: RetailerScraper[] = SCRAPERS.filter((s) => s.implemented)

export function scraperFor(slug: string): RetailerScraper | null {
  return SCRAPERS.find((s) => s.retailer === slug) ?? null
}
