// Walking Carrefour's departments, which is how the whole shop fits in one job.
//
// The sitemap holds two kinds of URL: 85,119 product pages, and 3,551
// department pages (2026-09-15), 545 of them groceries. Reading the departments
// instead of the products is the difference between forty-five hours and about
// eight -- see listing.ts for why that is possible at all, and what it costs in
// stability, and index.ts for why eight still does not fit in one job.
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

// ─── which departments are groceries ─────────────────────────────────────────
// Carrefour's department tree, read from its sitemap on 2026-09-14. Groceries
// and personal care are whole departments; the home and baby departments are
// mixed, and only their named aisles count -- cleaning, kitchen and the pet shop;
// nappies, baby food and baby toiletries. Everything else is the non-food shop:
// clothing (tex), sport, auto and DIY, books, IT, TV, appliances, toys, and the
// promotions and campaigns, which are not departments at all.
//
// A PROMOTION DOES NOT DECIDE. A product seen in a promotion and in a grocery
// department is groceries; the crawl keeps it when it reaches the department.
const GROCERY_DEPARTMENTS = new Set(['bacanie-carrefour', 'cosmetice-si-ingrijire-personala'])

const GROCERY_AISLES: Record<string, Set<string>> = {
  'casa-gradina-si-petshop': new Set(['produse-curatenie-pentru-casa', 'petshop', 'ustensile-si-accesorii-bucatarie']),
  'articole-bebelusi': new Set([
    'scutece-si-servetele-umede', 'hrana-bebelusi', 'hranire-bebelusi', 'articole-de-baie',
    'accesorii-igiena-si-sanatate-bebelusi', 'cosmetice-bebelusi',
  ]),
}

export function carrefourDepartmentIsGrocery(department: string): boolean {
  const [root, aisle] = new URL(department).pathname.split('/').filter(Boolean)
  if (!root) return false
  if (GROCERY_DEPARTMENTS.has(root)) return true
  return aisle !== undefined && (GROCERY_AISLES[root]?.has(aisle) ?? false)
}

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
  /**
   * Whether a department's products are groceries. A product is yielded the
   * first time a grocery department shows it -- which may be after a promotion
   * or a parent already did. Omitted, every department counts.
   */
  isGrocery?: (department: string) => boolean
  /** Every product any department shows, grocery or not: the caller's coverage. */
  onSeen?: (externalId: string) => void
  /**
   * Every product a department OUTSIDE groceries shows, awaited before the crawl
   * reads on. The caller reports exclusions from it, and a report still pending
   * when the job is killed is a removal lost.
   */
  onOutside?: (externalId: string) => void | Promise<void>
  /**
   * Every department the whole run will read, across both passes, for the
   * progress report. The counters carry on between the passes, so the two calls
   * report against one total.
   */
  total?: number
}): AsyncGenerator<RetailerProduct> {
  const { http, ctx, departments, counters } = options
  const yielded = new Set<string>()

  for (const department of departments) {
    if (ctx.signal?.aborted) return
    counters.departments++
    const grocery = options.isGrocery ? options.isGrocery(department) : true

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
        options.onSeen?.(product.externalId)
        if (!grocery) {
          await options.onOutside?.(product.externalId)
          continue
        }
        // Deduplicated for OUTPUT only. Whether to turn another page is decided
        // below, from the page itself -- conflating the two is what stopped
        // every parent department on its first page.
        if (yielded.has(product.externalId)) continue
        yielded.add(product.externalId)
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
    if (options.total) ctx.reportProgress?.(counters.departments, options.total, 'departments')
  }
}
