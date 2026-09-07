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
