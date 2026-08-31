import { describe, it, expect } from 'vitest'
import { foldName, foldQuery, tokens, matchesAllTokens } from '../supabase/functions/_shared/normalize.ts'
import { judge, tierOf, gate } from '../supabase/functions/_shared/quality.ts'
import {
  OpenFoodFactsAdapter,
  parseQuantity,
} from '../supabase/functions/_shared/sources/openFoodFacts.ts'
import fixture from './fixtures/fold.json' with { type: 'json' }
import {
  isLocalSufficient,
  capFor,
  relevantTo,
  withoutKnown,
  collapse,
  toImportRows,
  pipeline,
} from '../supabase/functions/_shared/discover.ts'

// The discovery pipeline, end to end, without a network and without a database.
//
// Everything the edge function does between "the local catalog was not enough"
// and "here are rows for catalog_import_products" lives in these four modules,
// and all of it is pure. That is the reason it was pulled out of the function:
// the judgement is the part worth testing, and testing it through Deno and
// PostgREST would mean testing it rarely.

// ─── a real Open Food Facts record ───────────────────────────────────────────
// Captured from search.openfoodfacts.org rather than invented, because the
// whole job of the adapter is to survive the shape upstream actually sends —
// note `brands` as an ARRAY here and as a comma-separated STRING from the v2
// product endpoint below. A fixture written from the documentation would agree
// with the documentation and not with the service.
const OFF_HIT = {
  code: '3017620422003',
  product_name: 'Nutella',
  generic_name: 'Pâte à tartiner aux noisettes et au cacao',
  brands: ['Nutella', 'Ferrero', 'Yum yum'],
  quantity: '400 g',
  countries_tags: ['en:france', 'en:romania', 'en:brazil'],
  categories_tags: ['en:breakfasts', 'en:spreads', 'en:sweet-snacks'],
  lang: 'fr',
  image_front_url: 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_fr.jpg',
  completeness: 0.85,
  unique_scans_n: 4821,
  last_modified_t: 1615159815,
}

const OFF_V2_PRODUCT = {
  code: '3017620422003',
  product_name: 'Nutella',
  brands: 'Nutella, Ferrero, Yum yum',
  quantity: '400 g',
  countries_tags: ['en:france'],
  lang: 'fr',
}

