# The retailers, and what each one actually serves

Everything here was established by probing the live sites, not by reading
documentation. Where a claim has a number attached, that number came off the wire
on 2026-09-04.

**robots.txt was read first for all five.** None of them disallow product pages or
sitemaps to a general crawler.

---

## Auchan -- implemented

**auchan.ro**, VTEX.

The shop's own front end talks to a public catalog API, and reading that is both
cheaper and kinder than rendering pages. One request returns fifty complete
products.

```
GET /api/catalog_system/pub/products/search?_from=0&_to=49
```

Each product carries `productName`, `brand`, `categories` (a full path),
`categoriesIds` (the same as an ancestor chain of ids), `link`, and an `items[]`
array whose first entry holds `ean`, `measurementUnit`, `unitMultiplier`,
`images[]` and `sellers[].commertialOffer` with `Price`, `ListPrice`,
`AvailableQuantity` and `IsAvailable`. Currency is RON. Total assortment: **60,013**.

### Two limits that shape the scraper

**`_from` is hard-capped at 2500.** Past that the API answers
`Parameter _from can't be greater than 2500`. So the catalog cannot be paged
straight through and has to be cut into slices.

**The metadata endpoints have their own, much smaller rate budget.**
`/category/tree/3`, `/brand/list` and `/facets/search` all return 429 with **no
`Retry-After`** once it is spent, and stay that way for tens of minutes.
`/products/search` kept answering normally throughout, repeatedly, across the
whole session.

The obvious design -- fetch the category tree, walk it, page each category -- is
therefore built on the one endpoint that will not answer when you need it.

### What it does instead

Every product carries its own full ancestor chain in `categoriesIds`, so the
category structure is **learned from the products**: page the unfiltered endpoint,
collect every category path seen, query those, collect the paths *they* reveal,
and continue until the frontier is empty. A breadth-first crawl over a graph the
data hands you, needing only the endpoint that works.

The tree is still requested first, as a head start, using a *tolerant* request
whose failure does not count toward the circuit breaker. Getting that wrong once
meant four refusals from an endpoint the crawl does not need opened the circuit
for the endpoint it does.

### Limitations

- **No modification time anywhere in the API**, so there is no incremental run.
  `--since` is ignored and says so.
- `productReference` is sometimes a real EAN and sometimes a 13-digit internal
  code for loose produce. Both look like barcodes; only one is. Every candidate
  goes through a check-digit test, and the internal ones are correctly dropped.
- `brand` is `"Non-brand"` for produce and loose goods. Stored as null -- otherwise
  every apple in the dropdown gets a made-up maker.

---

## Carrefour -- implemented

**carrefour.ro**, Magento.

Discovery is the sitemap index at `/pub/sitemap/sitemap.xml`, which holds two
files: `sitemap_001.xml` (50,000 URLs, 46,757 of them products) and
`sitemap_002.xml` (38,559, all products). **85,121 product URLs** in total, each
with a `<lastmod>` and `changefreq: daily`; the remaining ~3,400 are department
pages and are filtered out by URL rather than fetched to discover they carry no
product.

That count is worth stating carefully, because reading the index by eye gets it
wrong. The first file looks like a category sitemap from its opening entries --
they are all `/tex/`, `/it-c/`, `/auto-moto-brico/` departments -- and it was
documented as "about 600 category pages" until a live crawl counted it. It is
mostly products, and it more than doubles the size of this scrape.

Each product page carries exactly one `application/ld+json` block of
`@type: Product`:

```json
{
  "name": "Lapte UHT pentru cafea Zuzu Barista 3.5% 1L",
  "sku": "15513004",
  "brand": { "name": "Zuzu" },
  "image": ["https://cdn-media.carrefour.ro/..."],
  "offers": { "priceCurrency": "RON", "price": 11.99,
              "availability": "https://schema.org/InStock" }
}
```

### Why not GraphQL

Magento exposes `/graphql`. A POST to it from anything that is not the shop's own
front end returns **403 behind a Cloudflare challenge**. That is Carrefour saying
no to that door, so the scraper uses the front one -- the product pages, which are
public, indexed and allowed by robots.txt. No attempt is made to get past the
challenge.

### Limitations

- **No GTIN. Not a wrong one, not an empty one -- the field is absent from every
  Product block on the site.** This is the single biggest constraint on the whole
  catalog: a Carrefour listing can only ever match another shop's by the merge
  key, and where two shops word a product differently they stay two products. The
  scraper still reads `gtin`, so the day Carrefour starts publishing one, the
  merging starts by itself.
- **No category on the product page.** The JSON-LD has none and the URL is a
  slug. The scraper recognises a few department words and returns null otherwise,
  which is honest -- a guessed shelf is invisible, a null one is findable in the
  admin dashboard.
