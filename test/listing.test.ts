// The Carrefour department-page reader, against pages captured from the site.
//
// This path exists because the product-page crawl is unaffordable: 85,119 pages
// at the polite rate is about forty-five hours against a six-hour job, so it was
// being cut into slices that never finished and therefore never earned the right
// to sweep. A department page carries twenty-four products at once.
//
// What is worth pinning is not "it parses". It is the two ways this can go wrong
// quietly: a payload read as a fraction of itself, and a picture attached to the
// wrong product.
import { describe, it, expect } from 'vitest'
import { readFixture } from './helpers.ts'
import {
  parseImpressions,
  imagesById,
  parseListingPage,
  categoryFromLabel,
  buildFromImpression,
} from '../src/retailers/carrefour/listing.ts'

const paged = readFixture('carrefour/listing-paged.html.gz')
const single = readFixture('carrefour/listing-single.html.gz')

describe('the analytics payload', () => {
  it('reads every product on the page, not the first few', () => {
    // THE REGRESSION THIS GUARDS. The payload is nested, so a lazy regex stops
    // at the first inner brace and returns something that parses cleanly and
    // holds a fraction of the products. The catalog would read that as a shop
    // that had quietly shrunk -- which is the exact failure the sanity floor
    // then has to catch, having been handed bad data by us rather than by them.
    const rows = parseImpressions(paged)
    expect(rows).not.toBeNull()
    expect(rows!.length).toBe(24)
  })

  it('reads a department that fits on one page', () => {
    expect(parseImpressions(single)!.length).toBeGreaterThan(0)
  })

  it('says null rather than empty when the payload is not there', () => {
    // The distinction is load-bearing. Empty means "this department has no
    // products", which is ordinary. Null means "we could not read the page",
    // which must stop the crawl claiming it saw a shop.
    expect(parseImpressions('<html><body>nothing here</body></html>')).toBeNull()
    expect(parseImpressions('var impressionData = {broken')).toBeNull()
  })

  it('carries the fields the catalog needs', () => {
    const first = parseImpressions(paged)![0]
    expect(first.id).toMatch(/^\d{4,}$/)
    expect(first.name.length).toBeGreaterThan(3)
    expect(typeof first.price).toBe('number')
    expect(first.category).toBeTruthy()
  })
})

describe('images', () => {
  it('keys a picture to the product id in its filename, not to its position', () => {
    // Order would tie an image to a place in the markup, and one extra tile --
    // a promotion, a sponsored slot -- would shift every product's picture by
    // one. Nothing would fail; every row would simply be wrong.
    const images = imagesById(paged)
    const rows = parseImpressions(paged)!
    expect(images.size).toBeGreaterThan(0)
    const url = images.get(rows[0].id)
    expect(url, 'first product has its own image').toBeTruthy()
    expect(url).toContain(rows[0].id)
  })

  it('leaves a product with no image rather than borrowing one', () => {
    const product = buildFromImpression(
      { id: '99999999', name: 'Ceva', price: 1 },
      new Map([['11111111', 'https://x.test/11111111_1_.webp']]),
    )
    expect(product!.imageUrl).toBeNull()
  })
})

describe('the whole page', () => {
  it('turns a department into listings', () => {
    const products = parseListingPage(paged)!
    expect(products.length).toBe(24)
    for (const p of products) {
      expect(p.retailer).toBe('carrefour')
      expect(p.externalId).toMatch(/^\d{4,}$/)
      expect(p.productUrl).toContain(p.externalId)
      // Carrefour publishes no GTIN, on this path or any other.
      expect(p.gtin).toBeNull()
    }
  })

  it('gets a category, which the product page never had', () => {
    // The reason this path is not merely cheaper: categoryFromUrl() can only
    // read a department out of a URL, and 85,119 Carrefour URLs are a flat
    // /produse/<slug>. Here the shop names the department itself.
    const products = parseListingPage(paged)!
    expect(products.some((p) => p.category !== null)).toBe(true)
  })

  it('reads the price and the currency together, or neither', () => {
    for (const p of parseListingPage(paged)!) {
      if (p.price === null) expect(p.currency).toBeNull()
      else expect(p.currency).toBe('RON')
    }
  })

  it('treats anything but "available" as off the shelf', () => {
    // Absence never deletes anything -- it only stops a listing being offered --
    // so the cautious reading is the safe one here.
    const yes = buildFromImpression({ id: '1234', name: 'A', dimension10: 'available' }, new Map())
    const no = buildFromImpression({ id: '1234', name: 'A', dimension10: 'outOfStock' }, new Map())
    const unknown = buildFromImpression({ id: '1234', name: 'A' }, new Map())
    expect(yes!.available).toBe(true)
    expect(no!.available).toBe(false)
    expect(unknown!.available).toBe(false)
  })

  it('drops a row with no usable id or name rather than inventing one', () => {
    expect(buildFromImpression({ id: '', name: 'A' }, new Map())).toBeNull()
    expect(buildFromImpression({ id: 'abc', name: 'A' }, new Map())).toBeNull()
    expect(buildFromImpression({ id: '1234', name: '  ' }, new Map())).toBeNull()
  })

  it('says null for a page it could not read, so a crawl cannot count it as empty', () => {
    expect(parseListingPage('<html></html>')).toBeNull()
  })
})