describe('the fold, in TypeScript', () => {
  // THE POINT OF THIS TEST. The database owns the fold; this file has to agree
  // with it, and "agrees" cannot be checked by writing down what both of them
  // ought to do, because unaccent is a DICTIONARY and nobody remembers a
  // dictionary. So the fixture holds what a running Postgres actually answered
  // for each case, and this asserts the TypeScript matches.
  //
  // It caught three real divergences when it was written, every one of which
  // would have been silent in production: the eszett folding to itself here and
  // to 'ss' there, the registered-trademark mark surviving here and becoming
  // '(r)' there, and the vulgar fraction expanding to ' 1/2' with a LEADING
  // SPACE that nobody would have guessed.
  //
  // To regenerate after changing catalog_normalize():
  //   npx supabase --workdir catalog db reset
  //   then for each `in` in the fixture, select catalog_normalize(<in>, null)
  //   and write the answers back.
  it('agrees with catalog_normalize on every case in the fixture', () => {
    const disagreements = fixture.cases
      .filter((c) => foldName(c.in, null) !== c.out)
      .map(
        (c) =>
          `${JSON.stringify(c.in)}: db=${JSON.stringify(c.out)} ts=${JSON.stringify(foldName(c.in, null))}`,
      )
    expect(disagreements).toEqual([])
  })

  it('exercises the characters that actually diverge, not only ASCII', () => {
    // A fixture of thirty plain ASCII names would pass forever and prove
    // nothing. These are the ten that separate the two implementations.
    // Lowercased, because the table only holds lowercase keys and an uppercase
    // input reaches them through the fold's own toLowerCase(). The fixture has
    // "Oeufs" with the uppercase ligature, and that exercises the same entry.
    const all = fixture.cases.map((c) => c.in).join('').toLowerCase()
    for (const ch of ['ß', '®', '½', '–', '’', '«', 'œ', 'ﬁ', 'ă', 'ü']) {
      expect(all, `the fixture should exercise ${JSON.stringify(ch)}`).toContain(ch)
    }
  })

  it('appends the brand, which is what makes the merge key', () => {
    expect(foldName('  Apă   Plată 2L ', 'Dorna')).toBe('apa plata 2l dorna')
    expect(foldName('Müsli', '')).toBe('musli')
    expect(foldName(null, null)).toBe('')
  })

  it('bounds a query to six tokens', () => {
    expect(tokens('a b c d e f g h')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(tokens('  ')).toEqual([])
  })

  it('matches every token in any order, which is what the database does', () => {
    expect(matchesAllTokens('Apa Plata Borsec', 'borsec apa')).toBe(true)
    expect(matchesAllTokens('Apa Plata Borsec', 'borsec dorna')).toBe(false)
    expect(matchesAllTokens('Apă Plată', 'apa')).toBe(true)
    expect(matchesAllTokens('anything', '')).toBe(false)
  })
})

describe('the Open Food Facts adapter', () => {
  const adapter = new OpenFoodFactsAdapter({ fetchImpl: async () => new Response('{}') })

  it('reads a real search hit into our shape', () => {
    const p = adapter.normalize(OFF_HIT)
    expect(p).toMatchObject({
      name: 'Nutella',
      lang: 'fr',
      brand: 'Nutella',
      gtins: ['3017620422003'],
      quantity: 400,
      quantityUnit: 'g',
      source: 'openfoodfacts',
      sourceId: '3017620422003',
      uniqueScans: 4821,
    })
  })

  it('keeps only the first brand, because the field is a list of guesses', () => {
    // The real record says "Nutella, Ferrero, Yum yum". Keeping all three would
    // put "Yum yum" in the merge key.
    expect(adapter.normalize(OFF_HIT).brand).toBe('Nutella')
    expect(adapter.normalize(OFF_V2_PRODUCT).brand).toBe('Nutella')
  })

  it('reads both JSON shapes for brands, which is why the adapter exists', () => {
    expect(adapter.normalize({ ...OFF_HIT, brands: ['Pepsi'] }).brand).toBe('Pepsi')
    expect(adapter.normalize({ ...OFF_HIT, brands: 'Pepsi, PepsiCo' }).brand).toBe('Pepsi')
  })

  it('maps only countries this app can express, and drops the rest', () => {
    // en:brazil is in the fixture and must not survive: no market code the app
    // can send corresponds to it, so keeping it would be storing a fact nothing
    // can ever match.
    expect(adapter.normalize(OFF_HIT).markets).toEqual(['FR', 'RO'])
  })

  it('takes the deepest category it recognises and no category at all otherwise', () => {
    expect(adapter.normalize(OFF_HIT).category).toBe('snacks')
    expect(adapter.normalize({ ...OFF_HIT, categories_tags: ['en:mystery'] }).category)
      .toBeUndefined()
  })

  it('refuses an image URL that is not https', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://x/y.jpg']) {
      expect(adapter.normalize({ ...OFF_HIT, image_front_url: bad }).imageUrl).toBeUndefined()
    }
  })

  it('drops a record with no name or no code rather than inventing one', () => {
    expect(adapter.normalize({ ...OFF_HIT, product_name: '', generic_name: '' })).toBeNull()
    expect(adapter.normalize({ ...OFF_HIT, code: '' })).toBeNull()
    expect(adapter.normalize(null)).toBeNull()
  })

  it('falls back to generic_name only when there is no name', () => {
    const p = adapter.normalize({ ...OFF_HIT, product_name: '' })
    expect(p.name).toBe('Pâte à tartiner aux noisettes et au cacao')
  })

  it('stores a language only when the app can render it', () => {
    expect(adapter.normalize({ ...OFF_HIT, lang: 'pl' }).lang).toBeUndefined()
    expect(adapter.normalize({ ...OFF_HIT, lang: 'ro' }).lang).toBe('ro')
  })
})