- **Cost, and it is the real constraint here.** 85,121 pages at ~300 KB and one
  request per second is about **24 hours and ~25 GB** for a first run. That is a
  job to start deliberately, not something to run from a test. Later runs are
  incremental on `lastmod`, which is why that field matters more for this shop
  than for the other two.
- A delisted product returns **404 with no Product block**. That is recorded as
  "delisted" and, importantly, does *not* mark anything unavailable -- absence is
  the sweep's business, once, after a complete run.

---

## Lidl -- implemented

**lidl.ro**, Nuxt.

`/static/sitemap.xml` points at `/p/export/RO/ro/product_sitemap.xml.gz`, which
holds **511** product URLs shaped `/p/{slug}/p{id}`. No `lastmod`, so every run
crawls the lot -- which is cheap at this size.

Lidl RO has no general webshop; these are assortment pages for what is on the
shelves. It is nonetheless the **best data of the three**: it is the only retailer
here that publishes a `gtin13`, on roughly a third of its products.

### Three quirks, all real and all on live pages

- `availability` is **bare** (`"OutOfStock"`, `"InStoreOnly"`), not the full
  schema.org URL Carrefour uses. `InStoreOnly` is the common case and counts as
  available: it is a supermarket, and calling it unavailable would mark almost
  the whole Lidl catalog gone.
- `offers` is an **array**, and only the in-stock entry carries a price. A product
  can legitimately arrive with no price. A shopping list still wants it.
- `sku` is variant-level and longer than the URL id -- the page for `p11000189`
  reports `"11000189121"`. The URL id is used instead, because an id that changes
  when a variant is reorganised means a new listing plus a swept old one on every
  run.

### Limitations

- **Product names rarely carry a size** ("Ciocolată", "Piept de pui feliat"), so
  most Lidl rows have a null quantity and can only merge with another shop's
  through a GTIN. Verified on a live run: twelve products, zero parsed quantities.
- The sitemap is a **gzip file, not a gzip-encoded response** -- no
  `content-encoding` header, so `fetch` does not decompress it and reading it as
  text destroys the magic number. The crawler gunzips from the raw bytes. Getting
  this wrong made a live run read 511 URLs as zero.

---

## Kaufland -- not implementable

**kaufland.ro** is a leaflet, recipe and information site. There is no online
assortment to read.

What was probed:

- `/produse.html` → **404**.
- `/.sitemap.xml` → category pages, an ingredient encyclopedia
  (`/Enciclopedia-alimentelor/fructe/...`), recipes, contest rules and offer
  landing pages. **No product URLs, no SKUs, no prices.**
- `/oferte.html` renders through AEM components with one `BreadcrumbList` JSON-LD
  block and no product data. The only API paths in the markup
  (`/api/autosuggest/assortment/1/`, `/api/autosuggest/recipe/1/`) 404 when
  requested directly.

This is not a scraper that is hard to write; it is a scraper with nothing to
read. There is no bypass to consider, because there is no protected data -- the
data does not exist on the site.

It stays in `src/core/registry.ts` with `implemented: false` so
`npm run scrape:all` names it, and it deliberately has **no row** in
`catalog_retailers`: a row there is a claim that data can arrive.

---

## Mega Image -- deferred, not blocked

**mega-image.ro**, Next.js with an Apollo cache. Readable, and skipped on purpose.

- `/sitemap/delhaizesitemapindex.xml` → three gzipped sitemaps, **8,879** product
  URLs shaped `/{category-path}/{Name}/p/{code}`.
- Each page embeds `__NEXT_DATA__` whose `pageProps.pageData` is a
  `ProductEssentialData` object: `code`, `name`, `galleryImages[]`,
  `manufacturerName`, `available`.

### Why it is not implemented

- **No price and no barcode in the page.** Both need a store and delivery
  context; the embedded payload has neither. It would contribute products with
  the least information of the five.
- **~730 KB per page × 8,879 pages ≈ 6.5 GB per run**, the most expensive crawl
  of the five for the weakest data.
- The site is Dynatrace-instrumented and the `_next/data` route did not answer
  with JSON for a product path, so every product costs a full page render's worth
  of bytes.

None of that is a prohibition -- it is a cost/benefit judgement, and the owner's
call was to skip it in this pass. If it is picked up later, the shape is already
known: sitemap → page → `__NEXT_DATA__` → `pageProps.pageData`, and the listing
lands with `price: null`.

---

## The pattern worth noticing

Three of the five shops publish a complete, machine-readable description of every
product in the first HTTP response, because Google requires it for rich results.
That is a far more stable contract than any DOM selector: it is maintained
deliberately, its shape is specified by somebody other than the shop, and it
survives redesigns that would break a scraper reading rendered markup.

None of the three implemented scrapers needs a browser. That was not a constraint
imposed on the design -- it is what the analysis found.
