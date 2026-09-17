// A scrape run, from open to close, with the database's guarantees respected on
// this side too.
//
// THE ONE RULE THIS FILE MUST NOT BREAK: a run that did not finish must not be
// closed as completed. catalog_run_complete() has its own floor and refuses to
// sweep on an implausible count, but the floor is a backstop for a run that
// finished badly -- it is not a substitute for telling the truth about whether
// the run finished at all. Every abnormal exit here goes through
// catalog_run_fail(), which sweeps nothing by construction.

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RetailerProduct, Logger } from '../core/types.ts'
import { validate } from './validate.ts'
import { isBundle } from '../core/bundles.ts'
import { onEveryResponse } from '../core/http.ts'
import type { ImportRow, RejectReason } from './validate.ts'

/** Rows per catalog_import_listings call. Big enough to be cheap, small enough
 *  that a ten-hour crawl checkpoints often and a failure loses little. */
export const BATCH_SIZE = 100

export interface RunTotals {
  found: number
  valid: number
  rejected: number
  inserted: number
  updated: number
  unchanged: number
  productsCreated: number
  identifiersAdded: number
  conflicts: number
  errors: number
  /** Listings the scraper saw filed outside groceries. */
  excluded: number
  /** What removing them actually removed: listings, and products left with none. */
  purgedListings: number
  purgedProducts: number
  rejections: Record<string, number>
}

export function emptyTotals(): RunTotals {
  return {
    found: 0, valid: 0, rejected: 0, inserted: 0, updated: 0, unchanged: 0,
    productsCreated: 0, identifiersAdded: 0, conflicts: 0, errors: 0,
    excluded: 0, purgedListings: 0, purgedProducts: 0, rejections: {},
  }
}

/**
 * How long to wait before each retry of a batch the database never answered.
 *
 * On 2026-09-13 three of four shops died on a single unanswered batch: Mega
 * Image after 1h50m on `fetch failed`, Auchan on its first batch with `Gateway
 * Timeout`, Carrefour after 52 minutes with the same. The batches themselves
 * averaged 613ms; what failed was the small catalog instance stalling for
 * seconds at a time while it swapped, long enough for PostgREST to give up
 * waiting for a connection. A stall like that passes in well under a minute,
 * and a whole run thrown away for it is two hours of crawling lost.
 *
 * Long rather than snappy on purpose: retrying straight into an instance that
 * is still swapping only adds to its load.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

export interface ScrapeRunOptions {
  /** Injected by tests, which should not wait a minute and a half. */
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
}

export interface CatalogDb {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
}

/**
 * The service-role client. There is NO FALLBACK to the app's credentials, and
 * that is a fix rather than an omission: an earlier version of this repository
 * fell back, which quietly made the production household database the default
 * target of every load, with nothing between it and a service-role write but a
 * hostname printed to the console.
 */
