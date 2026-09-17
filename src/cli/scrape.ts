// scrape <retailer|all> [--dry-run] [--limit N] [--since ISO] [--shard i/n]
//                        [--ndjson] [--quiet]
//
// The one entry point for filling the catalog. It opens a run, streams products
// from the retailer's generator into batched imports, and closes the run --
// completed if the crawl finished, failed if anything went wrong, and never the
// other way round.
//
// SIGNALS ARE HANDLED, and that is not politeness to the operator. Ctrl-C during
// a ten-hour Carrefour crawl must leave a run marked `failed`, because a run
// left `running` looks like a run still in progress and a run marked `completed`
// would sweep two thirds of the catalog on the strength of a third of a crawl.

import process from 'node:process'
import { createLogger } from '../core/logger.ts'
import { SCRAPERS, scraperFor, IMPLEMENTED } from '../core/registry.ts'
import { ScrapeRun, connect, BATCH_SIZE, watchLiveness } from '../importer/run.ts'
import type { RunProgress } from '../importer/run.ts'
import type { CatalogDb } from '../importer/run.ts'
import type { RetailerScraper } from '../core/types.ts'
import { loadEnvFiles } from './env.ts'
import { loadSeenSince } from '../importer/seen.ts'

interface Args {
  target: string
  dryRun: boolean
  ndjson: boolean
  quiet: boolean
  limit?: number
  since?: Date
  shard?: { index: number; of: number }
  /** Carrefour's cleanup: read only what may be removed (see the scraper). */
  removalsOnly: boolean
  /** Carrefour's nightly run: the grocery departments only (see the scraper). */
  groceriesOnly: boolean
  /** The grocery pass to trust: listings seen since then are groceries. */
  groceriesSince?: Date
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flag = (name: string): string | undefined => {
    const withEquals = argv.find((a) => a.startsWith(`--${name}=`))
    if (withEquals) return withEquals.slice(name.length + 3)
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }

  const limitRaw = flag('limit')
  const shardRaw = flag('shard')
  const sinceRaw = flag('since')
  const since = sinceRaw ? new Date(sinceRaw) : undefined
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`--since is not a date: ${sinceRaw}`)
  }

  // `--shard 2/5` is the third of five slices. One-based on the way in because
  // that is how a person counts nights, zero-based inside because that is how
  // the modulo works -- so the parsing happens once, here, and is checked
  // rather than trusted: a slice index past the end silently crawls nothing,
  // which would look exactly like a shop that had stopped answering.
  let shard: { index: number; of: number } | undefined
  if (shardRaw) {
    const [indexRaw, ofRaw] = shardRaw.split('/')
    const index = Number(indexRaw)
    const of = Number(ofRaw)
    if (!Number.isInteger(index) || !Number.isInteger(of) || of < 1 || index < 1 || index > of) {
      throw new Error(`--shard must be i/n with 1 <= i <= n, got: ${shardRaw}`)
    }
    shard = { index: index - 1, of }
  }

  const removalsOnly = argv.includes('--removals-only')
  const groceriesRaw = flag('groceries-since')
  const groceriesSince = groceriesRaw ? new Date(groceriesRaw) : undefined
  if (groceriesSince && Number.isNaN(groceriesSince.getTime())) {
    throw new Error(`--groceries-since is not a date: ${groceriesRaw}`)
  }
  // Refused here rather than defaulted: the date is what decides what counts as
  // groceries, and a default would be a guess about the one thing that must not
  // be guessed.
  if (removalsOnly && !groceriesSince) {
    throw new Error('--removals-only needs --groceries-since: when the grocery pass it trusts started')
  }
  if (removalsOnly && positional[0] !== 'carrefour') {
    throw new Error('--removals-only is for Carrefour alone: no other shop needs it')
  }

  const groceriesOnly = argv.includes('--groceries-only')
  if (groceriesOnly && positional[0] !== 'carrefour') {
    throw new Error('--groceries-only is for Carrefour alone: no other shop needs it')
  }
  if (groceriesOnly && removalsOnly) {
    throw new Error('--groceries-only and --removals-only read opposite halves; pick one')
  }

  return {
    removalsOnly,
    groceriesOnly,
    groceriesSince,
    target: positional[0] ?? 'all',
    dryRun: argv.includes('--dry-run'),
    ndjson: argv.includes('--ndjson'),
    quiet: argv.includes('--quiet'),
    limit: limitRaw ? Number(limitRaw) : undefined,
    since,
    shard,
  }
}

