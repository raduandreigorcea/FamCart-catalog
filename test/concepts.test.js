import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { conceptRows, validateConceptRows } from '../supabase/functions/_shared/seedRows.ts'
import { LANGUAGES } from '../supabase/functions/_shared/markets.ts'

// The concept layer's own logic, plus the concept file itself.
//
// Two jobs in one file, the same split seedRows.test.js makes. The expansion can
// be wrong in ways the database accepts without complaint — an intent silently
// defaulted, a synonym promoted to a label, a language dropped — and the FILE
// can be wrong in ways no code catches, like a branded concept that lost its
// Spanish name in an edit. Neither is a constraint violation.

const read = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../seed/${name}`, import.meta.url)), 'utf8'))

const generics = read('generics.json')
const concepts = read('concepts.json')

const rows = conceptRows(generics.generics, concepts.intents, concepts.concepts)
const bySlug = new Map(rows.map((r) => [r.slug, r]))

describe('deriving a concept from a generic product', () => {
  const potato = {
    id: 'potato', cat: 'produce', w: 100,
    n: { en: 'Potatoes', ro: 'Cartofi', de: 'Kartoffeln', fr: 'Pommes de terre', it: 'Patate', es: 'Patatas' },
  }

  it('takes its names from generics.json rather than restating them', () => {
    const [row] = conceptRows([potato], {}, [])
    // As a set: the order follows LANGUAGES and is not a contract, but every
    // one of the six has to be there, each tagged with the language it is in.
    expect(row.terms.filter((t) => t.type === 'label').map((t) => `${t.lang}:${t.term}`).sort()).toEqual([
      'de:Kartoffeln', 'en:Potatoes', 'es:Patatas', 'fr:Pommes de terre', 'it:Patate', 'ro:Cartofi',
    ])
  })

  it('defaults to generic, because that is what the seed was built out of', () => {
    const [row] = conceptRows([potato], {}, [])
    expect(row.intent).toBe('generic')
  })

  it('takes an override when the file states one', () => {
    const [row] = conceptRows([potato], { potato: 'mixed' }, [])
    expect(row.intent).toBe('mixed')
  })

  it('ignores an override that is not one of the three, rather than passing it on', () => {
    // The database would reject it, but only for that one concept and only in a
    // batch summary. Falling back to the default keeps a typo from taking a
    // whole concept out of the catalog.
    const [row] = conceptRows([potato], { potato: 'GENERIC' }, [])
    expect(row.intent).toBe('generic')
  })

  it('keeps the thread back to the product, so the backfill needs no name matching', () => {
    const [row] = conceptRows([potato], {}, [])
    expect(row.productSourceId).toBe('potato')
  })
})

describe('a concept with no product', () => {
  const shampoo = {
    id: 'shampoo', cat: 'personal-care', intent: 'branded', w: 90,
    n: { en: 'Shampoo', ro: 'Șampon', de: 'Shampoo', fr: 'Shampooing', it: 'Shampoo', es: 'Champú' },
    syn: { en: ['Hair shampoo'] },
  }

  it('carries its own six names, because there is nowhere else for them to live', () => {
    const [row] = conceptRows([], {}, [shampoo])
    expect(row.terms.filter((t) => t.type === 'label')).toHaveLength(6)
  })

  it('has no product to point at, and that is the whole point', () => {
    const [row] = conceptRows([], {}, [shampoo])
    expect(row.productSourceId).toBeUndefined()
  })

  it('keeps synonyms as synonyms', () => {
    const [row] = conceptRows([], {}, [shampoo])
    expect(row.terms.find((t) => t.term === 'Hair shampoo')?.type).toBe('synonym')
  })
})

describe('validation', () => {
  const ok = { slug: 'water', intent: 'branded', weight: 10, terms: [{ term: 'Water', lang: 'en', type: 'label' }] }

  it('accepts a well-formed concept', () => {
    expect(validateConceptRows([ok])).toEqual([])
  })

  it('rejects a concept with no terms, which nothing could ever resolve to', () => {
    expect(validateConceptRows([{ ...ok, terms: [] }])[0]).toMatch(/no terms/)
  })

  it('rejects a duplicate slug, which the importer would silently turn into an update', () => {
    expect(validateConceptRows([ok, ok]).join()).toMatch(/duplicate slug/)
  })

  it('rejects a slug that is not kebab-case', () => {
    expect(validateConceptRows([{ ...ok, slug: 'Still Water' }])[0]).toMatch(/kebab/)
  })

  // The bug this file caught on its first run. "Mozzarella" is the label in all
  // six languages, and an earlier check flagged every one of those as a repeat —
  // 127 false problems that would have stopped the seed loading at all. The
  // database keys terms per language, so all six are kept and all six are right.
  it('does NOT flag one string used as the label in several languages', () => {
    const mozzarella = {
      slug: 'mozzarella', intent: 'mixed', weight: 10,
      terms: LANGUAGES.map((lang) => ({ term: 'Mozzarella', lang, type: 'label' })),
    }
    expect(validateConceptRows([mozzarella])).toEqual([])
  })

  it('does flag the same string twice in ONE language, which nothing meant', () => {
    const doubled = {
      ...ok,
      terms: [
        { term: 'Water', lang: 'en', type: 'label' },
        { term: 'water', lang: 'en', type: 'synonym' },
      ],
    }
    expect(validateConceptRows([doubled])[0]).toMatch(/repeats/)
  })
})

describe('the concept file itself', () => {
  it('has no problems the database would reject', () => {
    expect(validateConceptRows(rows)).toEqual([])
  })

  it('gives every generic product a concept', () => {
    expect(rows.filter((r) => r.productSourceId)).toHaveLength(generics.generics.length)
  })

  it('names every intent override against a generic that exists', () => {
    const ids = new Set(generics.generics.map((g) => g.id))
    expect(Object.keys(concepts.intents).filter((k) => !ids.has(k))).toEqual([])
  })

  it('never gives a standalone concept the slug of a generic', () => {
    const ids = new Set(generics.generics.map((g) => g.id))
    expect(concepts.concepts.filter((c) => ids.has(c.id)).map((c) => c.id)).toEqual([])
  })

  it('names every standalone concept in all six languages', () => {
    // A concept with no product is reachable ONLY through its terms, so a
    // missing language is a word that silently stops working for a sixth of
    // the users rather than a cosmetic gap.
    const thin = concepts.concepts.filter((c) => LANGUAGES.some((l) => !c.n[l]?.trim()))
    expect(thin.map((c) => c.id)).toEqual([])
  })

  it('classifies the concepts the product argument turns on', () => {
    // These are the distinctions the whole layer exists to make. A generic here
    // would suppress discovery forever; a branded one would fire an external
    // call for a word no brand can answer.
    expect(bySlug.get('water').intent).toBe('branded')
    expect(bySlug.get('salami').intent).toBe('branded')
    expect(bySlug.get('deodorant').intent).toBe('branded')
    expect(bySlug.get('laundry-detergent').intent).toBe('branded')
    expect(bySlug.get('shampoo').intent).toBe('branded')
    expect(bySlug.get('toothpaste').intent).toBe('branded')

    expect(bySlug.get('potato').intent).toBe('generic')
    expect(bySlug.get('carrot').intent).toBe('generic')
    expect(bySlug.get('apple').intent).toBe('generic')
    expect(bySlug.get('banana').intent).toBe('generic')
    expect(bySlug.get('tomato').intent).toBe('generic')

    expect(bySlug.get('milk').intent).toBe('mixed')
    expect(bySlug.get('bread').intent).toBe('mixed')
    expect(bySlug.get('cheese').intent).toBe('mixed')
  })

  it('brings back the removed concepts as concepts, and NOT as products', () => {
    // The fifty brandless concepts were taken out of the seed because a list
    // saying "Shampoo" makes whoever is holding it guess. That stands. What
    // comes back is the word, not the row.
    for (const slug of ['shampoo', 'deodorant', 'laundry-detergent', 'coffee', 'beer', 'nappies', 'cat-food']) {
      const row = bySlug.get(slug)
      expect(row, slug).toBeDefined()
      expect(row.productSourceId, slug).toBeUndefined()
    }
  })

  it('leaves pepperoni out, because Italian means bell peppers by it', () => {
    expect(bySlug.has('pepperoni')).toBe(false)
  })
})