export function connect(env: Record<string, string | undefined> = process.env): SupabaseClient {
  const url = env.CATALOG_SUPABASE_URL
  const key = env.CATALOG_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'CATALOG_SUPABASE_URL and CATALOG_SUPABASE_SERVICE_ROLE_KEY must both be set ' +
        '(put them in .env.scripts). There is deliberately no fallback to the app project.',
    )
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export class ScrapeRun {
  private runId: string | null = null
  private buffer: ImportRow[] = []
  readonly totals = emptyTotals()

  private readonly db: CatalogDb
  private readonly retailer: string
  private readonly log: Logger
  private readonly dryRun: boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly retryDelaysMs: readonly number[]

  constructor(
    db: CatalogDb,
    retailer: string,
    log: Logger,
    dryRun = false,
    options: ScrapeRunOptions = {},
  ) {
    this.db = db
    this.retailer = retailer
    this.log = log
    this.dryRun = dryRun
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS
  }

  async open(): Promise<void> {
    if (this.dryRun) {
      this.log.info('dry run: no run row, no writes', { retailer: this.retailer })
      return
    }
    const { data, error } = await this.db.rpc('catalog_run_open', { p_retailer: this.retailer })
    if (error) throw new Error(`could not open a run for ${this.retailer}: ${describe(error)}`)
    this.runId = String(data)
    this.log.info('run opened', { retailer: this.retailer, run: this.runId })
  }

  /** Validate and buffer one product; flushes when the batch is full. */
  async add(product: RetailerProduct): Promise<void> {
    // A gift set, or a product sold with glasses, a bag or a toy: excluded
    // rather than imported, for every shop, and removed if an earlier run
    // imported it. See core/bundles.ts for why this one rule reads the name.
    if (isBundle(product.name)) {
      await this.exclude(product.externalId)
      return
    }
    this.totals.found++
    const result = validate(product)
    if (!result.ok) {
      this.totals.rejected++
      this.count(result.reason)
      return
    }
    this.totals.valid++
    this.buffer.push(result.row)
    if (this.buffer.length >= BATCH_SIZE) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const rows = this.buffer
    this.buffer = []

    if (this.dryRun) {
      this.log.info('dry run: would import', { rows: rows.length })
      return
    }

    const { data, error } = await this.importBatch(rows)

    if (error) {
      // A transport failure is NOT a per-row error: the whole batch is unknown.
      // Counting it as one error would understate it, and carrying on as if the
      // rows landed would let the run close as completed and sweep them. By the
      // time this throws, importBatch has already retried it; see there.
      throw new Error(`import failed for ${this.retailer}: ${describe(error)}`)
    }

    const result = (data ?? {}) as Record<string, unknown>
    this.totals.inserted += num(result.inserted)
    this.totals.updated += num(result.updated)
    this.totals.unchanged += num(result.unchanged)
    this.totals.productsCreated += num(result.products_created)
    this.totals.identifiersAdded += num(result.identifiers_added)
    this.totals.conflicts += num(result.conflicts)
    this.totals.errors += num(result.error_count)

    const errors = Array.isArray(result.errors) ? result.errors : []
    for (const entry of errors.slice(0, 3)) {
      this.log.warn('row rejected by the importer', entry as Record<string, unknown>)
    }
  }

  /**
   * One batch, retried while the failure is the transport's rather than the
   * database's.
   *
   * SAFE TO RETRY because catalog_import_listings is idempotent: a batch that
   * did land before the answer was lost lands again as `unchanged`. The totals
   * are only ever taken from the answer that arrived, so nothing is counted
   * twice here.
   *
   * An error Postgres itself raised is NOT retried. It carries a SQLSTATE, and
   * the same rows would raise it again; the run should fail on the first one
   * and say why.
   */
  private importBatch(rows: ImportRow[]): Promise<{ data: unknown; error: unknown }> {
    return this.retrying('catalog_import_listings', {
      p_rows: rows,
      p_retailer: this.retailer,
      p_run_id: this.runId,
    })
  }

  /** An RPC, retried the way importBatch describes. */
  private async retrying(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const answer = await this.db.rpc(name, args)
      if (!answer.error || !isTransient(answer.error) || attempt >= this.retryDelaysMs.length) {
        return answer
      }
      const waitMs = this.retryDelaysMs[attempt]
      this.log.warn(`${name} not answered, retrying`, {
        retailer: this.retailer,
        attempt: attempt + 1,
        waitMs,
        error: describe(answer.error),
      })
      await this.sleep(waitMs)
    }
  }

  private excludedBuffer: string[] = []

  /**
   * A listing the shop files outside groceries. It is not imported, and whatever
   * an earlier run imported under that id is removed.
   *
   * POSITIVE EVIDENCE, which is what makes it safe to act on in any run -- a
   * partial one, a failed one -- unlike the sweep, which reads ABSENCE and so
   * needs a run that saw the whole shop. See catalog_purge_listings in 015.
   */
  async exclude(externalId: string): Promise<void> {
    this.totals.excluded++
    this.excludedBuffer.push(externalId)
    if (this.excludedBuffer.length >= BATCH_SIZE) await this.flushExclusions()
  }

  async flushExclusions(): Promise<void> {
    if (this.excludedBuffer.length === 0) return
    const ids = this.excludedBuffer
    this.excludedBuffer = []

    if (this.dryRun) {
      this.log.info('dry run: would remove listings filed outside groceries', { rows: ids.length })
      return
    }

    // Idempotent like the import: a batch whose answer was lost removes nothing
    // the second time, because it already has.
    const { data, error } = await this.retrying('catalog_purge_listings', {
      p_external_ids: ids,
      p_retailer: this.retailer,
    })
    if (error) throw new Error(`removing non-grocery listings failed for ${this.retailer}: ${describe(error)}`)

    const result = (data ?? {}) as Record<string, unknown>
    this.totals.purgedListings += num(result.listings_deleted)
    this.totals.purgedProducts += num(result.products_deleted)
  }

  /** Report progress so a long crawl is legible while it is still running. */
  async heartbeat(): Promise<void> {
    if (this.dryRun || !this.runId) return
    const { error } = await this.db.rpc('catalog_run_progress', {
      p_run_id: this.runId,
      p_products_found: this.totals.found - this.reportedFound,
      p_products_valid: this.totals.valid - this.reportedValid,
      p_products_rejected: this.totals.rejected - this.reportedRejected,
      p_error_count: 0,
      // What the run REMOVED, beside what it rejected. A removals-only run
      // imports nothing, and its row said 0, 0, 0 after deleting thousands:
      // the counts were in the job's log and nowhere the Scrapers page reads.
      p_stats: {
        rejections: this.totals.rejections,
        excluded: this.totals.excluded,
        purged_listings: this.totals.purgedListings,
        purged_products: this.totals.purgedProducts,
      },
    })
    if (error) {
      this.log.warn('progress could not be recorded', { error: describe(error) })
      return
    }
    this.reportedFound = this.totals.found
    this.reportedValid = this.totals.valid
    this.reportedRejected = this.totals.rejected
  }

  private reportedFound = 0
  private reportedValid = 0
  private reportedRejected = 0

  /**
   * Say the crawl is alive, and how many pages it has read since it last said so.
   * Separate from heartbeat() because that one reports IMPORTED products, and a
   * crawl can read for hours without importing one. Never throws: a crawl must
   * not die because the dashboard could not be told it is working.
   */
  async alive(pages: number, progress: RunProgress | null = null): Promise<void> {
    if (this.dryRun || !this.runId) return
    const { error } = await this.db.rpc('catalog_run_alive', {
      p_run_id: this.runId,
      p_pages: pages,
      p_done: progress?.done ?? null,
      p_total: progress?.total ?? null,
      p_unit: progress?.unit ?? null,
    })
    if (error) this.log.warn('sign of life could not be recorded', { error: describe(error) })
  }

  /** Close as completed, letting the database decide whether to sweep. */
  /**
   * @param coveredIndex the run accounted for essentially everything the shop
   *   itself advertised, which makes it authoritative about the shop's size and
   *   exempts it from the delta floor. See catalog_run_complete in 003.
   */
  async complete(coveredIndex = false): Promise<Record<string, unknown> | null> {
    await this.flush()
    await this.flushExclusions()
    if (this.dryRun || !this.runId) return null
    await this.heartbeat()

    const { data, error } = await this.db.rpc('catalog_run_complete', {
      p_run_id: this.runId,
      p_covered_index: coveredIndex,
    })
    if (error) throw new Error(`could not close the run: ${describe(error)}`)
    const verdict = (data ?? {}) as Record<string, unknown>

    if (verdict.status === 'partial') {
      // Not a crash, and worth being loud about anyway: the catalog is now
      // carrying availability that nothing has confirmed since the last good run.
      this.log.error('run refused to sweep', verdict)
    } else {
      this.log.info('run completed', verdict)
    }
    return verdict
  }

  /**
   * Close a run that was never meant to see the whole shop -- `--limit`, or one
   * slice of a sitemap too big for a single job.
   *
   * Sweeps nothing, exactly like fail(). The difference is what somebody reads
   * afterwards: a nightly slice closing as `failed` would put a red row on the
   * dashboard every night, and an alarm that fires nightly is one nobody reads.
   */
  async partial(reason: string): Promise<void> {
    await this.flush()
    await this.flushExclusions()
    this.log.info('run closed as partial', { retailer: this.retailer, reason })
    if (this.dryRun || !this.runId) return
    await this.heartbeat()
    const { error } = await this.db.rpc('catalog_run_partial', {
      p_run_id: this.runId,
      p_reason: reason,
    })
    if (error) this.log.error('could not close the run', { error: describe(error) })
  }

  /** Close as failed. Sweeps nothing, by construction. */
  async fail(reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason)
    this.log.error('run failed', { retailer: this.retailer, reason: message })
    // Exclusions are evidence, not a verdict, so a failed run still acts on the
    // ones it gathered. Best effort: the failure being recorded matters more.
    try {
      await this.flushExclusions()
    } catch (error) {
      this.log.error('could not remove non-grocery listings', { error: describe(error) })
    }
    if (this.dryRun || !this.runId) return
    // Whatever was already imported stays imported. Only the verdict changes.
    const { error } = await this.db.rpc('catalog_run_fail', {
      p_run_id: this.runId,
      p_error: message,
    })
    if (error) this.log.error('could not record the failure', { error: describe(error) })
  }

  private count(reason: RejectReason): void {
    this.totals.rejections[reason] = (this.totals.rejections[reason] ?? 0) + 1
  }
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Whether the database may simply not have been reachable.
 *
 * supabase-js reports a network failure (`TypeError: fetch failed`) and a
 * gateway's non-JSON 504 (`Gateway Timeout`) with no code at all. PostgREST's
 * own "timed out acquiring a connection from the pool" is PGRST003, and 57014
 * is a statement cancelled by its timeout -- both what a stalled instance
 * produces. Anything else with a code is Postgres or PostgREST refusing the
 * request itself, and asking again gets the same refusal.
 */
