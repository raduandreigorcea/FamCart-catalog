// A run's log, shipped to the catalog while the run is still going.
//
// The admin's run page shows it live (catalog 023, catalog_run_logs). Lines are
// queued as they are written and sent every two seconds or every hundred lines,
// whichever comes first: a line a second, instantly, would be a request a
// second for hours, and two seconds is live enough to watch a crawl by.
//
// THE RULE: this never throws. A crawl that has read for four hours must not
// die because the dashboard's copy of its log could not be written. A batch
// that fails is retried once and then dropped, with one line to stderr --
// written directly, not through the logger, because the logger feeds this and
// a failure reported through it would queue another line to fail.
//
// Lines written before the run has an id (the known-groceries load, say) wait
// in the queue and go out once attach() names the run.

import type { CatalogDb } from './run.ts'
import type { LogLine } from '../core/logger.ts'

export const LOG_BATCH = 100
export const LOG_INTERVAL_MS = 2_000
/**
 * Info lines kept per run. A night's normal crawl writes a few hundred; the cap
 * is for the bad night where a line per failed page would fill a free-plan
 * database. Warnings and errors are never capped: they are what the page is for.
 */
export const MAX_INFO_LINES = 5_000

export class RunLogShipper {
  private runId: string | null = null
  private queue: LogLine[] = []
  private infoKept = 0
  private infoDropped = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private sending: Promise<void> = Promise.resolve()
  private complained = false
  private readonly db: CatalogDb
  private readonly intervalMs: number
  private readonly maxInfo: number

  constructor(db: CatalogDb, options: { intervalMs?: number; maxInfo?: number } = {}) {
    this.db = db
    this.intervalMs = options.intervalMs ?? LOG_INTERVAL_MS
    this.maxInfo = options.maxInfo ?? MAX_INFO_LINES
  }

  push(line: LogLine): void {
    if (line.level === 'info') {
      if (this.infoKept >= this.maxInfo) {
        this.infoDropped++
        return
      }
      this.infoKept++
    }
    this.queue.push(line)
    if (this.runId && this.queue.length >= LOG_BATCH) void this.send()
  }

  attach(runId: string): void {
    this.runId = runId
    this.timer = setInterval(() => void this.send(), this.intervalMs)
    // The timer must not be what keeps a finished crawl's process alive.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref()
    void this.send()
  }

  /** Stop the timer and send everything left, the drop count included. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.infoDropped > 0) {
      this.queue.push({
        t: new Date().toISOString(),
        level: 'warn',
        scope: 'run-log',
        message: `${this.infoDropped} info lines were not kept: a run keeps at most ${this.maxInfo}`,
      })
      this.infoDropped = 0
    }
    await this.send()
  }

  // Chained, so two sends never interleave and lines arrive in order.
  private send(): Promise<void> {
    this.sending = this.sending.then(() => this.drain())
    return this.sending
  }

  private async drain(): Promise<void> {
    while (this.runId && this.queue.length) {
      const lines = this.queue.splice(0, LOG_BATCH)
      if (!(await this.ship(lines)) && !(await this.ship(lines)) && !this.complained) {
        this.complained = true
        process.stderr.write(
          JSON.stringify({
            t: new Date().toISOString(),
            level: 'warn',
            scope: 'run-log',
            message: 'log lines could not be sent to the catalog; the run page will be missing some',
          }) + '\n',
        )
      }
    }
  }

  private async ship(lines: LogLine[]): Promise<boolean> {
    try {
      const { error } = await this.db.rpc('catalog_run_log', { p_run_id: this.runId, p_lines: lines })
      return !error
    } catch {
      return false
    }
  }
}