describe('the shop department, folded onto ours', () => {
  it('lets the LEADING shelf decide when a department names two', () => {
    // "Bacanie & Lichide" is groceries and drinks in one aisle, and both halves
    // match. The first version of this answered `drinks` purely because the
    // drinks rule was written higher up the list -- an answer decided by luck.
    // The shop puts the primary shelf first in its own name, so that is what is
    // read first.
    expect(categoryFromLabel('Bacanie & Lichide')).toBe('pantry')
    expect(categoryFromLabel('Lactate, Branzeturi & Oua')).toBe('dairy')
    // And a single-shelf name still works the obvious way.
    expect(categoryFromLabel('Bauturi')).toBe('drinks')
    expect(categoryFromLabel('Congelate')).toBe('frozen')
  })

  it('maps the ones that matter', () => {
    expect(categoryFromLabel('Lactate, Branzeturi & Oua')).toBe('dairy')
    expect(categoryFromLabel('Fructe & Legume')).toBe('produce')
    expect(categoryFromLabel('Vinuri & Spirtoase')).toBe('alcohol')
  })

  it('answers null for a department we have no shelf for', () => {
    // A guessed shelf is worse than none: the admin dashboard can find nulls,
    // and cannot find a plausible wrong answer.
    expect(categoryFromLabel('Electrocasnice')).toBeNull()
    expect(categoryFromLabel(null)).toBeNull()
    expect(categoryFromLabel('')).toBeNull()
  })
})

// ─── the stop rule ───────────────────────────────────────────────────────────
// A live run covered 46.7% of the shop and the coverage check refused to let it
// sweep, which is what it is for. The cause was here: the crawl stopped a
// department as soon as a page held nothing GLOBALLY new.
//
// Departments nest, and the leaves are read first, so a parent's page one is
// entirely products its own leaves already yielded -- and the parent stopped
// there, never reaching page two, where the products that sit in no leaf live.
// 39,691 products from 5,438 pages is 7.3 per page against a page size of 24;
// the pages were full, the crawl was just refusing to turn them.
//
// The rule has to be about the DEPARTMENT repeating itself, not about novelty:
// a small department ignores ?p and serves page one forever, and that -- not
// "I have seen these before" -- is the thing to stop on.
import { pageRepeats } from '../src/retailers/carrefour/departments.ts'

describe('when to stop turning the pages of a department', () => {
  it('stops when the shop serves the same page again', () => {
    // A department with thirteen products ignores ?p entirely.
    expect(pageRepeats(['1', '2', '3'], ['1', '2', '3'])).toBe(true)
  })

  it('stops on an empty page', () => {
    expect(pageRepeats(['1', '2'], [])).toBe(true)
  })

  it('KEEPS GOING when the page is full of products seen elsewhere', () => {
    // The regression. Every id here has been seen -- in a leaf department --
    // but this page is not the previous page, so the department has more to
    // give and stopping would lose whatever is on page two.
    expect(pageRepeats(['1', '2', '3'], ['4', '5', '6'])).toBe(false)
  })

  it('keeps going when the page has merely shifted', () => {
    expect(pageRepeats(['1', '2', '3'], ['2', '3', '4'])).toBe(false)
  })

  it('treats the first page as never a repeat', () => {
    expect(pageRepeats(null, ['1', '2'])).toBe(false)
  })
})