function isTransient(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code ?? '')
      : ''
  return code === '' || code === 'PGRST003' || code === '57014'
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/**
 * Report a running crawl's sign of life once a minute, for as long as answers
 * keep arriving.
 *
 * A minute in which the transport heard nothing reports nothing, and that
 * silence is the whole point: the Scrapers page reads `last_alive_at`, and a
 * crawl that has stopped hearing back goes quiet there on its own, however long
 * its import count had already stood still for honest reasons. Any answer
 * counts as life, a 404 included -- a shop saying "gone" is a shop answering --
 * but only a good one counts as a page read.
 *
 * Returns a stop function that sends what the last partial minute heard.
 */
/** How far a crawl is through its own plan (ScrapeContext.reportProgress). */
export interface RunProgress {
  done: number
  total: number
  unit: string
}

export function watchLiveness(
  run: ScrapeRun,
  intervalMs = 60_000,
  // The latest the scraper reported, read at each report rather than pushed on
  // every page: a sitemap crawl reports tens of thousands of times a night.
  progress: () => RunProgress | null = () => null,
): () => Promise<void> {
  let heard = 0
  let pages = 0
  const unsubscribe = onEveryResponse((notice) => {
    heard++
    if (notice.ok) pages++
  })

  let pending: Promise<void> = Promise.resolve()
  const report = () => {
    if (heard === 0) return
    const count = pages
    heard = 0
    pages = 0
    const latest = progress()
    // The counters too, once a minute: heartbeat() otherwise only runs every
    // 500 imported products, and a run that removes imports none.
    pending = pending.then(() => run.alive(count, latest)).then(() => run.heartbeat())
  }

  const timer = setInterval(report, intervalMs)
  // A timer must not be the thing keeping a finished crawl's process alive.
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()

  return async () => {
    clearInterval(timer)
    unsubscribe()
    report()
    await pending
  }
}
