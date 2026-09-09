// One function, one file.
//
// THIS TEST EXISTS BECAUSE THE ALTERNATIVE FAILS SILENTLY. A function defined in
// two migrations is not a duplicate, it is a race: `supabase db push` applies
// files in order and `create or replace` means whichever ran last is what the
// database has. A fresh build always gets the highest-numbered one, so the local
// suite is green either way; production gets whatever the last push touched.
//
// It has already cost something. catalog_run_open was written in 003 and
// replaced in 007 to call the reap. A later re-push of 003 -- for an unrelated
// change to a different function in the same file -- put the un-wired body back
// in production, and nothing failed: runs still opened, they just stopped being
// closed when a process was killed. Six Carrefour runs sat `running`, the oldest
// for three days.
//
// The same trap was one push away from search_catalog, catalog_shops_for and
// bump_product_popularity, all of which 009 rewrote while 005 and 008 still held
// the old bodies. There the symptom would have been "the search got slow again",
// with nothing in the repository to say why.
//
// A grep, not a database: the point is to catch it in CI, before either version
// is pushed anywhere.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows the latter yields '/D:/...',
// which readdirSync then resolves against the drive it is already on.
const DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
const FUNCTION = /^create\s+or\s+replace\s+function\s+(public\.[a-z0-9_]+)\s*\(/gim

function definitionsByFunction(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const [, name] of sql.matchAll(FUNCTION)) {
      // Keyed by name alone rather than by name and arguments. An overload is
      // exactly as dangerous: PostgREST resolves an RPC by the argument names in
      // the request body, and two candidates matching one body is a 300 rather
      // than a choice.
      const files = found.get(name) ?? []
      if (!files.includes(file)) files.push(file)
      found.set(name, files)
    }
  }
  return found
}

describe('the migrations', () => {
  it('define each function in exactly one file', () => {
    const repeated = [...definitionsByFunction()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} is defined in ${files.join(' and ')}`)

    expect(repeated).toEqual([])
  })

  it('are numbered without a gap or a repeat, since order is what push relies on', () => {
    const numbers = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => Number(f.slice(0, 3)))
      .sort((a, b) => a - b)

    expect(numbers).toEqual(numbers.map((_, i) => i))
  })
})
