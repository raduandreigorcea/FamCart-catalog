// import <retailer> <file.ndjson>
//
// Replay a captured crawl into the database, without touching the shop.
//
// The reason this exists: a full Carrefour crawl is ten hours of somebody else's
// bandwidth, and the parts most likely to need fixing -- the matching, the
// quantity parser, the category mapping -- are all downstream of it. Capture
// once with `scrape carrefour --ndjson --dry-run > carrefour.ndjson`, then
// iterate against the file as often as you like.
//
// It goes through the same ScrapeRun as a live crawl, so it opens a run, imports
// in batches, and closes it under the same rules. A replay that dies halfway
// leaves a failed run and sweeps nothing, exactly like a crawl that does.

import process from 'node:process'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createLogger } from '../core/logger.ts'
import { scraperFor } from '../core/registry.ts'
import { ScrapeRun, connect } from '../importer/run.ts'
import type { CatalogDb } from '../importer/run.ts'
import type { RetailerProduct } from '../core/types.ts'
import { loadEnvFiles } from './env.ts'

async function main(): Promise<void> {
  loadEnvFiles()
  const [retailer, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const dryRun = process.argv.includes('--dry-run')

  if (!retailer || !file) {
    throw new Error('usage: import <retailer> <file.ndjson> [--dry-run]')
  }
  if (!scraperFor(retailer)) {
    throw new Error(`unknown retailer "${retailer}"`)
  }

  const log = createLogger(`import:${retailer}`)
  const db = dryRun ? null : connect()
  const run = new ScrapeRun(db as unknown as CatalogDb, retailer, log, dryRun || !db)

  await run.open()
  let lines = 0
  let malformed = 0

  try {
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of reader) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lines++
      let product: RetailerProduct
      try {
        product = JSON.parse(trimmed) as RetailerProduct
      } catch {
        // One unparseable line is one product, the same way one bad row is one
        // row inside the SQL importer.
        malformed++
        continue
      }
      // The file says which retailer it came from; the argument is what the run
      // was opened for. A mismatch would import Lidl's products as Auchan's and
      // then sweep the real Auchan catalog for not containing them.
      if (product.retailer && product.retailer !== retailer) {
        throw new Error(
          `line ${lines} is a ${product.retailer} product but this run is for ${retailer}`,
        )
      }
      await run.add(product)
    }

    const verdict = await run.complete()
    log.info('replay finished', { lines, malformed, ...run.totals, verdict: verdict?.status })
  } catch (error) {
    await run.fail(error)
    throw error
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', scope: 'import', message: String(error) }) + '\n',
  )
  process.exitCode = 1
})
