# Adding a retailer

Adding a shop means adding a directory and a line. Nothing in the pipeline
changes — validation, matching, the importer and the run accounting read only
`RetailerProduct`, and that is the property the whole abstraction exists to have.

The work that actually matters happens before any of that, and it is the part
worth being slow about.

---

## 1. Find out what the site is, before writing anything

**Do not reach for a browser because it is easier.** A headless browser is slower,
heavier, more fragile and far ruder than an HTTP request, and in every one of the
five shops looked at so far it turned out to be unnecessary. Work through these in
order and stop at the first that answers:

| Look for | How to tell | Example |
|---|---|---|
| A public API the front end uses | Open the network tab; look for JSON | Auchan: VTEX `/api/catalog_system/pub/products/search` |
| `application/ld+json` in the served HTML | `curl -s URL \| grep -c 'ld+json'` | Carrefour, Lidl |
| An embedded state blob | `__NEXT_DATA__`, `window.__NUXT__`, an Apollo cache | Mega Image |
| A sitemap | `/robots.txt` names it | all three implemented |
| A feed | `.xml`, `.csv`, a partner export | none so far |

**Fetch the raw bytes, not a rendered view.** Tools that convert a page to
markdown strip `<script>` tags, which is exactly where the JSON-LD lives — two
shops here looked like they had no structured data at all until they were fetched
with `curl` and grepped.

Three of five shops publish complete product data in the first response because
Google requires it for rich results. That is a far better contract than any DOM
selector: it is maintained deliberately, its shape is specified by somebody other
than the shop, and it survives redesigns.

**Write down what you found in `docs/retailers.md` even if you do not implement
it.** A shop that was analysed and rejected is a fact worth keeping; deleting it
means the next person does the same analysis and reaches the same conclusion.

## 2. Check robots.txt, and mean it

```bash
curl -s https://shop.example/robots.txt
```

The scraper asserts this at the start of every run and refuses to start if the
path it wants is disallowed. That is a real gate, not a gesture.

**If a shop has said no, the answer is no.** Nothing in this repository rotates
proxies, shuffles user agents, replays cookies, solves CAPTCHAs or authenticates.
A retailer that cannot be read politely gets `implemented: false` and a note. See
Kaufland — though note that Kaufland is not blocked, it simply has no product
data to read at all.

## 3. Capture fixtures first

```bash
curl -sL --compressed -A 'FamCartCatalogBot/1.0 (+https://famcart-app.vercel.app)' \
  'https://shop.example/product/123' -o test/fixtures/shop/product-instock.html
gzip -9 test/fixtures/shop/product-instock.html   # HTML pages are stored compressed
```

Capture the *variety*, not one happy example. The ones that have earned their
place here:

- in stock, with a price
- **out of stock** — Lidl's `offers` array has no price at all in this case
- **delisted** — Carrefour 404s, and the parser must return nothing rather than throw
- an own-brand product, whose brand string is unusual
- a product with a barcode and one without
- a slice of the sitemap (50 entries is plenty) and the `robots.txt`

Everything after this point is offline, and CI never touches a shop.

## 4. Write the scraper

```
src/retailers/<slug>/
  index.ts      the RetailerScraper, and the mapping to RetailerProduct
  <mechanism>.ts   parsing, when there is enough of it to separate
```

```ts
export class ShopScraper implements RetailerScraper {
  readonly retailer = 'shop'
  readonly country: Market = 'RO'
  readonly domain = 'shop.example'
  readonly implemented = true

  async *discoverProducts(ctx: ScrapeContext): AsyncGenerator<RetailerProduct> {
    const http = new HttpClient({
      minIntervalMs: ctx.minIntervalMs ?? 1000,
      fetchImpl: ctx.fetchImpl,
    })
    const robots = await fetchRobots((url) => http.get(url), ORIGIN)
    if (!isAllowed(robots, `${ORIGIN}/a-representative-product-url`)) {
      throw new Error('shop robots.txt disallows product pages; refusing to crawl')
    }
    // ...
  }
}
```

