// Auchan Romania, and the reference implementation for this repository.
//
// HOW IT FINDS PRODUCTS, AND WHY NOT THE OBVIOUS WAY.
//
// The obvious way is to page /api/catalog_system/pub/products/search from 0 to
// 60,013. VTEX refuses: `_from` is hard-capped at 2500 and returns
// "Parameter _from can't be greater than 2500." So the catalog has to be cut
// into slices small enough to page, and the natural slices are categories.
//
// The obvious way to get the categories is /api/catalog_system/pub/category/
// tree/3. That endpoint, /brand/list and /facets/search share a rate limit
// budget that is much smaller than the product endpoint's, and once it is spent
// they return 429 with no Retry-After for a long time -- measured in tens of
// minutes, observed repeatedly while this scraper was being written, while
// /products/search kept answering normally throughout.
//
// So the tree is an accelerator, not a dependency. Every product carries its own
// full ancestor chain in `categoriesIds`, which means the category structure can
// be LEARNED FROM THE PRODUCTS THEMSELVES: page the unfiltered endpoint for the
// first 2500, collect every category path seen, query those, collect the paths
// THEY reveal, and keep going until the frontier is empty. A breadth-first crawl
// over a graph the data hands you, needing nothing but the endpoint that works.
//
// The tree is still fetched first when it can be, because starting from the real
// category list reaches the long tail faster. When it 429s, the run says so and
// carries on.

import type { RetailerProduct, RetailerScraper, ScrapeContext, Market } from '../../core/types.ts'
import { HttpClient, CircuitOpenError } from '../../core/http.ts'
import { fetchRobots, isAllowed } from '../../core/robots.ts'
import { toRetailerProduct, parseResourcesHeader, categoryPathsOf } from './vtex.ts'
import type { VtexProduct } from './vtex.ts'

const ORIGIN = 'https://www.auchan.ro'
const API = `${ORIGIN}/api/catalog_system/pub`
const PAGE = 50
/** VTEX's own limit, not ours. */
const MAX_OFFSET = 2500

interface TreeNode {
  id?: number
  name?: string
  hasChildren?: boolean
  children?: TreeNode[]
}

export class AuchanScraper implements RetailerScraper {
  readonly retailer = 'auchan'
  readonly country: Market = 'RO'
  readonly domain = 'auchan.ro'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    // Auchan's API is JSON and answers fast, so it can be paced a little harder
    // than a page crawl -- but not much: the metadata endpoints are proof that
    // there is a budget and that it is not generous.
    const http = new HttpClient({
      minIntervalMs: 400,
      timeoutMs: 30_000,
      retries: 3,
      fetchImpl: ctx.fetchImpl,
    })

    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${API}/products/search`)) {
      throw new Error('auchan robots.txt disallows the catalog API; refusing to crawl')
    }
    if (robots.crawlDelayMs) {
      ctx.log.info('auchan asks for a crawl delay', { ms: robots.crawlDelayMs })
    }

    // `since` has no meaning here: the API exposes no modification time, so an
    // incremental run is not possible and pretending otherwise would silently
    // skip the whole catalog.
    if (ctx.since) {
      ctx.log.warn('auchan has no modification time; --since is ignored and the full catalog is read')
    }

    const seenProducts = new Set<string>()
    const queuedPaths = new Set<string>()
    const frontier: string[] = []
    let emitted = 0

    const enqueue = (path: string): void => {
      if (!queuedPaths.has(path)) {
        queuedPaths.add(path)
        frontier.push(path)
      }
    }

    for (const path of await this.seedFromTree(http, ctx)) enqueue(path)

    // The unfiltered first slice, which both yields products and seeds the
    // frontier with every category those products belong to. This is what makes
    // the crawl work with no tree at all.
    for await (const product of this.page(http, ctx, null, seenProducts, enqueue)) {
      yield product
      if (ctx.limit && ++emitted >= ctx.limit) return
    }

    while (frontier.length > 0) {
      if (ctx.signal?.aborted) return
      const path = frontier.shift() as string
      for await (const product of this.page(http, ctx, path, seenProducts, enqueue)) {
        yield product
        if (ctx.limit && ++emitted >= ctx.limit) return
      }
    }

    ctx.log.info('auchan crawl finished', {
      products: seenProducts.size,
      categories: queuedPaths.size,
    })
  }

  /** The category list, when the rate limit allows it. Never fatal. */
  private async seedFromTree(http: HttpClient, ctx: ScrapeContext): Promise<string[]> {
    try {
      const response = await http.get(`${API}/category/tree/3`)
      if (!response.ok) {
        ctx.log.warn('auchan category tree unavailable; learning categories from products instead', {
          status: response.status,
        })
        return []
      }
      const tree = JSON.parse(response.body) as TreeNode[]
      const paths: string[] = []
      const walk = (nodes: TreeNode[], ancestors: number[]): void => {
        for (const node of nodes) {
          if (typeof node.id !== 'number') continue
          const chain = [...ancestors, node.id]
          paths.push(`/${chain.join('/')}/`)
          if (node.children?.length) walk(node.children, chain)
        }
      }
      walk(tree, [])
      ctx.log.info('auchan category tree read', { categories: paths.length })
      return paths
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error
      ctx.log.warn('auchan category tree could not be parsed; learning from products instead')
      return []
    }
  }

  /**
   * Page one slice, yielding products not seen before and reporting the
   * categories they reveal.
   *
   * A slice that reports more than VTEX will page is not an error and not a
   * reason to stop: we take the first 2500 and rely on the child categories,
   * which the products themselves have just told us about, to cover the rest.
   */
  private async *page(
    http: HttpClient,
    ctx: ScrapeContext,
    categoryPath: string | null,
    seen: Set<string>,
    enqueue: (path: string) => void,
  ): AsyncGenerator<RetailerProduct> {
    let offset = 0
    let total = Infinity

    while (offset < Math.min(total, MAX_OFFSET)) {
      if (ctx.signal?.aborted) return

      const to = offset + PAGE - 1
      const url = categoryPath
        ? `${API}/products/search?fq=C:${categoryPath}&_from=${offset}&_to=${to}`
        : `${API}/products/search?_from=${offset}&_to=${to}`

      let response
      try {
        response = await http.get(url)
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          // The host has stopped answering. Ending the generator lets the run
          // import what it has and close as `partial`, which is exactly the case
          // the sanity floor exists for.
          ctx.log.error('auchan circuit open; ending the crawl early', { category: categoryPath })
          return
        }
        ctx.log.warn('auchan page failed; skipping it', { url, error: String(error) })
        return
      }

      if (!response.ok) {
        ctx.log.warn('auchan page returned an error', { url, status: response.status })
        return
      }

      const range = parseResourcesHeader(response.headers.get('resources'))
      if (range) total = range.total

      let products: VtexProduct[]
      try {
        products = JSON.parse(response.body) as VtexProduct[]
      } catch {
        ctx.log.warn('auchan page was not JSON', { url })
        return
      }
      if (!Array.isArray(products) || products.length === 0) return

      for (const raw of products) {
        for (const path of categoryPathsOf(raw)) enqueue(path)

        const id = String(raw.productId ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)

        const product = toRetailerProduct(raw, this.retailer)
        if (product) yield product
      }

      offset += products.length
      if (products.length < PAGE) return
    }

    if (total > MAX_OFFSET) {
      ctx.log.info('auchan slice larger than VTEX will page; its children will cover the rest', {
        category: categoryPath ?? '(all)',
        total,
      })
    }
  }
}

export const auchan = new AuchanScraper()