describe('parsing a free-text quantity', () => {
  it('reads the forms that are unambiguous', () => {
    expect(parseQuantity('400 g')).toEqual({ quantity: 400, unit: 'g' })
    expect(parseQuantity('1,5 L')).toEqual({ quantity: 1.5, unit: 'l' })
    expect(parseQuantity('330ml')).toEqual({ quantity: 330, unit: 'ml' })
    expect(parseQuantity('1.5kg')).toEqual({ quantity: 1.5, unit: 'kg' })
    expect(parseQuantity('33 cl')).toEqual({ quantity: 33, unit: 'cl' })
    expect(parseQuantity('6 buc')).toEqual({ quantity: 6, unit: 'piece' })
  })

  it('refuses a multipack rather than guessing which number is the size', () => {
    // "6 x 1.5 L" is not a 1.5 L product and not a 9 L one. Either answer is a
    // fabricated commercial fact.
    expect(parseQuantity('6 x 1.5 L')).toBeNull()
    expect(parseQuantity('2×500g')).toBeNull()
  })

  it('refuses everything else rather than approximating', () => {
    for (const bad of ['', null, undefined, 'environ 250 g', 'une bouteille', '400', 'g']) {
      expect(parseQuantity(bad)).toBeNull()
    }
  })
})

describe('the quality gate', () => {
  const good = {
    name: 'Pepsi Zero 500ml',
    brand: 'Pepsi',
    gtins: ['4060800104'],
    source: 'openfoodfacts',
    sourceId: '4060800104',
  }

  it('accepts an ordinary commercial product', () => {
    expect(judge(good)).toMatchObject({ ok: true })
  })

  it('rejects placeholders and test rows', () => {
    for (const name of ['test', 'Test Product', 'PRODUIT TEST', 'unknown', 'n/a', 'asdf', 'dummy pack']) {
      expect(judge({ ...good, name }).ok, name).toBe(false)
    }
  })

  it('does not reject a real product whose name merely starts with a word', () => {
    // 'test' alone is a rejection; 'Test Match Lager' is a drink.
    expect(judge({ ...good, name: 'Test Match Lager' }).ok).toBe(true)
  })

  it('rejects a barcode typed into the name field', () => {
    expect(judge({ ...good, name: '5941234567890' })).toMatchObject({
      ok: false,
      reason: 'name-not-a-name',
    })
  })

  it('rejects a name with no letters, and one repeated character', () => {
    expect(judge({ ...good, name: '--- ---' }).ok).toBe(false)
    expect(judge({ ...good, name: 'aaaaaaa' }).ok).toBe(false)
  })

  it('requires a discovered commercial product to have BOTH a brand and a barcode', () => {
    // Either-one-alone was the original reading of S12 and it was measured at
    // volume: warming to 8,663 rows admitted 637 products with a barcode, a
    // name, and no maker. A barcode is not an identifier to somebody reading a
    // shopping list, so those rows are a word and a number.
    expect(judge({ ...good, brand: undefined })).toMatchObject({ ok: false, reason: 'no-brand' })
    expect(judge({ ...good, gtins: undefined })).toMatchObject({ ok: false, reason: 'no-barcode' })
    expect(judge({ ...good }).ok).toBe(true)
  })

  it('still asks neither of a generic, where having neither is normal', () => {
    // A banana has no manufacturer and no barcode. Demanding either would
    // reject the entire curated seed.
    expect(judge({ ...good, brand: undefined, gtins: undefined }, 'generic').ok).toBe(true)
  })

  it('rejects a malformed barcode, because the record carrying it is suspect', () => {
    expect(judge({ ...good, gtins: ['12'] })).toMatchObject({ ok: false, reason: 'bad-barcode' })
    expect(judge({ ...good, gtins: ['ABCDEFGH'] })).toMatchObject({ ok: false, reason: 'bad-barcode' })
  })

  it('believes the source when it says a product is gone', () => {
    expect(judge({ ...good, obsolete: true })).toMatchObject({ ok: false, reason: 'obsolete' })
  })

  it('NEVER rejects for a missing optional field (spec §10)', () => {
    // The whole list §10 names as "do not reject merely because".
    expect(judge({ ...good, markets: undefined }).ok).toBe(true)
    expect(judge({ ...good, imageUrl: undefined }).ok).toBe(true)
    expect(judge({ ...good, quantity: undefined }).ok).toBe(true)
    expect(judge({ ...good, category: undefined }).ok).toBe(true)
    expect(judge({ ...good, completeness: 0 }).ok).toBe(true)
    expect(judge({ ...good, uniqueScans: 0 }).ok).toBe(true)
  })

  it('scores a generic by generic rules, not commercial ones', () => {
    const banana = { name: 'Banana', source: 'openfoodfacts', sourceId: 'x' }
    // No brand, no barcode. A rejection as a commercial product...
    expect(judge(banana, 'commercial').ok).toBe(false)
    // ...and perfectly fine as a concept, which is §11 and §13.
    expect(judge(banana, 'generic').ok).toBe(true)
  })

  it('tiers on evidence rather than on completeness of the upstream record', () => {
    // §11: a commercial product with name, brand and barcode is high quality
    // WITHOUT nutrition.
    expect(tierOf({ ...good, markets: ['RO'], quantity: 500, quantityUnit: 'ml' })).toBe('A')
    expect(tierOf(good)).toBe('B')
    expect(tierOf({ ...good, gtins: undefined })).toBe('C')
    expect(tierOf({ name: 'Milk', category: 'dairy', markets: ['RO'] }, 'generic')).toBe('A')
    expect(tierOf({ name: 'Milk', category: 'dairy' }, 'generic')).toBe('B')
    expect(tierOf({ name: 'Milk' }, 'generic')).toBe('C')
  })

  it('counts why things were rejected, not just how many', () => {
    const result = gate([
      good,
      { ...good, name: 'test' },
      { ...good, name: 'testing' },
      { ...good, obsolete: true },
    ])
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toBe(3)
    expect(result.reasons).toEqual({ placeholder: 2, obsolete: 1 })
  })
})

