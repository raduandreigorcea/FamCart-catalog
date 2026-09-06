// One line per event, as JSON, on stderr.
//
// stderr rather than stdout because the CLI writes its NDJSON product stream to
// stdout when asked to, and mixing the two would make `scrape auchan --stdout >
// products.ndjson` produce a file that is neither.
//
// JSON rather than prose because a ten-hour Carrefour crawl produces a log
// somebody will want to grep, and "products discovered" is a number worth
// filtering on rather than reading.

import type { Logger } from './types.ts'

export function createLogger(scope: string, quiet = false): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    if (quiet && level === 'info') return
    process.stderr.write(
      JSON.stringify({ t: new Date().toISOString(), level, scope, message, ...fields }) + '\n',
    )
  }
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}

/** For tests and dry runs: keeps everything, prints nothing. */
export function createMemoryLogger(): Logger & { lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = []
  return {
    lines,
    info: (message) => void lines.push({ level: 'info', message }),
    warn: (message) => void lines.push({ level: 'warn', message }),
    error: (message) => void lines.push({ level: 'error', message }),
  }
}