Rules that are not negotiable:

- **Never call `fetch` directly.** `HttpClient` is where the rate limit, the
  backoff, the timeout and the circuit breaker live. A scraper that has its own
  transport has its own politeness, which is to say none.
- **Yield, do not collect.** `discoverProducts` is an async generator so a
  60,000-product crawl checkpoints as it goes and a run that dies at hour six has
  imported the first five.
- **Honour `ctx.limit`, `ctx.since`, `ctx.signal` and `ctx.fetchImpl`.** If your
  shop has no modification time, say so in the log rather than silently ignoring
  `--since`.
- **`externalId` must be stable across runs.** If it changes, every run inserts a
  new listing and sweeps the old one, and the catalog churns forever. Prefer the
  id in the URL over a variant-level sku — Lidl's differ.
- **Return `null` rather than guessing.** A null category is findable in the admin
  dashboard; a wrong one is invisible.

If the site is a sitemap plus JSON-LD, use `crawlProductPages` from
`src/core/pageCrawl.ts` and write only the shop-specific parts: which sitemap,
how to read an id out of a URL, how their categories map onto ours.

## 5. Register it

`src/core/registry.ts`:

```ts
import { shop } from '../retailers/shop/index.ts'
export const SCRAPERS: RetailerScraper[] = [auchan, carrefour, lidl, shop, kaufland, megaImage]
```

And a row in `supabase/migrations/002_catalog.sql`:

```sql
insert into public.catalog_retailers (slug, name, country, domain) values
  ('shop', 'Shop', 'RO', 'shop.example')
on conflict (slug) do update set ...
```

**Only add the row if the scraper works.** A row in `catalog_retailers` is a claim
that data can arrive; an unimplemented retailer with a row has listings that could
be swept by a run that can never happen.

`country` must be one of the eleven markets in `src/core/types.ts`. Those are the
markets the app can derive from a phone's timezone, and the check constraint
enforces the same list. `test/registry.test.ts` checks both halves, and the app
repo's `test/catalog/markets.test.js` checks it across the submodule boundary.

## 6. Test it

`test/retailers.test.ts`, against the fixtures:

```ts
it('reads the Product block out of a real page', () => { /* ... */ })
it('handles the out-of-stock case, which has no price', () => { /* ... */ })
it('crawls', async () => {
  const fetchImpl = fixtureFetch([
    { match: '/robots.txt', file: 'shop/robots.txt' },
    { match: 'sitemap', file: 'shop/sitemap-products.xml' },
    { match: '/product/', file: 'shop/product-instock.html.gz' },
  ])
  const products = await collect(
    new ShopScraper().discoverProducts({ log: testLogger(), fetchImpl, limit: 3, minIntervalMs: 0 }),
  )
  expect(products.length).toBe(3)
})
```

`minIntervalMs: 0` is a test seam. The CLI never sets it, so a real run always
uses the polite default.

## 7. Try it for real, carefully

```bash
npm run scrape -- shop --dry-run --limit 5      # no credentials, no writes
npm run scrape -- shop --limit 50               # against a LOCAL database first
npm run scrape -- shop --limit 50               # again: inserted must be 0
```

The second identical run is the test that matters. If it inserts anything, the
`externalId` is not stable and the catalog will churn.

Then check the run landed sensibly:

```sql
select status, products_valid, inserted, unchanged, marked_unavailable, error
  from catalog_scrape_runs order by started_at desc limit 3;
```

A first run for a new retailer has no previous run to compare against, so the
sanity floor does not apply and it will complete. From the second run onward it
does.

## 8. Document it

Add a section to `docs/retailers.md`: the mechanism, the numbers you measured,
and — most usefully — **the limitations**. Every scraper here has some. Writing
them down is what stops somebody later reading a null category as a bug.
