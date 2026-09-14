// Which products are groceries, shop by shop, and how a crawl reports the rest.
//
// Every shop here also sells clothes, toys, flowers and electronics, and until
// now all of it was imported. Each rule reads the SHOP'S OWN DEPARTMENT, never a
// product name: a name guesses, and a department is the shop saying where the
// product lives. Our own category column is no substitute either -- Carrefour's
// "baby" aisle holds rompers and picture books next to the nappies.
//
// A product outside groceries is reported as EXCLUDED, and the importer removes
// what was already imported from it. That is why the reporting is tested as
// carefully as the rules: an id reported by mistake is a product deleted.

import { describe, it, expect } from 'vitest'
import { fixtureFetch, callsOf, collect, testLogger } from './helpers.ts'
import { isAuchanGrocery } from '../src/retailers/auchan/vtex.ts'
import { carrefourDepartmentIsGrocery } from '../src/retailers/carrefour/departments.ts'
import { megaImageIsGrocery } from '../src/retailers/mega-image/index.ts'
import { SCRAPERS } from '../src/core/registry.ts'

describe('auchan: the category path', () => {
  it('keeps food, drink, cleaning and personal care', () => {
    expect(isAuchanGrocery(['/Lactate si oua/Lapte/', '/Lactate si oua/'])).toBe(true)
    expect(isAuchanGrocery(['/Bauturi si Tutun/Apa/'])).toBe(true)
    expect(isAuchanGrocery(['/Curatenie si intretinere casa/Detergent rufe/'])).toBe(true)
    expect(isAuchanGrocery(['/Ingrijire personala si Cosmetice/Igiena dentara/'])).toBe(true)
    expect(isAuchanGrocery(['/Pet Shop/Pisici/'])).toBe(true)
  })

  it('drops flowers, clothes, toys and electronics', () => {
    expect(isAuchanGrocery(['/Auto, Gradina si Bricolaj/Flori/'])).toBe(false)
    expect(isAuchanGrocery(['/Fashion/InExtenso/'])).toBe(false)
    expect(isAuchanGrocery(['/Jucarii si Timp Liber/Jucarii/'])).toBe(false)
    expect(isAuchanGrocery(['/Electro, Climatizare si Aparate ingrijire/Electronice/'])).toBe(false)
  })

  it('decides a mixed aisle by the one below it', () => {
    expect(isAuchanGrocery(['/Bebe/Mancare bebe/'])).toBe(true)
    expect(isAuchanGrocery(['/Bebe/Jucarii bebelusi/'])).toBe(false)
    expect(isAuchanGrocery(['/Casa si Curatenie/Vesela si Accesorii bucatarie/'])).toBe(true)
    expect(isAuchanGrocery(['/Casa si Curatenie/Textile si Covoare/'])).toBe(false)
    expect(isAuchanGrocery(['/Bucurie de Craciun/Ciocolata si dulciuri/'])).toBe(true)
    expect(isAuchanGrocery(['/Craciun/Brazi artificiali si decoratiuni/'])).toBe(false)
  })

  it('keeps a product filed under both a seasonal shelf and a grocery one', () => {
    expect(isAuchanGrocery(['/Bucurie de Craciun/Decoratiuni de Craciun/', '/Bacanie/Dulciuri/'])).toBe(true)
  })

  it('drops a product filed nowhere', () => {
    expect(isAuchanGrocery([])).toBe(false)
    expect(isAuchanGrocery(undefined)).toBe(false)
  })
})

describe('carrefour: the department', () => {
  it('keeps the grocery departments', () => {
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/bacanie-carrefour/alimente/cafea')).toBe(true)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/bacanie-carrefour/')).toBe(true)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/cosmetice-si-ingrijire-personala/ingrijire-personala')).toBe(true)
  })

  it('keeps cleaning, kitchen and pet food out of the home department, and nothing else', () => {
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/casa-gradina-si-petshop/petshop/hrana-caini')).toBe(true)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/casa-gradina-si-petshop/produse-curatenie-pentru-casa')).toBe(true)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/casa-gradina-si-petshop/mobila-casa')).toBe(false)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/casa-gradina-si-petshop/accesorii-gradina')).toBe(false)
  })

  it('keeps nappies and baby food, not rompers or pushchairs', () => {
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/articole-bebelusi/scutece-si-servetele-umede')).toBe(true)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/articole-bebelusi/imbracaminte-bebelusi')).toBe(false)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/articole-bebelusi/carucioare-si-plimbare-copii')).toBe(false)
  })

  it('drops clothing, books and promotions', () => {
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/tex/femei')).toBe(false)
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/carti-papetarie-si-educatie/carti')).toBe(false)
    // A promotion is not a department. A product in one that is ALSO in a
    // grocery department is kept by that department; see the Carrefour crawl.
    expect(carrefourDepartmentIsGrocery('https://carrefour.ro/promotii-crf/stay-fit')).toBe(false)
  })
})