describe('deciding whether to ask anyone', () => {
  const rows = [{ name: 'Lapte 1.5% 1L', maker: 'Zuzu', popularity: 40 }]
  // Enough branded rows to fill a dropdown, which is what "answered" now means.
  const plenty = Array.from({ length: 6 }, (_, i) => ({
    name: `Lapte ${i}`, maker: `Marca${i}`, popularity: 10,
  }))

  it('does not ask when there are enough branded rows to choose from', () => {
    expect(isLocalSufficient(plenty, 'lapte')).toBe(true)
  })

  it('still requires every word to match, not just a count', () => {
    // Six branded rows that are about something else are not an answer.
    expect(isLocalSufficient(plenty, 'pepsi zero')).toBe(false)
  })

  it('asks when one thin row is all there is', () => {
    // THE BUG THIS RULE EXISTS FOR. The old rule stopped here, so a seed row
    // named "Apă" answered every water search forever and the catalog could
    // never grow past what it shipped with.
    expect(isLocalSufficient(rows, 'lapte')).toBe(false)
    expect(isLocalSufficient(rows, 'lapte zuzu')).toBe(false)
  })

  it('does not count brandless concepts toward the total', () => {
    // "Apă", "Apă plată", "Apă minerală" are concepts, not things to buy.
    const generics = Array.from({ length: 9 }, (_, i) => ({
      name: `Apa ${i}`, maker: null, popularity: 50,
    }))
    expect(isLocalSufficient(generics, 'apa')).toBe(false)
  })

  it('asks when the local rows are about something else', () => {
    // The rows are non-empty, which is exactly the case a count-based rule gets
    // wrong: ten category matches are not an answer to "pepsi zero".
    expect(isLocalSufficient(rows, 'pepsi zero')).toBe(false)
    expect(isLocalSufficient([], 'pepsi')).toBe(false)
  })

  it('never asks for a query too short to mean anything (§6)', () => {
    expect(isLocalSufficient([], 'pe')).toBe(true)
    expect(isLocalSufficient([], 'p')).toBe(true)
    expect(isLocalSufficient([], 'pep')).toBe(false)
  })
})

