// scrape <retailer|all> [--dry-run] [--limit N] [--since ISO] [--ndjson] [--quiet]
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
import { ScrapeRun, connect } from '../importer/run.ts'
import type { CatalogDb } from '../importer/run.ts'
import type { RetailerScraper } from '../core/types.ts'
import { loadEnvFiles } from './env.ts'

interface Args {
  target: string
  dryRun: boolean
  ndjson: boolean
  quiet: boolean
  limit?: number
  since?: Date
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
  const sinceRaw = flag('since')
  const since = sinceRaw ? new Date(sinceRaw) : undefined
  if (since && Number.isNaN(since.getTime())) {
    throw new Error(`--since is not a date: ${sinceRaw}`)
  }

  return {
    target: positional[0] ?? 'all',
    dryRun: argv.includes('--dry-run'),
    ndjson: argv.includes('--ndjson'),
    quiet: argv.includes('--quiet'),
    limit: limitRaw ? Number(limitRaw) : undefined,
    since,
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

  try {
    await run.open()

    let sinceLastBeat = 0
    for await (const product of scraper.discoverProducts({
      limit: args.limit,
      since: args.since,
      log,
      signal: controller.signal,
      reportIncomplete: (reason) => {
        incomplete ??= reason
      },
    })) {
      if (args.ndjson) process.stdout.write(JSON.stringify(product) + '\n')
      await run.add(product)
      if (++sinceLastBeat >= 500) {
        await run.heartbeat()
        sinceLastBeat = 0
      }
    }

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
    // `--limit` is not incomplete in this sense. It is a deliberate partial run
    // and the scrapers do not report it, but it must not sweep either, which is
    // why a limited run is only ever pointed at a local database.
    if (incomplete !== null) {
      throw new Error(`crawl ended early: ${incomplete}`)
    }

    const verdict = await run.complete()
    log.info('done', {
      retailer: scraper.retailer,
      durationMs: Date.now() - started,
      ...run.totals,
      verdict: verdict?.status ?? (args.dryRun ? 'dry-run' : 'unknown'),
    })
    return true
  } catch (error) {
    await run.fail(error)
    log.error('failed', {
      retailer: scraper.retailer,
      durationMs: Date.now() - started,
      ...run.totals,
    })
    return false
  } finally {
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
