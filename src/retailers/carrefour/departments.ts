// Walking Carrefour's departments, which is how the whole shop fits in one job.
//
// The sitemap holds two kinds of URL: 85,119 product pages, and 3,243
// department pages. Reading the departments instead of the products is the
// difference between forty-five hours and about two -- see listing.ts for why
// that is possible at all, and what it costs in stability.
//
// PAGINATION IS NOT UNIFORM, and finding that out is what shaped this. A big
// department pages properly: /bacanie-carrefour/?p=2 returns twenty-four
// products with no overlap, and ?p=200 still returns real ones. A small one
// IGNORES ?p entirely and serves page one again, forever. So "fewer than a full
// page means the end" is wrong -- a leaf with thirteen products would look
// finished on page one and a full department would loop until the job died.
//
// THE STOP RULE IS ABOUT THE DEPARTMENT REPEATING ITSELF, and the first version
// got this wrong in a way that cost half the shop. It stopped as soon as a page
// held nothing GLOBALLY new -- but departments nest, and the leaves are read
// first, so a parent's page one is entirely products its own leaves already
// yielded. Every parent stopped on page one and never reached the pages holding
// the products that sit in no leaf. A live run covered 46.7% of the shop:
// 39,691 products from 5,438 pages, 7.3 per page against a page size of 24.
// The pages were full; the crawl was refusing to turn them.
//
// So the question is "did the shop serve me this same page again", which is
// what a department that ignores ?p does -- never "have I seen these before".

import type { RetailerProduct, ScrapeContext } from '../../core/types.ts'
import type { HttpClient } from '../../core/http.ts'
import { parseListingPage } from './listing.ts'

/** Guards against a department that pages forever. No real one comes near it. */
const MAX_PAGES = 400

/**
 * Has the shop just served the same page again?
 *
 * The only two ways a department is finished: it hands back nothing, or it
 * hands back exactly what it handed back last time -- which is what one too
 * small to paginate does with every ?p it is given.
 *
 * Deliberately NOT "are these products already known". They usually are: a
 * product sits in a leaf and in every parent above it, and the leaves are read
 * first. Treating that as the end stopped every parent on page one.
 */
export function pageRepeats(previous: string[] | null, current: string[]): boolean {
  if (current.length === 0) return true
  if (previous === null || previous.length !== current.length) return false
  return current.every((id, i) => previous[i] === id)
}

export interface DepartmentCrawlCounters {
  [key: string]: number
  departments: number
  pages: number
  unreadable: number
  emitted: number
}

/**
 * Every product a list of departments shows, each product once.
 *
 * Departments overlap -- a product sits in a leaf and in every parent above it --
 * so the same listing arrives several times. Deduplicated here rather than left
 * to the importer: the importer would handle it correctly and idempotently, but
 * it would also count each repeat as a row it processed, and `products_valid` is
 * what the sanity floor and the dashboard's delta are both measured on. A number
 * inflated by duplicates would make a shrinking shop look healthy.
 */
export async function* crawlDepartments(options: {
  http: HttpClient
  ctx: ScrapeContext
  departments: string[]
  counters: DepartmentCrawlCounters
}): AsyncGenerator<RetailerProduct> {
  const { http, ctx, departments, counters } = options
  const seen = new Set<string>()

  for (const department of departments) {
    if (ctx.signal?.aborted) return
    counters.departments++

    let previous: string[] | null = null
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (ctx.signal?.aborted) return

      const url = page === 1 ? department : `${department}?p=${page}`
      let response
      try {
        response = await http.get(url)
      } catch (error) {
        // A department that will not load is a hole in the crawl, and a hole is
        // the one thing a run that may sweep cannot have. Reported upward so the
        // run closes without concluding anything about what it did not see.
        ctx.reportIncomplete?.(`carrefour: ${department} could not be read`)
        ctx.log.warn('carrefour: department failed', { department, page, error: String(error) })
        break
      }

      if (!response.ok) {
        if (response.status !== 404) {
          ctx.reportIncomplete?.(`carrefour: ${department} answered ${response.status}`)
        }
        break
      }
      counters.pages++

      const products = parseListingPage(response.body)
      if (products === null) {
        // The payload was not where it has always been. That is a shop redesign
        // or a deploy, and guessing past it would quietly shrink the catalog.
        counters.unreadable++
        ctx.reportIncomplete?.(`carrefour: no product payload on ${url}`)
        break
      }

      const ids = products.map((product) => product.externalId)

      for (const product of products) {
        // Deduplicated for OUTPUT only. Whether to turn another page is decided
        // below, from the page itself -- conflating the two is what stopped
        // every parent department on its first page.
        if (seen.has(product.externalId)) continue
        seen.add(product.externalId)
        counters.emitted++
        yield product
        if (ctx.limit && counters.emitted >= ctx.limit) return
      }

      if (pageRepeats(previous, ids)) break
      previous = ids

      if (counters.pages % 250 === 0) {
        ctx.log.info('carrefour: crawling departments', { ...counters })
      }
    }
  }
}
