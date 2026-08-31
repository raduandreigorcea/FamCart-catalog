import { describe, it, expect } from 'vitest'
import {
  OpenFoodFactsAdapter,
  OpenProductsFactsAdapter,
  OpenBeautyFactsAdapter,
  createAdapters,
} from '../supabase/functions/_shared/sources/index.ts'
import {
  groupBySource,
  toImportRows,
  pipeline,
  relevantTo,
  stripCategoryBrands,
  withoutBareConcepts,
} from '../supabase/functions/_shared/discover.ts'
import live from './fixtures/openFactsResponses.json' with { type: 'json' }

// The three Open*Facts databases, behind one adapter.
//
// WHAT THESE FIXTURES ARE. Not hand-written examples of what the APIs are
// believed to return — actual captured responses from the live services, the
// same way fixtures/fold.json holds what a running Postgres actually answered.
// The whole reason the sibling sources needed their own code path is a
// difference nobody would have invented from documentation: Open Food Facts
// answers search-a-licious with `hits` and an ARRAY of brands, while the other
// two answer the legacy cgi/search.pl with `products` and a COMMA-SEPARATED
// STRING. A fixture is what stops that from regressing silently, because both
// shapes parse without error and only one of them produces products.
//
// Nothing here touches the network. `fetchImpl` is injected per adapter rather
// than patching global fetch, because a patched global leaks into every other
// file in the run and the failure surfaces somewhere else entirely.

const respond = (body) => async () => new Response(JSON.stringify(body))

describe('the legacy envelope the two siblings answer with', () => {
  it('reads Open Beauty Facts products out of `products`, not `hits`', async () => {
    const adapter = new OpenBeautyFactsAdapter({ fetchImpl: respond(live.obfSearchShampoo) })
    const found = await adapter.search('shampoo')

    // Six records came back; the two with an empty product_name are dropped by
    // normalize() because a product with no name has nothing to be found by.
    expect(found.length).toBe(4)
    expect(found[0]).toMatchObject({
      name: 'Coconut Milk',
      brand: 'Herbal Essences',
      source: 'openbeautyfacts',
      sourceId: '8001090662231',
    })
  })

  it('reads Open Products Facts the same way', async () => {
    const adapter = new OpenProductsFactsAdapter({ fetchImpl: respond(live.opfSearchNappies) })
    const found = await adapter.search('nappies')

    expect(found.length).toBe(6)
    expect(found.map((p) => p.source)).toEqual(Array(6).fill('openproductsfacts'))
    expect(found[0]).toMatchObject({ name: 'Nappies', brand: 'Pampers' })
  })

  it('would find nothing if it read the wrong envelope', async () => {
    // The mistake this whole file exists to catch: pointing a sibling at the
    // search-a-licious reader parses fine and returns silence.
    const asFood = new OpenFoodFactsAdapter({ fetchImpl: respond(live.obfSearchShampoo) })
    expect(await asFood.search('shampoo')).toEqual([])
  })

  it('splits the comma-separated brand string and keeps only the first', async () => {
    const adapter = new OpenProductsFactsAdapter({
      fetchImpl: respond({
        products: [{ code: '5000394140851', product_name: 'AA batteries', brands: 'Duracell, Procter & Gamble' }],
      }),
    })
    const [found] = await adapter.search('batteries')
    expect(found.brand).toBe('Duracell')
  })
})

describe('where each source sends its request', () => {
  it('sends the siblings to cgi/search.pl with the incantation that returns JSON', async () => {
    let seen
    const adapter = new OpenBeautyFactsAdapter({
      fetchImpl: async (url) => {
        seen = String(url)
        return new Response('{"products":[]}')
      },
    })
    await adapter.search('toothpaste')

    expect(seen).toContain('https://world.openbeautyfacts.org/cgi/search.pl')
    // All three are required. Without them the endpoint returns a web page.
    expect(seen).toContain('search_simple=1')
    expect(seen).toContain('action=process')
    expect(seen).toContain('json=1')
    expect(seen).toContain('search_terms=toothpaste')
    // Only the fields with somewhere to go. A bare request is ~200 fields.
    expect(seen).toContain('fields=code%2Cproduct_name')
  })

  it('leaves Open Food Facts on search-a-licious', async () => {
    let seen
    const adapter = new OpenFoodFactsAdapter({
      fetchImpl: async (url) => {
        seen = String(url)
        return new Response('{"hits":[]}')
      },
    })
    await adapter.search('lapte', { language: 'ro' })

    expect(seen).toContain('https://search.openfoodfacts.org/search?')
    expect(seen).toContain('q=lapte')
    // A hint, not a filter.
    expect(seen).toContain('langs=ro')
  })

  it('resolves a barcode against each source’s own host', async () => {
    const seen = []
    const options = {
      fetchImpl: async (url) => {
        seen.push(String(url))
        return new Response('{"status":0}')
      },
    }
    await new OpenBeautyFactsAdapter(options).getByBarcode(['8001090662231'])
    await new OpenProductsFactsAdapter(options).getByBarcode(['8001090662231'])

    expect(seen[0]).toContain('https://world.openbeautyfacts.org/api/v2/product/8001090662231.json')
    expect(seen[1]).toContain('https://world.openproductsfacts.org/api/v2/product/8001090662231.json')
    // The one field the search endpoint does not report.
    expect(seen[0]).toContain('obsolete')
  })
})

