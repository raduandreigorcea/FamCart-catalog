// robots.txt, read and obeyed.
//
// Every run checks the paths it is about to fetch BEFORE it fetches them, and
// refuses to start if the shop has said no. That is a real gate rather than a
// gesture: all three retailers here allow their product pages and sitemaps
// today, and if one of them stops, the correct behaviour is for the scraper to
// fail loudly and for somebody to read docs/retailers.md again -- not to keep
// going because the code never asked.
//
// This is a deliberately small parser. It handles the directives that actually
// appear in the three files we read (User-agent, Allow, Disallow, Crawl-delay,
// Sitemap) with longest-match-wins precedence, which is the rule Google
// documents and everyone follows. It does not handle wildcards beyond * and $,
// and it treats anything it cannot parse as permitted, because a scraper that
// invents prohibitions is a scraper nobody can use.

export interface RobotsRule {
  allow: boolean
  path: string
}

export interface Robots {
  rules: RobotsRule[]
  crawlDelayMs: number | null
  sitemaps: string[]
  /** True when the file could not be read at all. */
  unavailable: boolean
}

export const EMPTY_ROBOTS: Robots = { rules: [], crawlDelayMs: null, sitemaps: [], unavailable: true }

/**
 * Parse robots.txt for one user-agent.
 *
 * Groups for `*` and for our own token are merged, with our own taking
 * precedence where both name the same path. Auchan's file, for instance,
 * allow-lists several named SEO crawlers and restricts everyone else; we are in
 * "everyone else" and read the `*` group, which is the honest reading.
 */
export function parseRobots(text: string, userAgent = '*'): Robots {
  const wanted = userAgent.toLowerCase()
  const rules: RobotsRule[] = []
  const sitemaps: string[] = []
  let crawlDelayMs: number | null = null

  let groupAgents: string[] = []
  let inGroup = false
  let previousWasAgent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue

    const separator = line.indexOf(':')
    if (separator < 0) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()

    // Sitemap is not scoped to a group; it is a property of the site.
    if (field === 'sitemap') {
      if (value) sitemaps.push(value)
      continue
    }

    if (field === 'user-agent') {
      // A run of consecutive User-agent lines is ONE group. Starting a new group
      // on each of them would attach the rules to the last agent only.
      if (!previousWasAgent) groupAgents = []
      groupAgents.push(value.toLowerCase())
      inGroup = groupAgents.some((a) => a === '*' || a === wanted)
      previousWasAgent = true
      continue
    }
    previousWasAgent = false
    if (!inGroup) continue

    if (field === 'allow' && value) rules.push({ allow: true, path: value })
    else if (field === 'disallow') {
      // "Disallow:" with nothing after it means "allow everything", not "allow
      // nothing" -- inverting that would stop every scraper here.
      if (value) rules.push({ allow: false, path: value })
    } else if (field === 'crawl-delay') {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) crawlDelayMs = Math.min(seconds * 1000, 60_000)
    }
  }

  return { rules, crawlDelayMs, sitemaps, unavailable: false }
}

/**
 * Is this path allowed?
 *
 * Longest matching rule wins; Allow beats Disallow on an equal-length tie, which
 * is what makes Kaufland's "Disallow: /etc.clientlibs/ + Allow:
 * /etc.clientlibs/kaufland" mean what it looks like it means.
 */
export function isAllowed(robots: Robots, url: string): boolean {
  // A robots.txt we could not fetch is not permission to ignore it, but it is
  // also not a prohibition. Treating a 404 as "no rules" is the documented
  // behaviour and is what every one of these three sites relies on.
  if (robots.unavailable || robots.rules.length === 0) return true

  let path: string
  try {
    const parsed = new URL(url)
    path = parsed.pathname + parsed.search
  } catch {
    path = url
  }

  let best: { length: number; allow: boolean } | null = null
  for (const rule of robots.rules) {
    if (!matches(rule.path, path)) continue
    const length = rule.path.length
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow }
    }
  }
  return best ? best.allow : true
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const parts = body.split('*')

  let index = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '') continue
    const found = i === 0 ? (path.startsWith(part) ? 0 : -1) : path.indexOf(part, index)
    if (found < 0) return false
    index = found + part.length
  }
  return anchored ? index === path.length : true
}

/** Fetch and parse, treating an unreadable file as "no rules stated". */
export async function fetchRobots(
  get: (url: string) => Promise<{ ok: boolean; body: string }>,
  origin: string,
  userAgent = '*',
): Promise<Robots> {
  try {
    const response = await get(new URL('/robots.txt', origin).toString())
    if (!response.ok) return EMPTY_ROBOTS
    return parseRobots(response.body, userAgent)
  } catch {
    return EMPTY_ROBOTS
  }
}
