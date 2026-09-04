// Sitemaps, which are how two of the three retailers are discovered at all.
//
// Deliberately regex-based rather than a real XML parser. These files are
// machine-generated, enormous (Carrefour's product sitemap is 38,559 <url>
// entries and 700 KB) and structurally boring; a DOM parse would allocate the
// whole tree to read two fields per entry. The trade is that malformed XML
// yields fewer entries rather than an exception, which for a discovery step is
// the better failure -- a run that finds fewer products imports fewer products
// and is caught by the sanity floor, where a run that throws imports none.

import { gunzipSync } from 'node:zlib'

export interface SitemapEntry {
  loc: string
  lastmod: Date | null
}

const LOC_RE = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi
const URL_BLOCK_RE = /<url>([\s\S]*?)<\/url>/gi
const LASTMOD_RE = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i

/** The nested sitemaps in a <sitemapindex>. */
export function parseSitemapIndex(xml: string): string[] {
  if (!/<sitemapindex/i.test(xml)) return []
  return matchAll(xml, LOC_RE).map(decodeXml)
}

/**
 * The URLs in a <urlset>, with their lastmod where one is given.
 *
 * lastmod is what makes an incremental Carrefour crawl possible: 38,559 pages at
 * one request a second is over ten hours, and only a few thousand of them change
 * on a given day. Lidl publishes none, but Lidl has 511 products and is crawled
 * in full every time.
 */
export function parseUrlset(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = []
  for (const block of matchAll(xml, URL_BLOCK_RE)) {
    const locMatch = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block)
    if (!locMatch) continue
    const lastmodMatch = LASTMOD_RE.exec(block)
    const lastmod = lastmodMatch ? new Date(lastmodMatch[1]) : null
    entries.push({
      loc: decodeXml(locMatch[1]),
      lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null,
    })
  }
  return entries
}

/**
 * Decompress when the bytes are gzipped.
 *
 * Both Lidl's product sitemap and Mega Image's are .xml.gz, and whether they
 * arrive compressed depends on whether the fetch layer already decoded them --
 * curl with --compressed does, a bare fetch does not. Sniffing the magic number
 * is more reliable than trusting the extension or the content-type, both of
 * which these sites get wrong.
 */
export function maybeGunzip(body: Uint8Array | string): string {
  if (typeof body === 'string') {
    // Already text unless it is gzip that got read as latin-1 somewhere upstream.
    if (body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) {
      return gunzipSync(Buffer.from(body, 'binary')).toString('utf8')
    }
    return body
  }
  if (body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body).toString('utf8')
  return Buffer.from(body).toString('utf8')
}

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = []
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1])
  return out
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    // Ampersand LAST, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/g, '&')
    .trim()
}