describe('a barcode that only a sibling knows', () => {
  it('normalizes the v2 product envelope into a catalog row', async () => {
    const adapter = new OpenBeautyFactsAdapter({ fetchImpl: respond(live.obfBarcode) })
    const found = await adapter.getByBarcode(['8001090662231'])

    expect(found).toMatchObject({
      name: 'Coconut Milk',
      brand: 'Herbal Essences',
      source: 'openbeautyfacts',
      gtins: ['8001090662231'],
      quantity: 400,
      quantityUnit: 'ml',
      lang: 'fr',
    })
    // Attribution is a licence condition, so the URL has to point at the
    // database the row actually came from.
    expect(found.sourceUrl).toBe('https://world.openbeautyfacts.org/product/8001090662231')
  })

  it('places it on a shelf this app has', async () => {
    const adapter = new OpenBeautyFactsAdapter({ fetchImpl: respond(live.obfBarcode) })
    const found = await adapter.getByBarcode(['8001090662231'])
    // Beauty tags run specific to broad and the last match wins, so a shampoo
    // lands on personal-care rather than on nothing.
    expect(found.category).toBe('personal-care')
  })
})

describe('three sources, one catalog', () => {
  it('builds three adapters with independent circuit breakers', async () => {
    let clock = 0
    const [food, products, beauty] = createAdapters({
      fetchImpl: async (url) =>
        String(url).includes('openbeautyfacts')
          ? Promise.reject(new Error('ECONNREFUSED'))
          : new Response('{"hits":[],"products":[]}'),
      retries: 0,
      sleep: async () => {},
      now: () => clock,
    })

    for (let i = 0; i < 4; i++) await beauty.search('shampoo')
    expect(beauty.circuitOpen).toBe(true)

    // The whole point of an instance per source: one database being down must
    // not silence the other two.
    expect(food.circuitOpen).toBe(false)
    expect(products.circuitOpen).toBe(false)
  })

  it('tells a failed request apart from an empty answer', async () => {
    const healthy = new OpenProductsFactsAdapter({ fetchImpl: respond({ products: [] }) })
    expect(await healthy.search('zzzz')).toEqual([])
    // Nothing there, and we know it. Cacheable as a miss.
    expect(healthy.lastRequestFailed).toBe(false)

    const down = new OpenProductsFactsAdapter({
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
      retries: 0,
      sleep: async () => {},
    })
    expect(await down.search('zzzz')).toEqual([])
    // We learned nothing. Caching this as a miss would freeze a hole in the
    // catalog for a day.
    expect(down.lastRequestFailed).toBe(true)
  })

  it('keeps provenance per row when the batch spans sources', async () => {
    const beauty = new OpenBeautyFactsAdapter({ fetchImpl: respond(live.obfSearchShampoo) })
    const products = new OpenProductsFactsAdapter({
      fetchImpl: respond({
        products: [
          { code: '5000394140851', product_name: 'Shampoo bar', brands: 'Lush' },
        ],
      }),
    })

    const found = [...(await beauty.search('shampoo')), ...(await products.search('shampoo'))]
    const { rows } = pipeline(found, 'shampoo', [])
    const groups = groupBySource(rows)

    expect([...groups.keys()].sort()).toEqual(['openbeautyfacts', 'openproductsfacts'])
    // Every row in a group must be able to go to catalog_import_products under
    // that group's source name and be attributed truthfully.
    for (const [source, group] of groups) {
      expect(group.every((r) => r.source === source)).toBe(true)
    }
  })

  it('collapses the same product arriving from two databases', () => {
    const fromFood = {
      name: 'Sensodyne', brand: 'GSK', source: 'openfoodfacts', sourceId: '1',
      gtins: ['5054563042941'], markets: ['GB'],
    }
    const fromBeauty = {
      name: 'Sensodyne', brand: 'GSK', source: 'openbeautyfacts', sourceId: '2',
      gtins: ['5054563042958'], markets: ['FR'], imageUrl: 'https://x/y.jpg',
    }

    const { rows } = pipeline([fromFood, fromBeauty], 'sensodyne', [])
    expect(rows.length).toBe(1)
    // Both barcodes are exact keys for the one product, and a source that only
    // knows about France is not evidence against Britain.
    expect(rows[0].gtins.sort()).toEqual(['5054563042941', '5054563042958'])
    expect(rows[0].markets.sort()).toEqual(['FR', 'GB'])
  })
})

