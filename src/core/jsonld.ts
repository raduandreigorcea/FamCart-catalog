// schema.org Product blocks, which is how Carrefour and Lidl are read.
//
// Both sites are heavy JavaScript applications -- Magento and Nuxt -- and both
// put a complete, machine-readable description of the product in the HTML that
// arrives from the server, because Google requires it. That is the whole reason
// neither scraper needs a browser: the data a rendering engine would eventually
// produce is already in the first response, in a format the site MAINTAINS
// because its search ranking depends on it. A selector-based scrape of the
// rendered DOM would break on the next redesign; this does not.
//
// Verified against real pages, and the variety is why this file is defensive:
//
//   Carrefour  offers.availability  "https://schema.org/InStock"   (full URL)
//   Lidl       offers.availability  "OutOfStock" / "InStoreOnly"   (bare)
//   Lidl       offers               an ARRAY, sometimes with no price at all
//   Lidl       gtin13               an ARRAY of strings
//   Carrefour  gtin                 absent entirely, on every product

export interface JsonLdProduct {
  name: string | null
  sku: string | null
  gtin: string | null
  brand: string | null
  image: string | null
  description: string | null
  price: number | null
  currency: string | null
  availability: string | null
  url: string | null
}

const SCRIPT_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/** Every ld+json block in a page, parsed, skipping the ones that are not JSON. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = []
  SCRIPT_RE.lastIndex = 0
  for (let m = SCRIPT_RE.exec(html); m !== null; m = SCRIPT_RE.exec(html)) {
    const text = m[1].trim()
    if (!text) continue
    try {
      out.push(JSON.parse(text))
    } catch {
      // A malformed block is one block. Carrefour and Lidl both ship several per
      // page (WebSite, BreadcrumbList, Organization) and losing one to a stray
      // character must not lose the Product next to it.
    }
  }
  return out
}

/** The first @type Product, looking inside @graph and arrays. */
export function findProduct(nodes: unknown[]): Record<string, unknown> | null {
  const queue = [...nodes]
  while (queue.length > 0) {
    const node = queue.shift()
    if (Array.isArray(node)) {
      queue.push(...node)
      continue
    }
    if (!node || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    if (typeOf(record).includes('Product')) return record
    if (Array.isArray(record['@graph'])) queue.push(...(record['@graph'] as unknown[]))
  }
  return null
}

/** Flatten one Product node into the fields a listing needs. */
export function readProduct(node: Record<string, unknown>): JsonLdProduct {
  const offer = firstOffer(node['offers'])

  return {
    name: str(node['name']),
    sku: str(node['sku']) ?? str(node['productID']) ?? str(node['mpn']),
    gtin: firstString(node['gtin13']) ?? firstString(node['gtin']) ??
          firstString(node['gtin14']) ?? firstString(node['gtin12']) ?? firstString(node['gtin8']),
    brand: brandOf(node['brand']),
    image: firstString(node['image']),
    description: str(node['description']),
    price: num(offer?.['price']),
    currency: str(offer?.['priceCurrency']),
    availability: availabilityOf(offer?.['availability']),
    url: str(node['url']) ?? str(offer?.['url']),
  }
}

/**
 * In stock, as a boolean.
 *
 * InStoreOnly counts as available and that is a judgement, not an oversight:
 * Lidl marks most of its assortment that way because it has no general
 * webshop, and a shopping list is a list of things to pick up in a shop. Calling
 * that "unavailable" would mark almost the whole Lidl catalog as gone.
 */
export function isAvailable(availability: string | null): boolean {
  if (!availability) return false
  const value = availability.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase()
  return value === 'instock' || value === 'instoreonly' || value === 'limitedavailability' ||
         value === 'onlineonly' || value === 'presale'
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type']
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  return []
}

function firstOffer(offers: unknown): Record<string, unknown> | null {
  if (Array.isArray(offers)) {
    // Prefer an offer that actually names a price: Lidl ships several and only
    // the in-stock one carries a number.
    const priced = offers.find((o) => o && typeof o === 'object' && num((o as Record<string, unknown>)['price']) !== null)
    const chosen = priced ?? offers[0]
    return chosen && typeof chosen === 'object' ? (chosen as Record<string, unknown>) : null
  }
  return offers && typeof offers === 'object' ? (offers as Record<string, unknown>) : null
}

function brandOf(brand: unknown): string | null {
  if (typeof brand === 'string') return brand.trim() || null
  if (Array.isArray(brand)) return brandOf(brand[0])
  if (brand && typeof brand === 'object') return str((brand as Record<string, unknown>)['name'])
  return null
}

function availabilityOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') return str((value as Record<string, unknown>)['@id'])
  return null
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  return null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    // "11,99" and "11.99" both occur. Strip anything that is not part of a
    // number, then treat a lone comma as the decimal separator.
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '')
    const normalized = cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '')
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item)
      if (found) return found
    }
    return null
  }
  return str(value)
}
