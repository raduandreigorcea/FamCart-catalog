// The listings a retailer showed since a moment: the known groceries a
// removals-only run trusts (see the Carrefour scraper and `--removals-only`).
//
// Read straight from PostgREST with the service key rather than through an RPC:
// it is a plain filtered select, the CLI already holds the key, and a function
// would be a migration for one question asked once.
//
// THE REFUSAL IS THE POINT OF THIS FILE. The removals-only run deletes every
// product a non-grocery department shows that is not in this set. A set that is
// empty or small -- a watermark in the future, a grocery pass that never ran, a
// typo in the date -- would make every product look like a t-shirt, and the run
// would remove the grocery catalog. So a set below MIN_GROCERY_IDS is refused
// before anything is read.

/**
 * Fewer known groceries than this is not a grocery pass. Carrefour's read
 * 21,203 on 2026-09-16; this is half of that with room, and far above anything
 * a mistake produces.
 */
export const MIN_GROCERY_IDS = 10_000

const PAGE = 1000

export interface ServiceEnv {
  url: string
  key: string
}

export async function loadSeenSince(
  env: ServiceEnv,
  retailer: string,
  since: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const headers = { apikey: env.key, authorization: `Bearer ${env.key}` }

  const lookup = await fetchImpl(
    `${env.url}/rest/v1/catalog_retailers?select=id&slug=eq.${encodeURIComponent(retailer)}`,
    { headers },
  )
  if (!lookup.ok) throw new Error(`could not look up ${retailer}: HTTP ${lookup.status}`)
  const found = (await lookup.json()) as Array<{ id: string }>
  if (!found.length) throw new Error(`unknown retailer: ${retailer}`)
  const retailerId = found[0].id

  const ids = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const url =
      `${env.url}/rest/v1/catalog_listings?select=external_id` +
      `&retailer_id=eq.${retailerId}` +
      `&last_seen_at=gte.${encodeURIComponent(since.toISOString())}` +
      `&order=external_id.asc`
    const response = await fetchImpl(url, { headers: { ...headers, range: `${from}-${from + PAGE - 1}` } })
    if (!response.ok) throw new Error(`could not read ${retailer}'s listings: HTTP ${response.status}`)
    const rows = (await response.json()) as Array<{ external_id: string }>
    for (const row of rows) ids.add(row.external_id)
    if (rows.length < PAGE) break
  }

  if (ids.size < MIN_GROCERY_IDS) {
    throw new Error(
      `refusing a removals-only run: only ${ids.size} ${retailer} listings were seen since ` +
        `${since.toISOString()}, and a grocery pass sees at least ${MIN_GROCERY_IDS}. ` +
        'A set this small would remove the groceries themselves.',
    )
  }
  return ids
}