describe('toImportRows carries the source', () => {
  it('states which database each row came from', () => {
    const rows = toImportRows([
      { name: 'Nappies', source: 'openproductsfacts', sourceId: '1' },
      { name: 'Shampoo', source: 'openbeautyfacts', sourceId: '2' },
    ])
    expect(rows.map((r) => r.source)).toEqual(['openproductsfacts', 'openbeautyfacts'])
  })
})

describe('the brands field is not always a brand', () => {
  // WHAT THESE CASES ARE. Not invented examples -- the exact `brands` strings
  // that came back from Open Food Facts for a live "chorizo" search, which is
  // what made this rule necessary. Every one of the eight had category text in
  // the brand.
  const normalized = (product_name, brands) =>
    new OpenProductsFactsAdapter({}).normalize({ code: '1234567890123', product_name, brands })

  it('KEEPS a brand the product name contains, which is most real brands', () => {
    // Measured, not assumed. Stripping these flagged 36 live rows and about 28
    // were real: naming a product "<Brand> <Thing>" is the commonest convention
    // there is. A category word that happens to sit in the brand is caught by
    // the concept check in the discovery function, where the words are known.
    expect(normalized('Pampers Nappies', 'Pampers').brand).toBe('Pampers')
    expect(normalized('Hochland Cascaval pane', 'Hochland').brand).toBe('Hochland')
    expect(normalized('Energizer A23 batteries Alkaline', 'Energizer').brand).toBe('Energizer')
    expect(normalized('Ciocolata Milka', 'Milka').brand).toBe('Milka')
  })

  it('drops a brand that is a sentence rather than a name', () => {
    expect(normalized('All Natural Chicken Chorizo', "Chorizo De San Manuel Guerra's Brand Inc").brand)
      .toBeUndefined()
    expect(normalized("Ben's Original", 'Favourites Chorizo And Vegetable Paella').brand)
      .toBeUndefined()
  })

  it('keeps a brand that is simply the same as the name', () => {
    expect(normalized('Nutella', 'Nutella, Ferrero').brand).toBe('Nutella')
  })

  it('keeps real brands, including ones longer than the product name', () => {
    // Izvorul Minunilor is longer than "Apa Plata 5L" and is a real Romanian
    // brand, which is why the length rule counts WORDS and never compares
    // against the name's length.
    expect(normalized('Apa Plata 5L', 'Izvorul Minunilor').brand).toBe('Izvorul Minunilor')
    expect(normalized('Apa Minerala 1.5L', 'Perla Harghitei').brand).toBe('Perla Harghitei')
    expect(normalized('Shampoo bar', 'Faith In Nature').brand).toBe('Faith In Nature')
    expect(normalized('Ciocolata cu lapte', 'Milka').brand).toBe('Milka')
  })

  it('keeps a four-word brand, because real ones exist', () => {
    // Tesco's actual nappy range. Four was the first threshold tried and this
    // is the row that ruled it out.
    expect(normalized('ultra dry nappies', 'Tesco Fred and Flo').brand).toBe('Tesco Fred and Flo')
  })

  it('keeps a real brand that contains the category word', () => {
    // The rule deliberately NOT added. "brand contains the thing searched for"
    // would catch the three chorizo stragglers and take these with them, and a
    // true brand deleted is the same error as a false one invented.
    expect(normalized('Cola Zero 500ml', 'Coca-Cola').brand).toBe('Coca-Cola')
    expect(normalized('Pizza Margherita', 'Pizza Hut').brand).toBe('Pizza Hut')
  })

  it('stops a non-chorizo reaching a chorizo search once its brand is gone', () => {
    // The reason this is fixed at ingest and not at display. "Ben's Original"
    // is a PAELLA RICE; it passed relevantTo() only because the junk brand
    // contained the query.
    const paella = normalized("Ben's Original", 'Favourites Chorizo And Vegetable Paella')
    expect(relevantTo([paella], 'chorizo')).toEqual([])
  })
})

