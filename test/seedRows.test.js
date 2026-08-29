import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  genericRows,
  commercialRows,
  buildSeedRows,
  validateSeedRows,
} from '../supabase/functions/_shared/seedRows.ts'
import { MARKETS, LANGUAGES } from '../supabase/functions/_shared/markets.ts'

// The seed's own logic, plus the seed files themselves.
//
// Two different jobs in one file on purpose. The expansion can be wrong in ways
// the database will happily accept — a synonym promoted to a name, a category
// attached to nothing, a language silently dropped — and the seed FILES can be
// wrong in ways no code will ever catch, like a concept that lost its Romanian
// name in an edit. The database checks neither.

const read = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../seed/${name}`, import.meta.url)), 'utf8'))

const generics = read('generics.json')
const categories = read('categories.json')
const commercial = read('commercial-ro.json')

describe('expanding a generic concept', () => {
  const catalog = { dairy: { en: 'Dairy', ro: 'Lactate', de: 'Milchprodukte', fr: 'Produits laitiers', it: 'Latticini', es: 'Lácteos' } }
  const milk = {
    id: 'milk',
    cat: 'dairy',
    w: 100,
    n: { en: 'Milk', ro: 'Lapte', de: 'Milch', fr: 'Lait', it: 'Latte', es: 'Leche' },
    syn: { en: ['Whole milk'] },
  }

  it('makes English canonical and the other five aliases of type name', () => {
    const [row] = genericRows([milk], catalog)
    expect(row.name).toBe('Milk')
    expect(row.lang).toBe('en')

    const names = row.aliases.filter((a) => a.type === 'name')
    expect(names.map((a) => a.lang).sort()).toEqual(['de', 'es', 'fr', 'it', 'ro'])
    expect(names.find((a) => a.lang === 'ro').alias).toBe('Lapte')
    // English is the canonical name, so it must NOT also be an alias of type
    // 'name' — the unique index allows one per language and the canonical row
    // is not in that table at all.
    expect(names.some((a) => a.lang === 'en')).toBe(false)
  })

  it('keeps a synonym a synonym even in the canonical language', () => {
    const [row] = genericRows([milk], catalog)
    const syn = row.aliases.filter((a) => a.type === 'synonym')
    expect(syn).toEqual([{ alias: 'Whole milk', lang: 'en', type: 'synonym' }])
  })

  it('attaches the category in all six languages', () => {
    const [row] = genericRows([milk], catalog)
    const cats = row.aliases.filter((a) => a.type === 'category')
    expect(cats.map((a) => a.alias).sort()).toEqual(
      ['Dairy', 'Lactate', 'Latticini', 'Lácteos', 'Milchprodukte', 'Produits laitiers'].sort(),
    )
  })

  it('claims every market, because a shopping concept has no distribution', () => {
    const [row] = genericRows([milk], catalog)
    expect(row.markets.sort()).toEqual([...MARKETS].sort())
    // And tier A: a generic is complete without a barcode (spec §11).
    expect(row.tier).toBe('A')
  })

  it('skips a missing language rather than filling it in from English', () => {
    const partial = { ...milk, n: { en: 'Milk', ro: 'Lapte' } }
    const [row] = genericRows([partial], catalog)
    const names = row.aliases.filter((a) => a.type === 'name')
    expect(names.map((a) => a.lang)).toEqual(['ro'])
  })

  it('ignores an unknown category rather than inventing aliases for it', () => {
    const [row] = genericRows([{ ...milk, cat: 'nonsense' }], {})
    expect(row.aliases.some((a) => a.type === 'category')).toBe(false)
  })
})

describe('carrying a commercial row through', () => {
  const row = commercialRows([
    { id: 'x', type: 'commercial', name: 'Chipsuri 140g', lang: 'ro', brand: "Lay's", markets: ['RO'], w: 23, tier: 'B' },
  ])[0]

  it('translates nothing — every alias would be an invented commercial fact', () => {
    expect(row.aliases).toEqual([])
    expect(row.lang).toBe('ro')
    expect(row.markets).toEqual(['RO'])
  })

  it('keeps the brand, which is half of the merge key', () => {
    expect(row.brand).toBe("Lay's")
  })

  it('omits gtins entirely rather than sending an empty array', () => {
    expect('gtins' in row).toBe(false)
  })
})

describe('ordering', () => {
  it('puts generics first, so a concept wins a merge key over a shop line', () => {
    const rows = buildSeedRows(
      [{ id: 'milk', cat: 'dairy', w: 100, n: { en: 'Milk' } }],
      {},
      [{ id: 'ro-milk', type: 'commercial', name: 'Milk', lang: 'ro', markets: ['RO'], w: 10, tier: 'B' }],
    )
    expect(rows[0].source_id).toBe('milk')
    expect(rows[0].type).toBe('generic')
  })
})

describe('validation catches what the import summary would only count', () => {
  const ok = {
    type: 'generic', name: 'Milk', lang: 'en', markets: ['RO'],
    tier: 'A', weight: 10, source_id: 'milk', aliases: [],
  }

  it('passes a good row', () => {
    expect(validateSeedRows([ok])).toEqual([])
  })

  it('names a duplicate source id', () => {
    const problems = validateSeedRows([ok, { ...ok, name: 'Other' }])
    expect(problems.join(' ')).toMatch(/duplicate source id/)
  })

  it('names two names in one language, which the database drops silently', () => {
    const problems = validateSeedRows([{
      ...ok,
      aliases: [
        { alias: 'Lapte', lang: 'ro', type: 'name' },
        { alias: 'Lăptic', lang: 'ro', type: 'name' },
      ],
    }])
    expect(problems.join(' ')).toMatch(/two ro names/)
  })

  it('rejects an unknown market, an unknown language and a non-barcode', () => {
    expect(validateSeedRows([{ ...ok, markets: ['US'] }]).join(' ')).toMatch(/unknown market 'US'/)
    expect(validateSeedRows([{ ...ok, lang: 'pl' }]).join(' ')).toMatch(/not one of the six/)
    expect(validateSeedRows([{ ...ok, gtins: ['ABC'] }]).join(' ')).toMatch(/is not a barcode/)
  })

  it('rejects a name longer than the app database can hold', () => {
    expect(validateSeedRows([{ ...ok, name: 'x'.repeat(121) }]).join(' ')).toMatch(/over 120 characters/)
  })
})

describe('the seed files themselves', () => {
  const rows = buildSeedRows(generics.generics, categories.categories, commercial.products)

  it('has no problems the importer would reject', () => {
    expect(validateSeedRows(rows)).toEqual([])
  })

  it('names every concept in all six languages', () => {
    const gaps = generics.generics
      .filter((g) => LANGUAGES.some((l) => !g.n[l]?.trim()))
      .map((g) => g.id)
    expect(gaps).toEqual([])
  })

  it('gives every concept a category that exists', () => {
    const known = new Set(Object.keys(categories.categories))
    const unknown = generics.generics.filter((g) => !known.has(g.cat)).map((g) => g.id)
    expect(unknown).toEqual([])
  })

  it('names every category in all six languages', () => {
    const gaps = Object.entries(categories.categories)
      .filter(([, names]) => LANGUAGES.some((l) => !names[l]?.trim()))
      .map(([slug]) => slug)
    expect(gaps).toEqual([])
  })

  it('never reuses a name within one language across two concepts', () => {
    // Two concepts sharing a Romanian name would collapse onto one row through
    // the merge key and one of them would vanish. The fold is the database's,
    // so this is an approximation of it — enough to catch a copy-paste.
    const fold = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
    for (const lang of LANGUAGES) {
      const seen = new Map()
      for (const g of generics.generics) {
        const name = g.n[lang]
        if (!name) continue
        const key = fold(name)
        expect(seen.has(key), `${lang}: '${name}' is used by both ${seen.get(key)} and ${g.id}`).toBe(false)
        seen.set(key, g.id)
      }
    }
  })

  it('keeps the commercial rows Romanian and untranslated', () => {
    for (const p of commercial.products) {
      expect(p.lang).toBe('ro')
      expect(p.markets).toEqual(['RO'])
    }
  })

  it('keeps every editorial weight on one scale', () => {
    for (const r of rows) {
      expect(r.weight).toBeGreaterThanOrEqual(0)
      expect(r.weight).toBeLessThanOrEqual(100)
    }
  })

  it('is big enough to be useful on day one', () => {
    // Not a target — spec §1 is explicit that row count is not the goal. This is
    // a floor, so a seed file accidentally truncated to a handful of entries
    // fails here rather than shipping.
    expect(rows.length).toBeGreaterThan(400)
    const names = rows.reduce((n, r) => n + 1 + r.aliases.filter((a) => a.type !== 'category').length, 0)
    expect(names).toBeGreaterThan(1400)
  })
})