describe('keeping the catalog clean', () => {
  const off = (name, extra = {}) => ({
    name,
    source: 'openfoodfacts',
    sourceId: extra.gtins?.[0] ?? name,
    ...extra,
  })

  it('drops results that do not answer the query', () => {
    // A real observation: search-a-licious answers "lapte" with "Chocolat au
    // lait". Storing it would put it in front of everyone who searches lapte,
    // forever, locally.
    const found = [off('Lapte Zuzu 1L'), off('Chocolat au lait'), off('Lapte de capra')]
    expect(relevantTo(found, 'lapte').map((p) => p.name))
      .toEqual(['Lapte Zuzu 1L', 'Lapte de capra'])
  })

  it('skips products the catalog already has', () => {
    const local = [{ name: 'Nutella', maker: 'Ferrero', popularity: 5 }]
    const found = [
      off('Nutella', { brand: 'Ferrero' }),
      off('Nutella Biscuits', { brand: 'Ferrero' }),
    ]
    expect(withoutKnown(found, local).map((p) => p.name)).toEqual(['Nutella Biscuits'])
  })

  it('treats a nameless local row as the same product only on an exact match', () => {
    const local = [{ name: 'Lapte', maker: null, popularity: 100 }]
    expect(withoutKnown([off('Lapte')], local)).toHaveLength(0)
    // Same name, but branded: a different row, and the database keeps it apart.
    expect(withoutKnown([off('Lapte', { brand: 'Zuzu' })], local)).toHaveLength(1)
  })

  it('collapses one product returned under several barcodes into one row', () => {
    const found = [
      off('Pepsi Zero', { brand: 'Pepsi', gtins: ['1111111111111'], markets: ['RO'] }),
      off('pepsi  zero', { brand: 'Pepsi', gtins: ['2222222222222'], markets: ['FR'], imageUrl: 'https://x/y.jpg' }),
    ]
    const [merged] = collapse(found)
    expect(collapse(found)).toHaveLength(1)
    expect(merged.gtins.sort()).toEqual(['1111111111111', '2222222222222'])
    // Markets union, exactly as the import RPC does one step later.
    expect(merged.markets.sort()).toEqual(['FR', 'RO'])
    // And the blank is filled from whichever record had it.
    expect(merged.imageUrl).toBe('https://x/y.jpg')
  })

  it('keeps two package sizes apart (§14)', () => {
    const found = [
      off('Pepsi Zero 500ml', { brand: 'Pepsi', gtins: ['1111111111111'] }),
      off('Pepsi Zero 2L', { brand: 'Pepsi', gtins: ['2222222222222'] }),
    ]
    expect(collapse(found)).toHaveLength(2)
  })

  it('never sets an editorial weight on a discovered product', () => {
    const [row] = toImportRows([off('X', { brand: 'Y', gtins: ['1111111111111'] })])
    // base_weight belongs to the curated seed; the RPC would refuse it anyway,
    // and sending it would mean two places claiming to decide the same thing.
    expect('weight' in row).toBe(false)
    expect(row.type).toBe('commercial')
  })

  it('labels a name in the language the source stated, never the searcher\'s', () => {
    expect(toImportRows([off('Nutella', { lang: 'fr', brand: 'F', gtins: ['1111111111111'] })])[0].lang)
      .toBe('fr')
    // No language upstream means English, not a guess from who was searching.
    expect(toImportRows([off('X', { brand: 'F', gtins: ['1111111111111'] })])[0].lang).toBe('en')
  })
})

