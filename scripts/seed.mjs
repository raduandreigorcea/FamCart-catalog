#!/usr/bin/env node
// Load the curated seed into the catalog project.
//
//   node catalog/scripts/seed.mjs --dry-run     what would be sent, nothing written
//   node catalog/scripts/seed.mjs --local       the local stack (supabase --workdir catalog)
//   node catalog/scripts/seed.mjs               the project named by .env.scripts
//   node catalog/scripts/seed.mjs --verify      ...and then search it, to prove it works
//   node catalog/scripts/seed.mjs --prune       report curated rows the seed no longer has
//   node catalog/scripts/seed.mjs --prune --apply   ...and actually remove them
//
// SAFE TO RUN AS OFTEN AS YOU LIKE. catalog_import_products() resolves each row
// to an existing product by barcode or by folded name, so a second run inserts
// nothing, adds no duplicate alias, and — the part that matters — does not touch
// add_count. Everything real people have earned survives every re-seed. That is
// asserted in catalog/supabase/tests/import.test.sql rather than assumed here.
//
// ─── the credentials, and the fallback that must not exist ───────────────────
//
// CATALOG_SUPABASE_URL and CATALOG_SUPABASE_SERVICE_ROLE_KEY, from .env.scripts,
// with NO FALLBACK TO VITE_SUPABASE_URL. That is a fix rather than an
// oversight, and it is worth stating because the fallback reads like a courtesy:
// with it in place, an unset CATALOG_SUPABASE_URL made the PRODUCTION HOUSEHOLD
// DATABASE the default target of every load, with nothing between it and a
// service-role write but a hostname printed to a terminal nobody reads. An unset
// variable stops the run.
//
// The service-role key bypasses every RLS policy in the project, which is why it
// lives in .env.scripts rather than .env: Vite reads .env and publishes every
// VITE_-prefixed key into the client bundle, so one mistaken prefix would ship
// full read/write access to the catalog. A file Vite never loads makes that
// mistake impossible rather than merely unlikely.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import {
  buildSeedRows,
  validateSeedRows,
  conceptRows,
  validateConceptRows,
} from '../supabase/functions/_shared/seedRows.ts'

const here = dirname(fileURLToPath(import.meta.url))
// .env.scripts lives in the SUPERPROJECT when this repo is checked out as a
// submodule of the app, and at this repo's own root when it is cloned on its
// own. Both are tried, superproject first, because that is the ordinary case.
const envCandidates = [join(here, '..', '..', '.env.scripts'), join(here, '..', '.env.scripts')]
const seedDir = join(here, '..', 'seed')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const local = args.has('--local')
const verify = args.has('--verify')
// Removing a concept from the seed file used to leave its row in the database
// forever. --prune closes that: it hands the database the source ids the seed
// currently holds and asks what curated rows are no longer among them.
// Deliberately opt-in, and deliberately a report until --apply is added too.
const prune = args.has('--prune')
const apply = args.has('--apply')

// A handful of real searches, run against the project that was just written to.
//
// Row counts are not proof. A seed can load 494 products and still be useless if
// the ranking is not there, the aliases did not attach, or the migration that
// defines search_catalog() never reached this project — and every one of those
// looks like a healthy import from the summary line. These are the questions a
// person would actually type, in the languages they would type them in.
const SMOKE = [
  { q: 'lapte', lang: 'ro', expect: 'Lapte' },
  // The one that caught a real ranking bug: 'milch' matches every dairy product
  // through the German category name "Milchprodukte", and used to return Eggs.
  { q: 'milch', lang: 'de', expect: 'Milch' },
  { q: 'lait', lang: 'fr', expect: 'Lait' },
  { q: 'leche', lang: 'es', expect: 'Leche' },
  { q: 'latte', lang: 'it', expect: 'Latte' },
  { q: 'milk', lang: 'en', expect: 'Milk' },
  { q: 'toilet paper', lang: 'en', expect: 'Toilet paper' },
  // BRANDED, so the real product leads and the generic "Baterii" sits under it.
  // This expectation used to be the generic row and was changed deliberately
  // when concepts landed: nobody typing "baterii" wants to be told "batteries",
  // they want to know which ones this shop has. If this ever flips back, the
  // intent for `batteries` has been lost rather than the ranking broken.
  { q: 'baterii', lang: 'ro', expect: 'Baterii AA 4 buc' },
  { q: 'usb c', lang: 'en', expect: 'USB cable' },
  // A real Romanian shop line, reached by its own name rather than by a concept.
  { q: 'sampon', lang: 'ro', expect: 'Sampon 400ml' },
  { q: 'cafea', lang: 'ro', expect: 'Cafea Macinata 250g' },
]