describe('a brand that is really the category', () => {
  // The words come from catalog_concept_terms -- the curated list of common
  // nouns this catalog knows, in six languages. Equality against that list is
  // the only thing that reliably separates "Chorizo" from "Pampers", and it is
  // a lookup rather than a guess.
  const CHORIZO = ['Chorizo']
  const SHAMPOO = ['Shampoo', 'Șampon', 'Champú', 'Shampooing']

  it('clears a brand that IS the concept word', () => {
    const [p] = stripCategoryBrands([{ name: 'Chorizo doux', brand: 'Chorizo' }], CHORIZO)
    expect(p.brand).toBeUndefined()
    expect(p.name).toBe('Chorizo doux')
  })

  it('matches the concept word in any of the six languages', () => {
    const [p] = stripCategoryBrands(
      [{ name: 'Alpecin HYBRID Caffeine Shampoo', brand: 'Champú' }], SHAMPOO)
    expect(p.brand).toBeUndefined()
  })

  it('folds before comparing, so case and accents do not matter', () => {
    const [p] = stripCategoryBrands([{ name: 'Sampon uscat', brand: 'sampon' }], SHAMPOO)
    expect(p.brand).toBeUndefined()
  })

  it('leaves a real brand completely alone', () => {
    const kept = stripCategoryBrands([
      { name: 'Pampers Nappies', brand: 'Pampers' },
      { name: 'Chorizo Iberico', brand: 'Campofrio' },
      { name: 'Cola Zero', brand: 'Coca-Cola' },
    ], [...CHORIZO, 'Cola'])
    expect(kept.map((p) => p.brand)).toEqual(['Pampers', 'Campofrio', 'Coca-Cola'])
  })

  it('does nothing at all when no concept resolved', () => {
    const products = [{ name: 'Chorizo doux', brand: 'Chorizo' }]
    expect(stripCategoryBrands(products, [])).toBe(products)
  })
})

describe('a result that is only the concept word', () => {
  const TERMS = ['Pâine', 'Bread', 'Batteries', 'Baterii']

  it('drops a bare concept word with no maker', () => {
    // A barcode and the word "Pâine". Identifiable, and useless on a list.
    const kept = withoutBareConcepts([{ name: 'Pâine', gtins: ['1'] }], TERMS)
    expect(kept).toEqual([])
  })

  it('keeps it when a brand makes it shoppable', () => {
    // "Pâine by Bacus" names a bakery, so whoever holds the list can buy it.
    const kept = withoutBareConcepts([{ name: 'Pâine', brand: 'Bacus' }], TERMS)
    expect(kept).toHaveLength(1)
  })

  it('keeps a brandless row whose name says more than the word', () => {
    // The rows the name test exists to protect: no maker, but a real package
    // size, so it is a product rather than a duplicate of the concept.
    const kept = withoutBareConcepts([
      { name: 'Pâine albă feliată 500g' },
      { name: 'Baterii AA 4 buc' },
    ], TERMS)
    expect(kept).toHaveLength(2)
  })

  it('folds before comparing, so case and diacritics do not smuggle one through', () => {
    expect(withoutBareConcepts([{ name: 'PAINE' }], TERMS)).toEqual([])
    expect(withoutBareConcepts([{ name: '  batterii  ' }], ['Batterii'])).toEqual([])
  })

  it('does nothing when no concept resolved', () => {
    const products = [{ name: 'Pâine' }]
    expect(withoutBareConcepts(products, [])).toBe(products)
  })

  it('runs AFTER the brand clean, so a junk brand cannot rescue a bare row', () => {
    // "Chorizo doux" by "Chorizo" loses its brand to stripCategoryBrands; a row
    // that is then just the word has nothing left and should go.
    const { rows } = pipeline(
      [{ name: 'Chorizo', brand: 'Chorizo', source: 'openfoodfacts', sourceId: '1' }],
      'chorizo',
      [],
      { categoryTerms: ['Chorizo'] },
    )
    expect(rows).toEqual([])
  })
})
