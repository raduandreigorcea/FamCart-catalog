# FamCart Catalog

A catalog of what real shops actually sell.

FamCart is a shopping list. When somebody types `lapte`, the useful answer is the
milk they can pick up this afternoon at a shop near them -- not a milk-shaped
concept, and not a product that exists in a database somewhere in the world.

So this catalog is built from retailer data and nothing else. A row is here
because a configured shop listed it, or because a fixture put it here for a test.
There is no third way in.

## What replaced what

The previous version of this repository grew a catalog from Open Food Facts: a
curated seed of generic "concepts", plus an edge function that queried three
external food databases live, on the keystroke path, whenever somebody typed
something it did not know.

It answered a question nobody was asking. Searching `beer` returned strawberries
and blueberries, because the German for berries contains the substring -- and
there was no beer, because nobody had contributed any. The catalog knew what
products *exist*; it did not know what you can *buy*.

None of that is here any more: no concepts, no discovery, no search cache, no
Open Food Facts, Open Products Facts or Open Beauty Facts.

## The shape of it

```
retailer site  →  scraper  →  RetailerProduct  →  validation  →  importer  →  catalog  →  FamCart
```

```
src/core/         transport, robots, sitemaps, JSON-LD, the fold, the registry
src/retailers/    one directory per shop; the only shop-specific code there is
src/importer/     validation, batching, the scrape run lifecycle
src/cli/          scrape and import
supabase/         six migrations and five pgTAP suites
test/             135 assertions, all against fixtures captured from live sites
```

## The retailers

| Shop | How | Products | GTIN | Price |
|---|---|---|---|---|
| **Auchan** | public VTEX catalog API | ~60,000 | yes, most | yes |
| **Carrefour** | sitemap → page JSON-LD | ~85,000 | **never** | yes |
| **Lidl** | sitemap → page JSON-LD | 511 | about a third | in stock only |
| Kaufland | -- | -- | -- | -- |
| Mega Image | -- | -- | -- | -- |

Kaufland has no online assortment to read, and Mega Image is readable but
deliberately deferred. `docs/retailers.md` records exactly what was probed for
each, so nobody has to work it out again.

## The two rules everything else follows from

**Price and availability belong to a listing, not to a product.** Three shops sell
the same water at three prices and all three are right. `catalog_products` holds
identity; `catalog_listings` holds what one shop currently says. A price on the
product would mean the last scraper to finish decides what everything costs, and
one shop dropping a line would take it off every shelf at once.

**Only a run that finished, and finished plausibly, may decide a product is
gone.** A scraper that dies halfway has seen a fraction of a shop. If "I did not
see it" meant "it is gone", every timeout would wipe a retailer. So imports only
ever say *I saw this, now*; the sweep that says *and therefore not these* happens
once, at the end, and only if the run earned it -- it refuses on zero products,
and it refuses when a run found less than half of what the last good one found.

This is not hypothetical. Auchan returned 429 on two endpoints while this was
being written, and the first live Lidl run read its sitemap as zero URLs. Both
were caught, both swept nothing, and the catalog was undamaged in both cases.

## Matching

In order, and nothing below it:

1. **GTIN.** The only merge to fully trust.
2. **A listing we already recorded** -- `(retailer, their id)`. A fact, not a guess.
   Note what it is *not*: their id identifies a listing, never a product across
   shops.
3. **The merge key**: folded brand, folded name with the size removed, and the
   size canonicalised. `Coca-Cola Zero 1,5 L` and `Coca Cola zero 1.5l` are one
   product. `Coca Cola Zero 500ml` is a different one -- the size is *in* the key,
   not a tie-break.
4. **Nothing else.** No trigram merging, no similarity threshold, no "close
   enough". Two rows for one product is cosmetic; one row for two products is
   corrupt.

When a listing that we have known as product X starts reporting product Y's
barcode, both keep what they had and the row is counted as a conflict. Following
the barcode would silently move a listing onto another product, and it would
happen again every run.

