// The TypeScript fold, checked against what Postgres actually answered.
//
// This is the test that catches the disagreement nobody would spot by reading:
// unaccent is a dictionary and NFD is an algorithm, and they part company on
// exactly the characters a product name is most likely to contain -- the German
// sharp s, the ligatures, the symbols that expand to more than one character.
//
// A failure here is not "the test is wrong". It means a scraper and the database
// now disagree about whether two products are the same, and the scraper will
// keep inserting rows the database folds together.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fold, keyFold } from '../src/core/normalize.ts'

interface FoldCase {
  input: string
  fold: string
  keyFold: string
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/fold.json', import.meta.url)), 'utf8'),
) as { cases: FoldCase[] }

describe('the fold agrees with the database', () => {
  it('has a fixture with something in it', () => {
    // A fixture that silently emptied would make every case below vacuously
    // pass, which is the one way this file could stop doing its job quietly.
    expect(fixture.cases.length).toBeGreaterThan(20)
  })

  // Reported per case rather than as one assertion over the array, so a failure
  // names the string that broke rather than dumping twenty-eight of them.
  for (const testCase of fixture.cases) {
    it(`folds ${JSON.stringify(testCase.input)} the way Postgres does`, () => {
      expect(fold(testCase.input)).toBe(testCase.fold)
      expect(keyFold(testCase.input)).toBe(testCase.keyFold)
    })
  }
})

describe('fold', () => {
  it('is the app browser copy: NFD, strip marks, lowercase, collapse, trim', () => {
    expect(fold('  Apă   PLATĂ  ')).toBe('apa plata')
  })

  it('turns null and undefined into the empty string rather than throwing', () => {
    expect(fold(null)).toBe('')
    expect(fold(undefined)).toBe('')
  })

  it('leaves punctuation alone, because the browser copy does', () => {
    // keyFold is where punctuation goes. If this ever starts stripping it, the
    // client-side productKey() in the app stops matching what search returns.
    expect(fold('Coca-Cola')).toBe('coca-cola')
  })
})

describe('keyFold', () => {
  it('flattens punctuation so one brand written two ways is one brand', () => {
    expect(keyFold('Coca-Cola')).toBe(keyFold('Coca Cola'))
  })

  it('keeps percent, because a fat content distinguishes real products', () => {
    expect(keyFold('Lapte 3,5%')).toContain('%')
  })
})
