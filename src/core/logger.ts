// One line per event, as JSON, on stderr.
//
// stderr rather than stdout because the CLI writes its NDJSON product stream to
// stdout when asked to, and mixing the two would make `scrape auchan --stdout >
// products.ndjson` produce a file that is neither.
//
// JSON rather than prose because a ten-hour Carrefour crawl produces a log
// somebody will want to grep, and "products discovered" is a number worth
// filtering on rather than reading.
//
// A SINK, optionally, beside stderr: the scrape CLI hands every line to the
// run's log shipper (importer/runLog.ts), which sends it to the catalog so the
// admin's run page can show it live. The sink sees info lines even under
// --quiet, because quiet is about the terminal, not about the record.

import type { Logger } from './types.ts'

export interface LogLine {
  t: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
  fields?: Record<string, unknown>
}

export function createLogger(scope: string, quiet = false, sink?: (line: LogLine) => void): Logger {
  const write = (level: LogLine['level'], message: string, fields?: Record<string, unknown>): void => {
    const t = new Date().toISOString()
    sink?.({ t, level, scope, message, fields })
    if (quiet && level === 'info') return
    process.stderr.write(JSON.stringify({ t, level, scope, message, ...fields }) + '\n')
  }
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}
