// How far a crawl is through its own plan, reported as it goes.
//
// The Scrapers page used to estimate progress from the same shop's last
// COMPLETED run, which a first run does not have and Carrefour never has -- so
// those crawls showed no bar at all. Every scraper knows early how much it has
// to read: the sitemap's product pages, Carrefour's departments, the categories
// Auchan has found so far. That is what is reported, in the scraper's own unit.

import { describe, it, expect } from 'vitest'
import { fixtureFetch, collect, testLogger } from './helpers.ts'
import { SCRAPERS } from '../src/core/registry.ts'

type Report = { done: number; total: number; unit: string }

const robots = { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' }
const urlset = (urls: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc><lastmod>2026-09-14</lastmod></url>`)
    .join('')}</urlset>`

describe('progress through a sitemap', () => {
  it('reports the product pages done out of the pages the sitemap planned', async () => {
    const reports: Report[] = []
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: 'product_sitemap',
        body: urlset([
          'https://www.lidl.de/p/loch-lomond-single-malt-scotch-whisky-12-jahre-46-vol/p100269218',
          'https://www.lidl.de/p/parkside-heckenschere-teleskop/p100397648',
        ]),
      },
      { match: 'loch-lomond', file: 'lidl-eu/de-drinks.html.gz' },
      { match: 'heckenschere', file: 'lidl-eu/de-garden.html.gz' },
    ])
    const scraper = SCRAPERS.find((s) => s.retailer === 'lidl-de')!
    await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportProgress: (done: number, total: number, unit: string) => void reports.push({ done, total, unit }),
      }),
    )
    // Known before the first page is read, so a bar can be drawn from minute one.
    expect(reports[0]).toEqual({ done: 0, total: 2, unit: 'pages' })
    // A page refused as outside groceries still counts: the crawl read it.
    expect(reports.at(-1)).toEqual({ done: 2, total: 2, unit: 'pages' })
    expect(reports.every((r) => r.done <= r.total)).toBe(true)
  })
})

describe('progress through Carrefour’s departments', () => {
  it('reports the departments read out of every department the run will read', async () => {
    const { crawlDepartments } = await import('../src/retailers/carrefour/departments.ts')
    const { HttpClient } = await import('../src/core/http.ts')
    const single = fixtureFetch([{ match: 'carrefour.ro/', file: 'carrefour/listing-single.html.gz' }])
    const http = new HttpClient({ fetchImpl: single, minIntervalMs: 0 })
    const reports: Report[] = []
    const ctx = {
      log: testLogger(),
      reportProgress: (done: number, total: number, unit: string) => void reports.push({ done, total, unit }),
    }
    const counters = { departments: 0, pages: 0, unreadable: 0, emitted: 0 }
    // The second call carries on from the first: groceries first, then the rest,
    // against one total for the whole night.
    await collect(crawlDepartments({
      http, ctx, counters, total: 3,
      departments: ['https://carrefour.ro/lactate', 'https://carrefour.ro/bacanie'],
    }))
    await collect(crawlDepartments({
      http, ctx, counters, total: 3, isGrocery: () => false, onOutside: async () => {},
      departments: ['https://carrefour.ro/imbracaminte'],
    }))
    expect(reports.at(0)).toEqual({ done: 1, total: 3, unit: 'departments' })
    expect(reports.at(-1)).toEqual({ done: 3, total: 3, unit: 'departments' })
  })
})

describe('progress through Auchan’s categories', () => {
  it('reports the slices read out of the slices known so far', async () => {
    const reports: Report[] = []
    const { readFixture } = await import('./helpers.ts')
    const page = readFixture('auchan/products-search.json')
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/robots.txt')) return new Response(readFixture('auchan/robots.txt'))
      if (url.includes('/category/tree')) return new Response('[]')
      // Every slice answers with the same one page, so the frontier is what the
      // products name, and each slice ends after one page.
      return new Response(page, { headers: { resources: '0-49/50' } })
    }) as unknown as typeof fetch
    const scraper = SCRAPERS.find((s) => s.retailer === 'auchan')!
    await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportProgress: (done: number, total: number, unit: string) => void reports.push({ done, total, unit }),
      }),
    )
    expect(reports.length).toBeGreaterThan(1)
    expect(reports.every((r) => r.unit === 'categories' && r.done <= r.total)).toBe(true)
    // The crawl ends with every category it learned of read.
    const last = reports.at(-1)!
    expect(last.done).toBe(last.total)
  })
})
