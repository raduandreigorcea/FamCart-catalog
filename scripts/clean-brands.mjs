#!/usr/bin/env node
// Take the category text back out of the brand column.
//
//   node catalog/scripts/clean-brands.mjs --local           report, local stack
//   node catalog/scripts/clean-brands.mjs                   report, the project in .env.scripts
//   node catalog/scripts/clean-brands.mjs --apply           ...and actually clear them
//
// ─── why this exists as well as the ingest rule ──────────────────────────────
//
// usableBrand() now stops junk brands at the door, and that fixes every product
// discovered from today. It cannot fix the ones already here, and not because
// nobody got round to it: withoutKnown() drops a product the catalog already
// holds BEFORE catalog_import_products sees it, so a row's brand is written
// exactly once, by the search that first found it. Re-searching a term forever
// will never correct one.
//
// So the rows discovered before the rule existed keep their category text until
// something goes and removes it, and this is that something. It applies the
// SAME function the adapter applies -- imported, not reimplemented -- so a row
// cleaned here is exactly a row that would not be written that way today.
//
// ─── what it will not do ─────────────────────────────────────────────────────
//
// It clears brands. It never rewrites one, never guesses one from the name, and
// never deletes a product. A product with no brand is a product that is still
// findable and still correct; a product with an INVENTED brand is a commercial
// fact nobody checked (S4).
//
// CURATED ROWS ARE SKIPPED ENTIRELY. Every brand in commercial-ro.json was put
// there by a person reading a pack, so a heuristic has no business overruling
// one -- and `Sampon 400ml` by `Head & Shoulders` would survive anyway, but the
// skip means the seed never depends on that being true.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { usableBrand } from '../supabase/functions/_shared/sources/index.ts'
import { foldQuery } from '../supabase/functions/_shared/normalize.ts'

const here = dirname(fileURLToPath(import.meta.url))
const envCandidates = [join(here, '..', '..', '.env.scripts'), join(here, '..', '.env.scripts')]

const args = new Set(process.argv.slice(2))
const local = args.has('--local')
const apply = args.has('--apply')

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

// Same resolution as seed.mjs, and the same refusal to fall back: an unset
// CATALOG_SUPABASE_URL must stop the run rather than quietly default to the
// app's database.
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

async function main() {
  const target = resolveTarget()
  console.log(`target: ${target.label}`)

  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Which products a person curated. Their brands are off limits.
  const curated = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('catalog_sources')
      .select('product_id')
      .eq('source_name', 'curated')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`reading provenance failed: ${error.message}`)
      process.exit(1)
    }
    for (const r of data) curated.add(r.product_id)
    if (data.length < PAGE) break
  }

  // ─── a category word, FOR THIS KIND OF PRODUCT ─────────────────────────────
  //
  // Neither obvious scope is correct, and both were tried against the live
  // catalog after warming took it to 8,663 rows.
  //
  //   Every term pooled together flags `Persil lessive liquide` by "Persil",
  //   because `persil` is French for PARSLEY, and `Lait d'avoine` by "Lima",
  //   because `lima` is Spanish for LIME. Both are real brands, and deleting a
  //   true commercial fact is the error S4 prevents, signed the other way.
  //
  //   Only the product's OWN concept flags nothing at all: `Formaggio fresco`
  //   carrying the brand "Milk" is attributed to the cheese concept, and "Milk"
  //   is a term of the milk concept.
  //
  // What separates them is the SHELF. A brand that is a category word for the
  // aisle the product is in is the category leaking; a brand that happens to be
  // a common noun in a different aisle is a coincidence between languages, and
  // coincidences are not evidence. So a term only counts against a product when
  // the concept it belongs to sits in the same category.
  const categoriesForTerm = new Map()
  const conceptCategory = new Map()

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('catalog_concepts')
      .select('id,category')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`reading concepts failed: ${error.message}`)
      process.exit(1)
    }
    for (const c of data) conceptCategory.set(c.id, c.category)
    if (data.length < PAGE) break
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('catalog_concept_terms')
      .select('concept_id,term')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`reading concept terms failed: ${error.message}`)
      process.exit(1)
    }
    for (const t of data) {
      const folded = foldQuery(t.term)
      const cat = conceptCategory.get(t.concept_id)
      if (!folded || !cat) continue
      const set = categoriesForTerm.get(folded)
      if (set) set.add(cat)
      else categoriesForTerm.set(folded, new Set([cat]))
    }
    if (data.length < PAGE) break
  }

  const bad = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('catalog_products')
      .select('id,canonical_name,brand,concept_id,category')
      .not('brand', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) {
      console.error(`reading products failed: ${error.message}`)
      process.exit(1)
    }
    for (const p of data) {
      if (curated.has(p.id)) continue
      // The product's own shelf: its column where it has one, else the shelf
      // of the concept it was attributed to.
      const shelf = p.category ?? (p.concept_id ? conceptCategory.get(p.concept_id) : null)
      const shelves = categoriesForTerm.get(foldQuery(p.brand))
      const isCategory = Boolean(shelf && shelves && shelves.has(shelf))
      if (!usableBrand(p.brand) || isCategory) bad.push(p)
    }
    if (data.length < PAGE) break
  }

  if (!bad.length) {
    console.log('nothing to clean: every discovered brand still looks like a brand')
    return
  }

  console.log(
    `\n${bad.length} discovered row(s) carry category text in the brand` +
      (apply ? ', clearing:' : ' (report only, add --apply to clear):'),
  )
  for (const p of bad) console.log(`  ${p.canonical_name.slice(0, 44).padEnd(46)} ${p.brand}`)

  if (!apply) return

  let cleared = 0
  const failed = []
  for (const p of bad) {
    // One at a time rather than one big `in` filter, because clearing the brand
    // changes normalized_name (the trigger recomputes the merge key from name +
    // brand) and that can collide with a row that already holds the shorter
    // key. A collision is a real product duplicated upstream, not a bug here:
    // it is reported and skipped, and the row keeps its bad brand rather than
    // the whole batch failing.
    const { error } = await db.from('catalog_products').update({ brand: null }).eq('id', p.id)
    if (error) failed.push({ name: p.canonical_name, error: error.message })
    else cleared++
  }

  console.log(`\ncleared ${cleared} of ${bad.length}`)
  if (failed.length) {
    console.error(`${failed.length} could not be cleared (merge key collision):`)
    for (const f of failed) console.error(`  ${f.name}: ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
