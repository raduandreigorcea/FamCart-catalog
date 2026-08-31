#!/usr/bin/env node
// Run discovery for every word the catalog already knows.
//
//   node catalog/scripts/warm.mjs --dry-run        what would be asked, nothing called
//   node catalog/scripts/warm.mjs                  the project named by .env.scripts
//   node catalog/scripts/warm.mjs --local          the local stack
//   node catalog/scripts/warm.mjs --limit 20       stop after 20 queries
//   node catalog/scripts/warm.mjs --langs ro,en    only these languages
//
// ─── what this is, and what it is not ────────────────────────────────────────
//
// It is NOT a bulk import. Nothing enters the catalog here that a person typing
// the same word into the app would not have brought in: the same edge function,
// the same relevance filter, the same quality gate, the same cap, the same
// cache. The only difference is who typed it.
//
// It exists because the growth mechanism is demand-driven and demand had not
// arrived. Discovery had run for thirteen words, eleven of which were tests, so
// a catalog designed to fill itself from real searches was sitting at 549 rows
// with 240 concepts nobody had ever asked about. Warming is how the first
// person to search "detergent" gets a useful answer instead of paying for the
// round trip that makes it useful for the second.
//
// ─── which words ─────────────────────────────────────────────────────────────
//
// The labels and synonyms of BRANDED and MIXED concepts, in every language they
// are recorded in. Generic concepts are skipped on purpose: nobody typing
// "morcovi" wants a brand of carrot, and asking an external database for one
// fills produce with noise nobody will ever pick. That is the same judgement
// isLocalSufficient makes on the keystroke path, applied here.
//
// ─── local: [] is deliberate ─────────────────────────────────────────────────
//
// Every call claims the local catalog answered nothing, which forces the
// external fetch for every word. That looks like it defeats the point of the
// sufficiency gate and is exactly what warming is for: the gate asks "is this
// worth a round trip a person is waiting on", and here nobody is waiting. It
// also earns the cold cap (20 rather than 8) for single-word queries, which is
// the whole reason to do this ahead of time rather than one keystroke at a time.
//
// Nothing is written twice: catalog_import_products resolves by barcode and by
// folded name, so a product two languages both find lands once.
//
// ─── it is resumable for free ────────────────────────────────────────────────
//
// A query that has already been warmed comes back `cached-hit` or `cached-miss`
// without touching the network, so re-running after an interruption costs a
// round trip per word and no external calls at all.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const envCandidates = [join(here, '..', '..', '.env.scripts'), join(here, '..', '.env.scripts')]

const argv = process.argv.slice(2)
const args = new Set(argv)
const dryRun = args.has('--dry-run')
const local = args.has('--local')
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const limit = Number(valueOf('--limit', '0')) || 0
const langs = valueOf('--langs', 'en,ro,de,fr,it,es').split(',').map((l) => l.trim())

// Open Food Facts asks callers to be reasonable rather than fast, and each of
// these queries fans out to three of their services at once. One request every
// second and a half is slower than any human typing and finishes the whole
// vocabulary inside an hour.
const DELAY_MS = 1500

// The market to claim per language. It is a RANKING hint and never a filter --
// search_catalog demotes a non-matching market, it does not hide it -- so this
// only decides which country's products sort first in what gets kept.
const MARKET_FOR = { en: 'GB', ro: 'RO', de: 'DE', fr: 'FR', it: 'IT', es: 'ES' }

const PAGE = 1000

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.indexOf('=') > 0)
        .map((l) => [
          l.slice(0, l.indexOf('=')).trim(),
          l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''),
        ]),
    )
  } catch {
    return {}
  }
}

