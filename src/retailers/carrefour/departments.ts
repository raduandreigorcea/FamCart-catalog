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
// The stop rule is therefore about identity, not count: stop when a page shows
// nothing the previous pages did not already show.

import type { RetailerProduct, ScrapeContext } from '../../core/types.ts'
import type { HttpClient } from '../../core/http.ts'
import { parseListingPage } from './listing.ts'

/** Guards against a department that pages forever. No real one comes near it. */
const MAX_PAGES = 400

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

      let fresh = 0
      for (const product of products) {
        if (seen.has(product.externalId)) continue
        seen.add(product.externalId)
        fresh++
        counters.emitted++
        yield product
        if (ctx.limit && counters.emitted >= ctx.limit) return
      }

      // THE STOP RULE. Nothing new on this page means either the department has
      // run out or it is serving page one again, and both mean the same thing:
      // there is nothing further here. Counting products instead would loop a
      // small department until the job timed out.
      if (fresh === 0) break

      if (counters.pages % 250 === 0) {
        ctx.log.info('carrefour: crawling departments', { ...counters })
      }
    }
  }
}
