import {
  OpenFactsAdapter,
  legacySearchUrl,
  readLegacyEnvelope,
  type OpenFactsConfig,
} from './openFacts.ts'
import type { AdapterOptions, SourceContext } from './types.ts'

// Open Beauty Facts. Cosmetics, hygiene and personal care — toothpaste,
// shampoo, deodorant, soap, razors.
//
// It overlaps Open Products Facts and neither one replaces the other, which is
// the whole reason both are asked. Measured live, page of 20, after the
// pipeline's relevance filter: toothpaste 3 here against 1 there, shampoo 11
// against 18, dish soap 15 against 9 — while batteries and nappies are 0 here
// and 6 there. Asking one of the two would leave a different hole either way.
//
// Same legacy `cgi/search.pl` endpoint as its sibling, for the same reason:
// `search.openbeautyfacts.org` answers a 302 back to the main site.
//
// THE CATEGORY MAP LEANS ON A QUIRK worth stating. This database's
// `categories_tags` often runs specific to broad rather than the other way
// round — a real shampoo record ends `... en:health-beauty en:personal-care` —
// and `mapCategory()` takes the LAST match. So most rows here land on
// `personal-care`, which is a correct shelf even when a narrower one was
// available. Correct and broad beats specific and wrong.

const PRODUCT_HOST = 'https://world.openbeautyfacts.org'
const SEARCH_HOST = 'world.openbeautyfacts.org'

const CATEGORY_TAGS: Record<string, string> = {
  'en:personal-care': 'personal-care',
  'en:health-beauty': 'personal-care',
  'en:hygiene': 'personal-care',
  'en:hair': 'personal-care',
  'en:hair-care': 'personal-care',
  'en:shampoos': 'personal-care',
  'en:hair-conditioners': 'personal-care',
  'en:oral-hygiene': 'personal-care',
  'en:toothpastes': 'personal-care',
  'en:toothbrushes': 'personal-care',
  'en:deodorants': 'personal-care',
  'en:soaps': 'personal-care',
  'en:shower-gels': 'personal-care',
  'en:skincare': 'personal-care',
  'en:face-care': 'personal-care',
  'en:body-care': 'personal-care',
  'en:sunscreens': 'personal-care',
  'en:make-up': 'personal-care',
  'en:perfumes': 'personal-care',
  'en:shaving': 'personal-care',
  'en:feminine-hygiene': 'personal-care',
  'en:baby-care': 'baby',
  'en:baby-cosmetics': 'baby',
  'en:medicines': 'health',
  'en:first-aid': 'health',
}

export const OPEN_BEAUTY_FACTS: OpenFactsConfig = {
  meta: {
    name: 'openbeautyfacts',
    label: 'Open Beauty Facts',
    licence: 'ODbL 1.0',
    homepage: PRODUCT_HOST,
  },
  productHost: PRODUCT_HOST,
  buildSearchUrl: (query: string, ctx: SourceContext) =>
    legacySearchUrl(SEARCH_HOST, query, ctx),
  readSearchEnvelope: readLegacyEnvelope,
  categoryTags: CATEGORY_TAGS,
}

export class OpenBeautyFactsAdapter extends OpenFactsAdapter {
  constructor(options: AdapterOptions = {}) {
    super(OPEN_BEAUTY_FACTS, options)
  }
}