**The honest cost:** Carrefour publishes no GTIN at all, so a Carrefour listing
merges with another shop's only when the names and sizes fold identically. Often
they will not. Those stay two products. That is the trade, and the tests pin it
so nobody "fixes" it with a fuzzy merge later.

## What the app calls

Three RPCs, and **their names and argument names are a cross-repository
contract** -- PostgREST resolves by argument name, so a rename breaks the app
silently:

```
search_catalog(p_query, p_limit, p_markets, p_langs, p_fuzzy)
lookup_barcode(p_codes, p_langs)
bump_product_popularity(p_name, p_maker)
```

`p_markets` **filters**: a phone in Germany gets nothing from here, because it
cannot buy any of this. `p_langs` is accepted and ignored -- every product here is
Romanian. `p_fuzzy` is off by default, because an empty result now means "no shop
we read lists this", which is true and useful.

## Commands

```bash
npm run scrape:lidl              # 511 products, the cheapest real run
npm run scrape:auchan
npm run scrape:carrefour
npm run scrape:all               # sequential; naming the two it cannot read

npm test                         # 135 assertions, no network
npm run typecheck
npm run db:test                  # reset, then 181 pgTAP assertions
```

Flags: `--dry-run` (no credentials needed, no writes), `--limit N`,
`--since 2026-09-01`, `--shard i/n`, `--ndjson` (stream products to stdout),
`--quiet`.

`--limit` and `--shard` are deliberate partial runs. Both close the run as
`partial` and neither may sweep -- a run that saw a fifth of a shop has no
standing to say the other four fifths are gone. That is enforced in the CLI, not
left as a rule to remember.

Capture once and iterate offline, which is how you avoid re-crawling Carrefour
for a day to test a parser change:

```bash
npm run scrape -- carrefour --ndjson --dry-run > carrefour.ndjson
npm run import -- carrefour carrefour.ndjson
```

## Scraping on a schedule

`.github/workflows/scrape.yml`, nightly at 01:20 UTC, and dispatchable by hand.
Two secrets on this repository, the same pair `.env.scripts` holds:
`CATALOG_SUPABASE_URL` and `CATALOG_SUPABASE_SERVICE_ROLE_KEY`.

| Shop | When | Closes as | Sweeps |
|---|---|---|---|
| Lidl | nightly, whole shop | `completed` | yes |
| Auchan | nightly, whole shop | `completed` | yes |
| Carrefour | Mon-Fri, one fifth each | `partial` | **no** |

**Carrefour is sliced because of politeness, not machine time.** 85,000 product
pages at one request a second is a day, and a job gets six hours -- but running
five slices at once would simply mean five requests a second at one shop. So the
slices run on different nights, the shop sees the trickle it always did, and the
whole catalogue is covered every five days.

The cost, stated plainly: **nothing at Carrefour is ever marked unavailable.** A
delisted product goes stale rather than absent, and `last_seen_at` is what tells
those apart.

There is no full run available to put that right. A hosted job is capped at six
hours and reading all 85,000 pages politely is about twenty-four, so the
workflow refuses a blank shard rather than spending five and a half hours
arriving at the same place. `--since` does not rescue it: an incremental run
skips the pages the shop has not touched, and a page not fetched is a listing
not touched, which the sweep would read as absent.

The way out, when it matters enough, is that the sitemap is the shop's own
complete statement of what exists and it arrives in one request -- a "seen these
ids" call against it would sweep without crawling anything.

CI still never scrapes. This is a separate workflow; `ci.yml` runs off committed
fixtures so a shop being slow or redesigned cannot turn a build red.

## Credentials

`.env.scripts`, at the app repo root or here:

```
CATALOG_SUPABASE_URL=
CATALOG_SUPABASE_SERVICE_ROLE_KEY=
```

There is **no fallback** to the app project's credentials. That is a fix, not an
omission: an earlier version fell back, which quietly made the production
household database the default target of every load.

## Adding a retailer

`docs/adding-a-retailer.md`. Short version: analyse the site before writing
anything, add a directory under `src/retailers/`, add a line to
`src/core/registry.ts` and a row to `002_catalog.sql`. Nothing in the pipeline
changes.
