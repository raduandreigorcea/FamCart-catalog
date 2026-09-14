// The links a page's schema.org BreadcrumbList names, in position order.
//
// Several shops publish no category on the Product block itself but do publish
// the trail above it, and the trail's links are the shop's own keys for its
// departments (/produkte/milchprodukte-eier/k/..., /shop/c/drogerie/blumen-...).
// A retailer turns those into a shelf; this only reads them.

import { extractJsonLd } from './jsonld.ts'

function collect(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (record['@type'] === 'BreadcrumbList' && Array.isArray(record['itemListElement'])) {
    const items = [...(record['itemListElement'] as Array<Record<string, unknown>>)].sort(
      (a, b) => Number(a?.['position'] ?? 0) - Number(b?.['position'] ?? 0),
    )
    for (const item of items) {
      const target = item?.['item']
      const href = typeof target === 'string' ? target : (target as Record<string, unknown> | null)?.['@id']
      if (typeof href === 'string') out.push(href)
    }
    return
  }
  if (record['@graph']) collect(record['@graph'], out)
}

export function breadcrumbLinks(html: string): string[] {
  const links: string[] = []
  collect(extractJsonLd(html), links)
  return links
}
