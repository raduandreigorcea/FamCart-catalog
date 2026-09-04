// The shape Carrefour and Lidl share: a sitemap of product URLs, and one page
// per product carrying a schema.org Product block.
//
// It lives here rather than being written twice because the awkward parts are
// identical and none of them are about the shop. Incremental selection by
// lastmod, a 404 meaning "delisted" rather than "broken", a page that parses but
// holds no Product, an abort in the middle of forty thousand fetches -- getting
// any of those wrong is the same bug in both scrapers.
//
// What is NOT here is anything shop-specific: which sitemap, how to read an id
// out of a URL, how their category names map onto ours. Those are the parts that
// differ and they stay in the retailer's own directory, which is the whole point
// of the split.

import type { RetailerProduct, ScrapeContext } from './types.ts'
import { HttpClient, CircuitOpenError } from './http.ts'
import { parseUrlset, parseSitemapIndex, maybeGunzip } from './sitemap.ts'
import type { SitemapEntry } from './sitemap.ts'
import { extractJsonLd, findProduct, readProduct } from './jsonld.ts'
import type { JsonLdProduct } from './jsonld.ts'

export interface PageCrawlOptions {
  retailer: string
  http: HttpClient
  ctx: ScrapeContext
  /** Product-URL sitemaps, already resolved. */
  sitemapUrls: string[]
  /** Turn a parsed Product block plus its URL into a listing, or null to skip. */
  build: (product: JsonLdProduct, url: string, html: string) => RetailerProduct | null
  /**
   * Which of the sitemap's URLs are product pages.
   *
   * Carrefour's sitemap index holds a category sitemap next to the product one,
   * and 600 department pages carry no Product block -- fetching them to discover
   * that costs ten minutes and 180 MB per run, and buries the real
   * "this page had no product" signal under noise that is not a problem.
   */
  urlFilter?: (url: string) => boolean
  /**
   * Only relevant for a shop whose sitemap carries lastmod. When it does and
   * `ctx.since` is set, unchanged pages are skipped -- which is what makes a
   * daily Carrefour run minutes rather than hours.
   */
  supportsIncremental: boolean
}

export interface CrawlCounters {
  [key: string]: number
  urls: number
  fetched: number
  skipped: number
  delisted: number
  noProduct: number
  failed: number
}

/** Read every sitemap, following one level of <sitemapindex>. */
export async function collectSitemapEntries(
  http: HttpClient,
  ctx: ScrapeContext,
  urls: string[],
): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = []
  const seen = new Set<string>()

  for (const url of urls) {
    let response
    try {
      response = await http.get(url)
    } catch (error) {
      ctx.log.error('sitemap could not be fetched', { url, error: String(error) })
      continue
    }
    if (!response.ok) {
      ctx.log.error('sitemap returned an error', { url, status: response.status })
      continue
    }

    // From the BYTES: a .xml.gz is a gzip file with no content-encoding
    // header, so the string form is already mojibake by this point.
    const xml = maybeGunzip(response.bytes)
    const nested = parseSitemapIndex(xml)
    if (nested.length > 0) {
      for (const child of nested) {
        if (seen.has(child)) continue
        seen.add(child)
        entries.push(...(await collectSitemapEntries(http, ctx, [child])))
      }
      continue
    }

    for (const entry of parseUrlset(xml)) {
      if (seen.has(entry.loc)) continue
      seen.add(entry.loc)
      entries.push(entry)
    }
  }

  return entries
}

export async function* crawlProductPages(
  options: PageCrawlOptions,
): AsyncGenerator<RetailerProduct> {
  const { http, ctx, retailer, build, supportsIncremental } = options
  const counters: CrawlCounters = { urls: 0, fetched: 0, skipped: 0, delisted: 0, noProduct: 0, failed: 0 }

  const all = await collectSitemapEntries(http, ctx, options.sitemapUrls)
  const entries = options.urlFilter ? all.filter((e) => options.urlFilter!(e.loc)) : all
  counters.urls = entries.length
  if (all.length !== entries.length) {
    ctx.log.info(`${retailer}: sitemap filtered to product pages`, {
      total: all.length,
      products: entries.length,
    })
  }
  ctx.log.info(`${retailer}: sitemap read`, { urls: entries.length })

  if (entries.length === 0) {
    // Nothing to do, and importantly nothing to conclude. The run will report
    // zero and catalog_run_complete will refuse to sweep, which is the correct
    // outcome for "the sitemap moved" and the wrong one for "the shop closed".
    ctx.log.error(`${retailer}: sitemap yielded no product URLs`)
    return
  }

  const wanted = supportsIncremental && ctx.since
    ? entries.filter((e) => e.lastmod === null || e.lastmod >= (ctx.since as Date))
    : entries
  counters.skipped = entries.length - wanted.length
  if (counters.skipped > 0) {
    ctx.log.info(`${retailer}: incremental run`, { fetching: wanted.length, unchanged: counters.skipped })
  }

  let emitted = 0
  for (const entry of wanted) {
    if (ctx.signal?.aborted) return

    let response
    try {
      response = await http.get(entry.loc)
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        // Stop the generator rather than throwing. What has been imported stays
        // imported; the run closes short of its previous count and the sanity
        // floor in catalog_run_complete refuses to sweep on the strength of it.
        ctx.log.error(`${retailer}: circuit open, ending the crawl early`, counters)
        return
      }
      counters.failed++
      continue
    }
    counters.fetched++

    // A delisted product 404s. That is information, not an error -- but it must
    // NOT be turned into "unavailable" here. Absence from this run is what the
    // sweep reads, once, at the end, if the run earns the right to.
    if (response.status === 404 || response.status === 410) {
      counters.delisted++
      continue
    }
    if (!response.ok) {
      counters.failed++
      continue
    }

    const node = findProduct(extractJsonLd(response.body))
    if (!node) {
      counters.noProduct++
      continue
    }

    const product = build(readProduct(node), entry.loc, response.body)
    if (!product) {
      counters.noProduct++
      continue
    }

    yield product
    if (ctx.limit && ++emitted >= ctx.limit) break

    if (counters.fetched % 500 === 0) {
      ctx.log.info(`${retailer}: crawling`, { ...counters, emitted })
    }
  }

  ctx.log.info(`${retailer}: crawl finished`, { ...counters, emitted })
}