async function scrapeOne(
  scraper: RetailerScraper,
  db: CatalogDb | null,
  args: Args,
): Promise<boolean> {
  const log = createLogger(scraper.retailer, args.quiet)

  if (!scraper.implemented) {
    // Named, not skipped. A retailer that cannot be read is a fact about the
    // catalog, and a silent skip is how it stops being one.
    log.warn('no scraper: this retailer was analysed and cannot be read', { note: scraper.note })
    return true
  }

  // The known groceries, loaded -- and refused if implausibly few -- before a run
  // row exists, so a bad date costs nothing but the error.
  let removalsOnly: { groceryIds: ReadonlySet<string> } | undefined
  if (args.removalsOnly && args.groceriesSince) {
    const url = process.env.CATALOG_SUPABASE_URL
    const key = process.env.CATALOG_SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('--removals-only needs CATALOG_SUPABASE_URL and CATALOG_SUPABASE_SERVICE_ROLE_KEY')
    const groceryIds = await loadSeenSince({ url, key }, scraper.retailer, args.groceriesSince)
    log.info('known groceries loaded', { since: args.groceriesSince.toISOString(), ids: groceryIds.size })
    removalsOnly = { groceryIds }
  }

  const run = new ScrapeRun(db as CatalogDb, scraper.retailer, log, args.dryRun || !db)
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const started = Date.now()
  // Set by the scraper when it stops before it has seen everything. A generator
  // that ends early is indistinguishable from one that finished -- both just stop
  // yielding -- so this is the only thing standing between "the shop stopped
  // answering after a sixth of its catalog" and a run marked `completed`.
  let incomplete: string | null = null

  // How much of the shop's own index the crawl accounted for. The delta floor
  // cannot tell a shop that shrank from a scraper that broke -- both report half
  // of last week -- and this is what can: a crawl that read everything the shop
  // advertised is authoritative about the shop's size. Below the bar, or not
  // reported at all, the run falls back to the floor.
  let coverage: { seen: number; advertised: number } | null = null

  // Reported by the scraper and handed to the importer: between products, and
  // from inside the report itself once a batch has piled up. The second is for a
  // crawl that reads for hours without yielding a product -- Carrefour's
  // departments outside groceries -- which would otherwise hold every removal
  // until its end, and lose all of them to a job killed at its time limit.
  const excluded: string[] = []
  const drainExcluded = async (): Promise<void> => {
    for (const id of excluded.splice(0)) await run.exclude(id)
  }

  // The sign of life, once a minute while the shop keeps answering. Stopped as
  // soon as the crawl ends, while the run is still open to receive it: a run
  // that has been closed ignores it.
  let stopLiveness: (() => Promise<void>) | null = null
  let progress: RunProgress | null = null

  try {
    await run.open()
    stopLiveness = watchLiveness(run, 60_000, () => progress)

    let sinceLastBeat = 0
    for await (const product of scraper.discoverProducts({
      limit: args.limit,
      since: args.since,
      shard: args.shard,
      log,
      signal: controller.signal,
      removalsOnly,
      groceriesOnly: args.groceriesOnly,
      reportIncomplete: (reason) => {
        incomplete ??= reason
      },
      reportProgress: (done, total, unit) => {
        progress = { done, total, unit }
      },
      reportCoverage: (seen, advertised) => {
        coverage = { seen, advertised }
      },
      reportExcluded: (id) => {
        excluded.push(id)
        return excluded.length >= BATCH_SIZE ? drainExcluded() : undefined
      },
    })) {
      if (args.ndjson) process.stdout.write(JSON.stringify(product) + '\n')
      await run.add(product)
      await drainExcluded()
      if (++sinceLastBeat >= 500) {
        await run.heartbeat()
        sinceLastBeat = 0
      }
    }
    await drainExcluded()
    await stopLiveness()
    stopLiveness = null

    if (controller.signal.aborted) {
      // The generator stops cleanly on abort, so without this check an
      // interrupted crawl would look like a finished one.
      throw new Error('interrupted before the crawl finished')
    }

    // A crawl that stopped short did not finish, whatever it managed to import.
    // Closing it as failed keeps everything it DID see -- imports are never
    // rolled back -- while making certain it can never sweep, and keeping it out
    // of the count the next run's sanity floor is measured against. That second
    // part is the one that bites: a truncated run recorded as `completed`
    // silently becomes the baseline that the next truncated run looks healthy
    // against.
    //
    // A TRUNCATED CRAWL AND A DELIBERATELY PARTIAL ONE ARE DIFFERENT EVENTS.
    // Both refuse to sweep, so the catalog ends up identical either way -- but
    // one is a shop that stopped answering and wants somebody to look, and the
    // other is Monday.
    //
    // The truncated case wins whenever both are true: a slice whose circuit
    // also opened is a slice that did not even finish its slice, and calling
    // that "Monday" would hide it.
    if (incomplete !== null) {
      throw new Error(`crawl ended early: ${incomplete}`)
    }

    // `--limit` and `--shard` are deliberate partial runs, and neither may
    // sweep. A comment used to say so about --limit and nothing enforced it,
    // which made "only point a limited run at a local database" a rule somebody
    // had to remember at 2am. A limited run against the real catalog would have
    // completed, cleared the floor easily, and marked everything it did not
    // reach as no longer sold.
    const deliberate = args.groceriesOnly
      ? 'groceries only, by design: the departments outside groceries hold nothing to import'
      : args.removalsOnly
      ? `removals only${args.shard ? `, slice ${args.shard.index + 1}/${args.shard.of}` : ''}: trusted the grocery pass of ${args.groceriesSince?.toISOString()}`
      : args.shard
      ? `--shard ${args.shard.index + 1}/${args.shard.of}: one slice of the shop, by design`
      : args.limit !== undefined
        ? `--limit ${args.limit}: a deliberate partial run`
        : null

    if (deliberate !== null) {
      await run.partial(deliberate)
      log.info('done', {
        retailer: scraper.retailer,
        durationMs: Date.now() - started,
        ...run.totals,
        verdict: args.dryRun ? 'dry-run' : 'partial',
      })
      // Exit 0. This is the expected outcome of a scheduled slice, so a runner
      // that painted it red would train everybody to ignore a red run.
      return true
    }

    // Nineteen in twenty, the same bar the Carrefour crawl holds itself to. Not
    // a round hundred: a handful of pages fail on any large crawl, and demanding
    // perfection would mean the exemption never applied to the shops that need
    // it most.
    const covered = coverage as { seen: number; advertised: number } | null
    const coveredIndex = covered !== null && covered.advertised > 0 && covered.seen / covered.advertised >= 0.95
    if (covered !== null) {
      log.info('index coverage', {
        seen: covered.seen,
        advertised: covered.advertised,
        percent: Math.round((covered.seen / covered.advertised) * 1000) / 10,
        authoritative: coveredIndex,
      })
    }

    const verdict = await run.complete(coveredIndex)
    log.info('done', {
      retailer: scraper.retailer,
      durationMs: Date.now() - started,
      ...run.totals,
      verdict: verdict?.status ?? (args.dryRun ? 'dry-run' : 'unknown'),
    })
    return true
  } catch (error) {
    // What was reported before the failure is still evidence; run.fail removes it.
    try {
      await drainExcluded()
      await stopLiveness?.()
      stopLiveness = null
    } catch {
      // run.fail below records the failure either way.
    }
    await run.fail(error)
    log.error('failed', {
      retailer: scraper.retailer,
      durationMs: Date.now() - started,
      ...run.totals,
    })
    return false
  } finally {
    // Only still set if something above threw before it could be stopped; the
    // timer must not outlive the run either way.
    void stopLiveness?.()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function main(): Promise<void> {
  loadEnvFiles()
  const args = parseArgs(process.argv.slice(2))

  const targets =
    args.target === 'all'
      ? SCRAPERS
      : (() => {
          const found = scraperFor(args.target)
          if (!found) {
            const known = SCRAPERS.map((s) => s.retailer).join(', ')
            throw new Error(`unknown retailer "${args.target}". Known: ${known}`)
          }
          return [found]
        })()

  // A dry run needs no credentials at all, which is what makes
  // `scrape auchan --dry-run --limit 5` a safe first thing to try in a fresh
  // clone.
  const db = args.dryRun ? null : connect()

  let allOk = true
  for (const scraper of targets) {
    // Sequential on purpose. Running three crawls at once triples the load on
    // three different shops for no gain -- nothing here is waiting on us.
    const ok = await scrapeOne(scraper, db as unknown as CatalogDb, args)
    allOk = allOk && ok
  }

  if (!allOk) process.exitCode = 1
  if (args.target === 'all') {
    createLogger('scrape', args.quiet).info('all retailers attempted', {
      implemented: IMPLEMENTED.length,
      total: SCRAPERS.length,
    })
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', scope: 'scrape', message: String(error) }) + '\n',
  )
  process.exitCode = 1
})
