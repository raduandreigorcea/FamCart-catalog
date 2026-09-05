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
  rejections: Record<string, number>
}

export function emptyTotals(): RunTotals {
  return {
    found: 0, valid: 0, rejected: 0, inserted: 0, updated: 0, unchanged: 0,
    productsCreated: 0, identifiersAdded: 0, conflicts: 0, errors: 0, rejections: {},
  }
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

  constructor(db: CatalogDb, retailer: string, log: Logger, dryRun = false) {
    this.db = db
    this.retailer = retailer
    this.log = log
    this.dryRun = dryRun
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

    const { data, error } = await this.db.rpc('catalog_import_listings', {
      p_rows: rows,
      p_retailer: this.retailer,
      p_run_id: this.runId,
    })

    if (error) {
      // A transport failure is NOT a per-row error: the whole batch is unknown.
      // Counting it as one error would understate it, and carrying on as if the
      // rows landed would let the run close as completed and sweep them.
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

  /** Report progress so a long crawl is legible while it is still running. */
  async heartbeat(): Promise<void> {
    if (this.dryRun || !this.runId) return
    const { error } = await this.db.rpc('catalog_run_progress', {
      p_run_id: this.runId,
      p_products_found: this.totals.found - this.reportedFound,
      p_products_valid: this.totals.valid - this.reportedValid,
      p_products_rejected: this.totals.rejected - this.reportedRejected,
      p_error_count: 0,
      p_stats: { rejections: this.totals.rejections },
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

  /** Close as completed, letting the database decide whether to sweep. */
  async complete(): Promise<Record<string, unknown> | null> {
    await this.flush()
    if (this.dryRun || !this.runId) return null
    await this.heartbeat()

    const { data, error } = await this.db.rpc('catalog_run_complete', { p_run_id: this.runId })
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

  /** Close as failed. Sweeps nothing, by construction. */
  async fail(reason: unknown): Promise<void> {
    const message = reason instanceof Error ? reason.message : String(reason)
    this.log.error('run failed', { retailer: this.retailer, reason: message })
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

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