describe('mega image: the department in the URL', () => {
  const url = (path: string) => `https://www.mega-image.ro${path}`

  it('keeps the grocery departments and the themed food ones', () => {
    expect(megaImageIsGrocery(url('/Lactate-si-oua/Branzeturi/Telemea/p/1'))).toBe(true)
    expect(megaImageIsGrocery(url('/Curatenie-si-nealimentare/Detergent-si-balsam-de-rufe/Detergent/p/1'))).toBe(true)
    expect(megaImageIsGrocery(url('/Calitate-la-preturi-bune-zi-de-zi/Sirop-de-artar-250ml/p/28721'))).toBe(true)
  })

  it('drops the seasonal shop, electronics and toys', () => {
    expect(megaImageIsGrocery(url('/Produse-sezoniere/Campanii/French-Bull/Geanta-pentru-weekend/p/70896'))).toBe(false)
    expect(megaImageIsGrocery(url('/Curatenie-si-nealimentare/Electronice-si-auto/Baterii/Baterie-alcalina-9V/p/49758'))).toBe(false)
    expect(megaImageIsGrocery(url('/Mama-si-ingrijire-copil/Jucarii-si-accesorii-petrecere/Balon/p/1'))).toBe(false)
    expect(megaImageIsGrocery(url('/Gaming/Controller-wireless-negru-DualSense-V2/p/1'))).toBe(false)
  })
})

describe('a page crawl reports what it leaves out', () => {
  const robots = { match: '/robots.txt', body: 'User-agent: *\nDisallow: /checkout\n' }
  const urlset = (urls: string[]) =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
      .map((u) => `<url><loc>${u}</loc><lastmod>2026-09-14</lastmod></url>`)
      .join('')}</urlset>`

  it('reports the id of a page it read and refused, and nothing it kept', async () => {
    const fetchImpl = fixtureFetch([
      robots,
      {
        match: 'product_sitemap',
        body: urlset([
          'https://www.lidl.de/p/loch-lomond-single-malt-scotch-whisky-12-jahre-46-vol/p100269218',
          'https://www.lidl.de/p/parkside-heckenschere-teleskop/p100397648',
        ]),
      },
      { match: 'loch-lomond', file: 'lidl-eu/de-drinks.html.gz' },
      { match: 'heckenschere', file: 'lidl-eu/de-garden.html.gz' },
    ])
    const excluded: string[] = []
    const scraper = SCRAPERS.find((s) => s.retailer === 'lidl-de')!
    await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: (id: string) => excluded.push(id),
      }),
    )
    expect(excluded).toEqual(['100397648'])
  })

  it('refuses a page by its URL without fetching it, and still counts it as covered', async () => {
    const grocery = 'https://www.mega-image.ro/Lactate-si-oua/Branzeturi/Telemea/p/12345'
    const seasonal = 'https://www.mega-image.ro/Produse-sezoniere/Campanii/French-Bull/Geanta/p/70896'
    const fetchImpl = fixtureFetch([
      robots,
      { match: 'delhaizesitemapindex', body: urlset([grocery, seasonal]) },
      { match: '/p/12345', file: 'mega-image/product-instock.html.gz' },
    ])
    const excluded: string[] = []
    let coverage: [number, number] | null = null
    const scraper = SCRAPERS.find((s) => s.retailer === 'mega-image')!
    const products = await collect(
      scraper.discoverProducts({
        log: testLogger(),
        fetchImpl,
        minIntervalMs: 0,
        reportExcluded: (id: string) => excluded.push(id),
        reportCoverage: (seen: number, advertised: number) => {
          coverage = [seen, advertised]
        },
      }),
    )
    expect(products).toHaveLength(1)
    expect(excluded).toEqual(['70896'])
    expect(callsOf(fetchImpl).some((u) => u.includes('Produse-sezoniere'))).toBe(false)
    expect(coverage).toEqual([2, 2])
  })
})