// Rows per RPC call. Each row is four tables' worth of work inside one
// subtransaction, so a batch is a real transaction rather than a network
// convenience: too large and a single slow row holds a lock over the rest, too
// small and the seed is 238 round trips.
const BATCH_SIZE = 100

// ─── env ─────────────────────────────────────────────────────────────────────
// A six-line parser instead of a dependency. .env.scripts holds two variables
// and a page of comments; dotenv would be a package added to the tree for the
// sake of `split('=')`.
function readEnvFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function resolveTarget() {
  if (local) {
    // The local stack's anon/service keys are the CLI's well-known development
    // ones — the same on every machine, worthless anywhere else, and printed by
    // `supabase --workdir catalog status`. Hard-coding the service key here
    // would date the moment the CLI rotates them, so it is read from the
    // environment with a documented way to get it.
    const url = process.env.CATALOG_LOCAL_URL || 'http://127.0.0.1:54521'
    const key = process.env.CATALOG_LOCAL_SERVICE_ROLE_KEY
    if (!key) {
      console.error(
        'CATALOG_LOCAL_SERVICE_ROLE_KEY is not set.\n' +
        '  npx supabase --workdir catalog status   # copy the service_role key\n' +
        '  CATALOG_LOCAL_SERVICE_ROLE_KEY=... node catalog/scripts/seed.mjs --local',
      )
      process.exit(1)
    }
    return { url, key, label: 'the LOCAL catalog stack' }
  }

  const fromFile = envCandidates.reduce((acc, path) => ({ ...readEnvFile(path), ...acc }), {})
  const env = { ...fromFile, ...process.env }
  const url = env.CATALOG_SUPABASE_URL
  const key = env.CATALOG_SUPABASE_SERVICE_ROLE_KEY

  // No fallback. See the header.
  if (!url || !key) {
    console.error(
      'CATALOG_SUPABASE_URL and CATALOG_SUPABASE_SERVICE_ROLE_KEY must both be set in .env.scripts.\n' +
      'They are NOT allowed to fall back to VITE_SUPABASE_URL: that is the app database, and a\n' +
      'service-role write against it would put catalog rows in the households project.',
    )
    process.exit(1)
  }
  return { url, key, label: url }
}

// ─── the seed ────────────────────────────────────────────────────────────────