function resolveTarget() {
  if (local) {
    const url = process.env.CATALOG_LOCAL_URL || 'http://127.0.0.1:54521'
    const key = process.env.CATALOG_LOCAL_SERVICE_ROLE_KEY
    if (!key) {
      console.error('CATALOG_LOCAL_SERVICE_ROLE_KEY is not set. See seed.mjs --local.')
      process.exit(1)
    }
    return { url, key, label: 'the LOCAL catalog stack' }
  }
  const fromFile = envCandidates.reduce((acc, p) => ({ ...readEnvFile(p), ...acc }), {})
  const env = { ...fromFile, ...process.env }
  if (!env.CATALOG_SUPABASE_URL || !env.CATALOG_SUPABASE_SERVICE_ROLE_KEY) {
    console.error('CATALOG_SUPABASE_URL and CATALOG_SUPABASE_SERVICE_ROLE_KEY must both be set.')
    process.exit(1)
  }
  return {
    url: env.CATALOG_SUPABASE_URL,
    key: env.CATALOG_SUPABASE_SERVICE_ROLE_KEY,
    label: env.CATALOG_SUPABASE_URL,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const target = resolveTarget()
  console.log(`target:    ${target.label}`)
  console.log(`languages: ${langs.join(', ')}`)

  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Branded and mixed only. See the header for why generics are left out.
  const { data: concepts, error: cErr } = await db
    .from('catalog_concepts')
    .select('id,slug,intent')
    .in('intent', ['branded', 'mixed'])
  if (cErr) {
    console.error(`reading concepts failed: ${cErr.message}`)
    process.exit(1)
  }

  const bySlug = new Map(concepts.map((c) => [c.id, c.slug]))

  const terms = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('catalog_concept_terms')
      .select('concept_id,term,lang')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`reading terms failed: ${error.message}`)
      process.exit(1)
    }
    for (const t of data) {
      if (!bySlug.has(t.concept_id)) continue
      if (!t.lang || !langs.includes(t.lang)) continue
      terms.push({ slug: bySlug.get(t.concept_id), term: t.term, lang: t.lang })
    }
    if (data.length < PAGE) break
  }

  // One call per distinct (word, language). The same string recorded against
  // two concepts is one query; the same string in two languages is two, because
  // the language is passed upstream and changes what comes back.
  const seen = new Set()
  const queries = []
  for (const t of terms) {
    const key = `${t.lang}:${t.term.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    queries.push(t)
  }
  queries.sort((a, b) => a.slug.localeCompare(b.slug) || a.lang.localeCompare(b.lang))

  const planned = limit ? queries.slice(0, limit) : queries
  const mins = Math.round((planned.length * DELAY_MS) / 60000)
  console.log(
    `concepts:  ${concepts.length} branded/mixed\n` +
    `queries:   ${planned.length} distinct (word, language) pairs\n` +
    `estimate:  ~${mins} min at ${DELAY_MS}ms apart, ~${planned.length * 3} external calls\n`,
  )

  if (dryRun) {
    console.log('--dry-run: nothing called. First 20:')
    for (const q of planned.slice(0, 20)) console.log(`  ${q.lang}  ${q.slug.padEnd(20)} "${q.term}"`)
    return
  }

  let added = 0
  let asked = 0
  let cached = 0
  let empty = 0
  const failures = []
  const best = []

  for (const [i, q] of planned.entries()) {
    let res
    try {
      const r = await db.functions.invoke('discover', {
        body: {
          query: q.term,
          language: q.lang,
          market: MARKET_FOR[q.lang] ?? null,
          // See the header: warming forces the fetch on purpose.
          local: [],
        },
      })
      if (r.error) throw r.error
      res = r.data
    } catch (e) {
      failures.push({ q, error: String(e?.message ?? e) })
      await sleep(DELAY_MS)
      continue
    }

    const n = Number(res?.discovered) || 0
    const reason = res?.reason ?? null
    added += n
    if (reason === 'cached-hit' || reason === 'cached-miss') cached++
    else asked++
    if (!n) empty++
    if (n) best.push({ ...q, n })

    const tag = reason ? `(${reason})` : ''
    process.stdout.write(
      `  ${String(i + 1).padStart(4)}/${planned.length}  ${q.lang}  ` +
      `${q.term.slice(0, 30).padEnd(32)} +${String(n).padStart(2)} ${tag}\n`,
    )

    // Only pause when something was actually fetched. A cached answer touched
    // nobody's servers and there is nothing to be polite about.
    if (reason !== 'cached-hit' && reason !== 'cached-miss') await sleep(DELAY_MS)
  }

  console.log(
    `\ndone: ${added} products added across ${planned.length} queries\n` +
    `      ${asked} asked upstream, ${cached} answered from cache, ${empty} found nothing`,
  )

  best.sort((a, b) => b.n - a.n)
  if (best.length) {
    console.log('\nbiggest yields:')
    for (const b of best.slice(0, 15)) console.log(`  +${String(b.n).padStart(3)}  ${b.lang}  ${b.term}`)
  }

  if (failures.length) {
    console.error(`\n${failures.length} query(ies) failed:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.q.lang} "${f.q.term}": ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
