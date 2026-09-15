// Gift sets and product-plus-object packs, which the importer refuses. Every
// name here is a real listing from the live catalog, 2026-09-15.

import { describe, it, expect } from 'vitest'
import { isBundle } from '../src/core/bundles.ts'

describe('isBundle', () => {
  it('refuses a drink sold with glasses, a bag or a toy', () => {
    expect(isBundle('Whisky Jack Daniel\'s Tennessee Honey, alcool 35%, 0.7 l + 2 pahare')).toBe(true)
    expect(isBundle('Bere blonda Budweiser Budvar, 6 x 0.5 l + geanta termica')).toBe(true)
    expect(isBundle('Lapte UHT integral Fulga, 3.5% grasime, 5 x 1 l + jucarie Fulga')).toBe(true)
    expect(isBundle('Brandy Metaxa 7*, 40%, 0.7l+pahar')).toBe(true)
    expect(isBundle('Pachet Dalin: Sampon 750ml + Cana')).toBe(true)
  })

  it('refuses one whose quantity comes after the object', () => {
    expect(isBundle('Gin Bombay + pahar , 47.5% alc., 0.7L')).toBe(true)
    expect(isBundle('Vodka Stalinskaya Gold, 40% alcool + 1 pahar')).toBe(true)
  })

  it('refuses a gift set, whatever is in it', () => {
    expect(isBundle('Set pentru cadou Adidas Ice Dive: Apa de toaleta, 100 ml + Gel de dus, 250 ml')).toBe(true)
    expect(isBundle('Set cadou 2 prosoape 50/80 cm + 3 lumanari')).toBe(true)
    expect(isBundle('Pachet pentru cadou Rom Havana Cuban, 35% 0.7 l + 2 Pahare')).toBe(true)
  })

  it('keeps two groceries sold together, and names that only contain a plus', () => {
    expect(isBundle('Bautura carbogazoasa Coca-Cola, 2 x 2 l + Coca-Cola Zero, 1 x 2 l')).toBe(false)
    expect(isBundle('Piept de pui vidat Caroli, +/- 300 g')).toBe(false)
    expect(isBundle('Deodorant Men+Care Odor Defense Dove, 150ml')).toBe(false)
    expect(isBundle('Piurea Bio legume cremoase cu orez si naut, +8 luni,220 g, Hipp')).toBe(false)
    expect(isBundle('Cana filtranta Brita Aluna, 2.4 l + 3 filtre Brita Maxtra Pro')).toBe(false)
  })

  it('keeps kitchenware sold as a set, and a bottle in a gift box', () => {
    expect(isBundle('Carafa 1 l + 6 cani din ceramica, 150 ml')).toBe(false)
    expect(isBundle('Set carafa 1200 ml+6 pahare vin 260 ml Lav, Transparent')).toBe(false)
    expect(isBundle('Vinars Divin Apriori Maestro 10 ani, Reserva XO, 40%, 0.7l + Gift Box')).toBe(false)
  })

  it('reads a name with diacritics the same as without', () => {
    expect(isBundle('Pălincă de prune, 0.5 l + 2 pahare')).toBe(true)
  })

  it('leaves a plain product alone', () => {
    expect(isBundle('Whisky Jack Daniel\'s Tennessee, 0.7 l')).toBe(false)
  })
})