describe('the pipeline, in order', () => {
  const off = (name, extra = {}) => ({
    name,
    source: 'openfoodfacts',
    sourceId: extra.gtins?.[0] ?? name,
    ...extra,
  })

  it('reports what happened to every product it was given', () => {
    const found = [
      off('Pepsi Zero 500ml', { brand: 'Pepsi', gtins: ['1111111111111'] }), // kept
      off('Pepsi Zero 500ml', { brand: 'Pepsi', gtins: ['3333333333333'] }), // collapsed
      off('Pepsi Zero 2L', { brand: 'Pepsi', gtins: ['2222222222222'] }),    // already known
      // Relevant to the query but nothing identifies it: no brand, no barcode.
      // It has to be RELEVANT to reach the gate at all, because relevance runs
      // first -- a product that was never an answer to this query should not
      // turn up in the rejection counts as if it were a quality problem.
      off('Pepsi Zero Mystery'),                                             // rejected
      off('Coca Cola', { brand: 'Coke', gtins: ['4444444444444'] }),         // irrelevant
    ]
    const local = [{ name: 'Pepsi Zero 2L', maker: 'Pepsi', popularity: 3 }]

    const { rows, stats } = pipeline(found, 'pepsi zero', local)

    expect(stats.returned).toBe(5)
    expect(stats.irrelevant).toBe(1)   // Coca Cola
    expect(stats.rejected).toBe(1)     // the placeholder
    expect(stats.collapsed).toBe(1)    // the duplicate 500ml
    expect(stats.alreadyKnown).toBe(1) // the 2L
    expect(stats.accepted).toBe(1)
    expect(rows.map((r) => r.name)).toEqual(['Pepsi Zero 500ml'])
  })

  it('caps how many products one search may add (§29.2)', () => {
    // A live run of "milka oreo" returned nineteen records and accepted fifteen,
    // because upstream carries the same biscuit under four different brand
    // attributions and collapse() correctly refuses to merge them. The fix is a
    // cap, not a cleverer dedupe: merging them would be the confident wrong
    // merge §15 forbids.
    const many = Array.from({ length: 20 }, (_, i) =>
      off(`Milka Oreo ${i}`, { brand: `Brand${i}`, gtins: [`111111111111${i % 10}`] }),
    )
    const { rows, stats } = pipeline(many, 'milka oreo', [])
    expect(rows).toHaveLength(8)
    expect(stats.accepted).toBe(8)
    expect(stats.overflow).toBe(12)
  })

  it('lets a one-word browse take more, since it is filling a hole', () => {
    // "apa" accepted 8 and threw away 15 that had already passed every filter.
    // A category query is somebody looking to see what there is, and the ninth
    // product should not cost the next person another round trip.
    const many = Array.from({ length: 25 }, (_, i) =>
      off(`Apa plata ${i}`, { brand: `Marca${i}`, gtins: [`222222222222${i % 10}`] }),
    )
    const { rows } = pipeline(many, 'apa', [])
    expect(rows).toHaveLength(20)
  })

  it('but a named product still stops at eight however empty the catalog is', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      off(`Milka Oreo ${i}`, { brand: `Brand${i}`, gtins: [`333333333333${i % 10}`] }),
    )
    expect(pipeline(many, 'milka oreo', []).rows).toHaveLength(8)
  })

  it('keeps the most complete records rather than the first ones', () => {
    const thin = off('Milka Oreo A', { brand: 'Milka' })
    const rich = off('Milka Oreo B', {
      brand: 'Milka', gtins: ['1111111111111'], markets: ['RO'],
      category: 'snacks', quantity: 154, quantityUnit: 'g',
      imageUrl: 'https://x/y.jpg', uniqueScans: 900,
    })
    // Thin arrives first, which is the source's ranking and nothing to do with
    // which record describes the product better.
    const { rows } = pipeline([thin, rich], 'milka oreo', [], { maxAccepted: 1 })
    expect(rows[0].name).toBe('Milka Oreo B')
  })

  it('accepts nothing at all rather than something wrong', () => {
    const { rows, stats } = pipeline([off('Chocolat au lait')], 'lapte', [])
    expect(rows).toEqual([])
    expect(stats.irrelevant).toBe(1)
  })
})

describe('surviving a source that is down (§19)', () => {
  const failing = () => Promise.reject(new Error('ECONNREFUSED'))

  it('returns an empty list rather than throwing', async () => {
    const adapter = new OpenFoodFactsAdapter({
      fetchImpl: failing,
      retries: 0,
      sleep: async () => {},
    })
    await expect(adapter.search('pepsi')).resolves.toEqual([])
    await expect(adapter.getByBarcode(['5941234567890'])).resolves.toBeNull()
  })

  it('stops calling a source that keeps failing, and says so', async () => {
    let calls = 0
    let clock = 0
    const adapter = new OpenFoodFactsAdapter({
      fetchImpl: () => { calls++; return failing() },
      retries: 0,
      sleep: async () => {},
      now: () => clock,
    })

    for (let i = 0; i < 4; i++) await adapter.search('pepsi')
    expect(calls).toBe(4)
    expect(adapter.circuitOpen).toBe(true)

    // Open: no further calls leave the building, which is what stops an outage
    // from costing every keystroke a full timeout.
    await adapter.search('pepsi')
    expect(calls).toBe(4)

    // ...and it closes again on its own.
    clock += 61_000
    expect(adapter.circuitOpen).toBe(false)
    await adapter.search('pepsi')
    expect(calls).toBe(5)
  })

  it('retries a 500 and does not retry a 404', async () => {
    let calls = 0
    const status = (code) => async () => {
      calls++
      return new Response('{}', { status: code })
    }

    const onFiveHundred = new OpenFoodFactsAdapter({
      fetchImpl: status(500), retries: 2, sleep: async () => {},
    })
    await onFiveHundred.search('x')
    expect(calls).toBe(3)

    calls = 0
    const onFourOhFour = new OpenFoodFactsAdapter({
      fetchImpl: status(404), retries: 2, sleep: async () => {},
    })
    await onFourOhFour.search('x')
    // Retrying an identical request the server already refused just spends the
    // timeout again.
    expect(calls).toBe(1)
  })

  it('asks for only the fields the catalog stores, with a User-Agent', async () => {
    let seen
    const adapter = new OpenFoodFactsAdapter({
      userAgent: 'FamCart/test',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init }
        return new Response(JSON.stringify({ hits: [OFF_HIT] }))
      },
    })

    const products = await adapter.search('nutella', { language: 'ro', maxResults: 5 })
    expect(products).toHaveLength(1)

    const url = new URL(seen.url)
    expect(url.origin).toBe('https://search.openfoodfacts.org')
    expect(url.searchParams.get('q')).toBe('nutella')
    expect(url.searchParams.get('page_size')).toBe('5')
    expect(url.searchParams.get('langs')).toBe('ro')
    // §8: limit requested fields. A bare request returns ~200 per product.
    expect(url.searchParams.get('fields')).toContain('product_name')
    expect(url.searchParams.get('fields')).not.toContain('nutriments')
    expect(seen.init.headers['User-Agent']).toBe('FamCart/test')
  })

  it('gives up when the caller aborts', async () => {
    const controller = new AbortController()
    const adapter = new OpenFoodFactsAdapter({
      retries: 3,
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError', signal: init.signal })
      },
    })
    await expect(adapter.search('x', { signal: controller.signal })).resolves.toEqual([])
  })
})