function loadSeed() {
  const read = (name) => JSON.parse(readFileSync(join(seedDir, name), 'utf8'))
  const generics = read('generics.json')
  const categories = read('categories.json')
  const commercial = read('commercial-ro.json')
  const concepts = read('concepts.json')

  const rows = buildSeedRows(generics.generics, categories.categories, commercial.products)
  const conceptList = conceptRows(generics.generics, concepts.intents, concepts.concepts)

  const problems = [...validateSeedRows(rows), ...validateConceptRows(conceptList)]
  if (problems.length) {
    console.error(`${problems.length} problem(s) in the seed files:`)
    for (const p of problems.slice(0, 40)) console.error('  ' + p)
    if (problems.length > 40) console.error(`  ...and ${problems.length - 40} more`)
    process.exit(1)
  }
  return { rows, concepts: conceptList }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main() {
  const { rows, concepts } = loadSeed()
  const aliases = rows.reduce((n, r) => n + r.aliases.length, 0)
  const gtins = rows.reduce((n, r) => n + (r.gtins?.length ?? 0), 0)
  const terms = concepts.reduce((n, c) => n + c.terms.length, 0)
  const byIntent = (i) => concepts.filter((c) => c.intent === i).length

  console.log(
    `seed: ${rows.length} products, ${aliases} aliases, ${gtins} barcodes ` +
    `(${rows.filter((r) => r.type === 'generic').length} generic, ` +
    `${rows.filter((r) => r.type === 'commercial').length} commercial)`,
  )
  console.log(
    `      ${concepts.length} concepts, ${terms} terms ` +
    `(${byIntent('generic')} generic, ${byIntent('branded')} branded, ${byIntent('mixed')} mixed; ` +
    `${concepts.filter((c) => !c.productSourceId).length} with no product)`,
  )

  if (dryRun) {
    console.log('--dry-run: nothing written. First row:')
    console.log(JSON.stringify(rows[0], null, 2))
    console.log('First concept:')
    console.log(JSON.stringify(concepts[0], null, 2))
    return
  }

  const target = resolveTarget()
  console.log(`target: ${target.label}`)

  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const totals = { inserted: 0, updated: 0, skipped: 0, aliases_added: 0, identifiers_added: 0 }
  const errors = []

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { data, error } = await db.rpc('catalog_import_products', {
      p_rows: batch,
      p_source: 'curated',
    })

    if (error) {
      // A transport or permission failure is fatal: every remaining batch would
      // fail the same way, and a half-loaded seed reported as a success is the
      // worst of the three outcomes.
      console.error(`batch ${i / BATCH_SIZE + 1} failed: ${error.message}`)
      process.exit(1)
    }

    for (const k of Object.keys(totals)) totals[k] += data[k] ?? 0
    if (data.errors?.length) errors.push(...data.errors)
    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}\r`)
  }

  console.log(
    `\ninserted ${totals.inserted}, updated ${totals.updated}, skipped ${totals.skipped}, ` +
    `+${totals.aliases_added} aliases, +${totals.identifiers_added} barcodes`,
  )

  // Rows the database refused. Not fatal — the rest of the seed is in, and a
  // rejected row is information rather than a failure — but never swallowed:
  // a seed quietly shipping 237 of its 238 concepts is exactly the silent loss
  // this project is written against.
  if (errors.length) {
    console.error(`\n${errors.length} row(s) were rejected:`)
    for (const e of errors) console.error(`  ${e.row}: ${e.error}`)
    process.exitCode = 1
  }

  await loadConcepts(db, concepts)

  if (prune) await pruneRemoved(db, rows)
  if (verify) await smokeTest(db)
}

// ─── concepts ────────────────────────────────────────────────────────────────
// AFTER the products, and the order is load-bearing in one direction only: the
// backfill below attaches products to concepts, so the products have to exist.
// Nothing about the concepts themselves depends on a product, which is the
// whole point of the layer — 52 of them describe words this catalog stocks
// nothing for.
async function loadConcepts(db, concepts) {
  const totals = { inserted: 0, updated: 0, skipped: 0, terms_added: 0, terms_removed: 0 }
  const errors = []

  for (let i = 0; i < concepts.length; i += BATCH_SIZE) {
    const batch = concepts.slice(i, i + BATCH_SIZE).map((c) => ({
      slug: c.slug,
      intent: c.intent,
      category: c.category ?? null,
      weight: c.weight,
      terms: c.terms,
    }))

    const { data, error } = await db.rpc('catalog_import_concepts', { p_rows: batch })

    if (error) {
      console.error(`concept batch ${i / BATCH_SIZE + 1} failed: ${error.message}`)
      process.exit(1)
    }

    for (const k of Object.keys(totals)) totals[k] += data[k] ?? 0
    if (data.errors?.length) errors.push(...data.errors)
  }

  console.log(
    `concepts: inserted ${totals.inserted}, updated ${totals.updated}, ` +
    `skipped ${totals.skipped}, +${totals.terms_added} terms, -${totals.terms_removed} stale terms`,
  )

  if (errors.length) {
    console.error(`\n${errors.length} concept(s) were rejected:`)
    for (const e of errors) console.error(`  ${e.concept}: ${e.error}`)
    process.exitCode = 1
  }

  await attachConcepts(db, concepts)
}

// ─── attribution ─────────────────────────────────────────────────────────────
// Point each seeded generic product at the concept it IS.
//
// MATCHED THROUGH catalog_sources, NOT THROUGH NAMES. The seed's own id for a
// generic ("water", "potato") is what the importer recorded as
// source_product_id, so this is a join on a key both sides already agreed on.
// Matching on the canonical name instead would be a fold comparison across two
// databases' worth of assumptions, and it would silently attach the wrong
// product the first time two concepts shared an English name.
//
// The commercial rows are deliberately left unattributed. Nothing in
// commercial-ro.json says which concept "Apa Plata 2L Dorna" belongs to, and
// inferring it from the string "Apa" is exactly the confident wrong merge §15
// forbids. They earn a concept the same way a discovered row does: by being
// returned for a search that resolved to one.
async function attachConcepts(db, concepts) {
  const derived = concepts.filter((c) => c.productSourceId)
  if (!derived.length) return

  const { data: links, error: linkError } = await db
    .from('catalog_sources')
    .select('product_id, source_product_id')
    .eq('source_name', 'curated')
    .in('source_product_id', derived.map((c) => c.productSourceId))

  if (linkError) {
    console.error(`attribution lookup failed: ${linkError.message}`)
    process.exitCode = 1
    return
  }

  const productBySourceId = new Map((links ?? []).map((l) => [l.source_product_id, l.product_id]))

  const { data: rows, error: conceptError } = await db
    .from('catalog_concepts')
    .select('id, slug')
    .in('slug', derived.map((c) => c.slug))

  if (conceptError) {
    console.error(`attribution lookup failed: ${conceptError.message}`)
    process.exitCode = 1
    return
  }

  const conceptBySlug = new Map((rows ?? []).map((r) => [r.slug, r.id]))

  let attached = 0
  let missing = 0

  for (const c of derived) {
    const productId = productBySourceId.get(c.productSourceId)
    const conceptId = conceptBySlug.get(c.slug)
    if (!productId || !conceptId) {
      missing++
      continue
    }

    // p_overwrite, because here the seed IS the authority: a generic product
    // and its concept are the same idea and there is no earlier decision worth
    // preserving. Discovery calls the same function with the default, so it can
    // attribute an unattached row and never override this one.
    const { error } = await db.rpc('catalog_attach_concept', {
      p_product_ids: [productId],
      p_concept_id: conceptId,
      p_overwrite: true,
    })

    if (error) {
      console.error(`attaching ${c.slug} failed: ${error.message}`)
      process.exitCode = 1
      return
    }
    attached++
  }

  console.log(
    `attribution: ${attached} generic product(s) attached to their concept` +
    (missing ? `, ${missing} could not be matched` : ''),
  )
}

// ─── pruning ─────────────────────────────────────────────────────────────────
// The database does the deciding; this only supplies the keep-list and prints
// the answer. Every guard that matters lives in catalog_prune_curated() —
// notably that an empty keep-list is refused, because a loader that failed to
// read its files would otherwise truthfully report having pruned everything.
async function pruneRemoved(db, rows) {
  const keep = rows.map((r) => r.source_id)

  const { data, error } = await db.rpc('catalog_prune_curated', {
    p_keep: keep,
    p_apply: apply,
  })

  if (error) {
    console.error(`\nprune failed: ${error.message}`)
    process.exitCode = 1
    return
  }

  if (!data?.length) {
    console.log('\nprune: nothing in the catalog that the seed no longer has')
    return
  }

  console.log(
    `\nprune: ${data.length} curated row(s) are no longer in the seed` +
      (apply ? ', removed:' : ' (report only, add --apply to remove):'),
  )
  for (const row of data) {
    // add_count is what real people earned by adding it to real lists. Shown
    // because a concept somebody has been using is worth a second look before
    // it goes, even when the seed has deliberately dropped it.
    const earned = row.add_count > 0 ? `  (add_count ${row.add_count})` : ''
    console.log(`  ${row.removed ? '-' : '?'} ${row.source_id.padEnd(24)} ${row.name}${earned}`)
  }
}

// ─── verification ────────────────────────────────────────────────────────────
// Row counts are not proof. A seed can load 444 products and still be useless if
// the ranking never reached this project, or the aliases did not attach — and
// both look like a healthy import from the summary line above. So --verify asks
// the questions a person would actually type, in the languages they would type
// them in, against the project that was just written to.
async function smokeTest(db) {
  console.log('\nverifying:')
  let failed = 0

  for (const { q, lang, expect } of SMOKE) {
    const { data, error } = await db.rpc('search_catalog', {
      p_query: q,
      p_limit: 3,
      p_langs: [lang],
    })

    if (error) {
      console.error(`  FAIL ${q.padEnd(14)} ${error.message}`)
      failed++
      continue
    }

    const names = (data ?? []).map((r) => r.name)
    const ok = names[0] === expect
    if (!ok) failed++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${q.padEnd(14)} -> ${names.join(' / ') || '(nothing)'}`)
  }

  if (failed) {
    console.error(`\n${failed} of ${SMOKE.length} searches did not return what they should.`)
    process.exitCode = 1
  } else {
    console.log(`\nall ${SMOKE.length} searches returned the expected product first.`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
