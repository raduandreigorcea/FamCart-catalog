// A fetch that serves test/fixtures/ instead of the internet.
//
// This is what makes the retailer tests real without making them flaky. The
// fixtures are bytes captured from the live sites -- a VTEX API page, three
// Carrefour product pages, three Lidl ones, both sitemaps, all three robots.txt
// -- so the parsers are exercised against what the shops actually send, and CI
// never touches a shop.
//
// A URL with no fixture is a 404 rather than a throw, because that is what the
// scrapers have to cope with anyway and a test that cannot reach a page should
// exercise the same path a delisted product does.

import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

export function fixturePath(relative: string): string {
  return FIXTURES + relative
}

/** Read a fixture, transparently decompressing the .gz ones. */
export function readFixture(relative: string): string {
  return readFixtureBytes(relative).toString('utf8')
}

/**
 * The raw bytes, decompressing a .gz fixture only because the ones we store
 * compressed (the HTML pages) are compressed by US to keep the repository small,
 * not by the shop.
 *
 * The distinction matters for the sitemaps: Lidl serves a real .xml.gz FILE, and
 * the crawler has to gunzip that itself because there is no content-encoding
 * header for fetch to act on. Its fixture is stored already-decompressed so this
 * helper stays honest about which side did the work.
 */
export function readFixtureBytes(relative: string): Buffer {
  const bytes = readFileSync(fixturePath(relative))
  return relative.endsWith('.gz') ? gunzipSync(bytes) : bytes
}

export function fixtureExists(relative: string): boolean {
  return existsSync(fixturePath(relative))
}

export interface FixtureRoute {
  /** Matched against the whole URL. */
  match: RegExp | string
  /** Fixture path relative to test/fixtures/, or a literal body. */
  file?: string
  body?: string
  status?: number
  headers?: Record<string, string>
}

/**
 * Build a `fetch` that answers from a routing table.
 *
 * Bodies are returned as TEXT, because that is what HttpClient reads. The .gz
 * fixtures are decompressed on the way out, matching what a real fetch does when
 * the server sets content-encoding.
 */
export function fixtureFetch(routes: FixtureRoute[]): typeof fetch {
  const calls: string[] = []
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)

    const route = routes.find((r) =>
      typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url),
    )
    if (!route) {
      return new Response('not found', { status: 404 })
    }
    const body = route.body !== undefined
      ? Buffer.from(route.body, 'utf8')
      : route.file
        ? readFixtureBytes(route.file)
        : Buffer.alloc(0)
    // Copied into a plain Uint8Array: a Node Buffer is a BodyInit at runtime
    // but not in the WebWorker lib this project type-checks against, which is
    // the lib the scrapers actually run under.
    return new Response(new Uint8Array(body), {
      status: route.status ?? 200,
      headers: route.headers ?? {},
    })
  }
  ;(impl as unknown as { calls: string[] }).calls = calls
  return impl as unknown as typeof fetch
}

/** The URLs a fixtureFetch was asked for, in order. */
export function callsOf(impl: typeof fetch): string[] {
  return (impl as unknown as { calls: string[] }).calls ?? []
}

/** Drain an async generator into an array, with a safety cap. */
export async function collect<T>(source: AsyncGenerator<T>, max = 1000): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) {
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

/** A logger that keeps its lines so a test can assert on what was reported. */
export function testLogger(): {
  info: (m: string, f?: Record<string, unknown>) => void
  warn: (m: string, f?: Record<string, unknown>) => void
  error: (m: string, f?: Record<string, unknown>) => void
  lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }>
} {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []
  return {
    lines,
    info: (message, fields) => void lines.push({ level: 'info', message, fields }),
    warn: (message, fields) => void lines.push({ level: 'warn', message, fields }),
    error: (message, fields) => void lines.push({ level: 'error', message, fields }),
  }
}