describe('intent decides whether anything external is asked at all', () => {
  const branded = (n) =>
    Array.from({ length: n }, (_, i) => ({ name: `Apa Plata ${i}L`, maker: `Dorna${i}`, popularity: 1 }))

  it('a GENERIC concept is answered by the bare row, however few there are', () => {
    // The regression the concept layer exists to fix in this direction.
    // Potatoes have no brands and never will, so counting branded rows sent
    // every produce query to an external database that could not possibly
    // improve on the row already on screen.
    const rows = [{ name: 'Cartofi', maker: null, popularity: 100 }]
    expect(isLocalSufficient(rows, 'cartofi')).toBe(false)
    expect(isLocalSufficient(rows, 'cartofi', { intent: 'generic' })).toBe(true)
  })

  it('a BRANDED concept is not answered by a generic row, however popular', () => {
    // And the regression in the other direction: "Apă" contains every word
    // typed, so the old rule declared the question answered and discovery never
    // ran for water at all.
    const rows = [{ name: 'Apă', maker: null, popularity: 10_000 }]
    expect(isLocalSufficient(rows, 'apa', { intent: 'branded' })).toBe(false)
  })

  it('a BRANDED concept is answered once there are enough real products', () => {
    expect(isLocalSufficient(branded(6), 'apa', { intent: 'branded' })).toBe(true)
    expect(isLocalSufficient(branded(5), 'apa', { intent: 'branded' })).toBe(false)
  })

  it('a MIXED concept wants real products too; it differs in RANKING, not in asking', () => {
    const thin = [{ name: 'Lapte', maker: null, popularity: 100 }]
    expect(isLocalSufficient(thin, 'lapte', { intent: 'mixed' })).toBe(false)
  })

  it('an unknown word is treated as branded, which is what makes chorizo work', () => {
    // No concept claims it, so nothing local can be trusted to have answered.
    expect(isLocalSufficient([], 'chorizo', { intent: null })).toBe(false)
    expect(isLocalSufficient([{ name: 'Chorizo Iberico', maker: null, popularity: 1 }], 'chorizo'))
      .toBe(false)
  })

  it('still refuses to ask about two characters, whatever the intent', () => {
    // S6: below three characters an external search returns noise proportional
    // to how common the letters are.
    expect(isLocalSufficient([], 'ap', { intent: 'branded' })).toBe(true)
  })

  it('caps a thin generic-concept result at the ordinary eight, not the cold twenty', () => {
    // capFor asks the same question isLocalSufficient does. A generic concept
    // that somehow reached the pipeline is not a catalog being filled.
    const rows = [{ name: 'Cartofi', maker: null, popularity: 100 }]
    expect(capFor(rows, 'cartofi', 'generic')).toBe(8)
    expect(capFor(rows, 'cartofi', 'branded')).toBe(20)
  })
})
