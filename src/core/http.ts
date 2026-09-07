// The transport, and the only place in this repository that makes a request.
//
// Politeness lives here rather than in each scraper, because politeness that
// depends on every scraper author remembering it is politeness that lasts until
// the third scraper. A retailer module asks this for a URL and gets bytes; it
// cannot go faster than the limit, cannot skip the backoff, and cannot keep
// hammering a host that has stopped answering.
//
// WHAT IT WILL NOT DO. There is no proxy rotation, no user-agent shuffling, no
// cookie replay, no CAPTCHA handling and no authentication. Those are the tools
// for getting past somebody who has said no, and a shop that has said no has
// said no. When a retailer cannot be read politely it is marked unimplemented
// and the reason is recorded on its registry entry.
//
// The circuit breaker and the per-attempt AbortController are carried over from
// the previous catalog's Open Food Facts adapter, which is the one piece of that
// code worth keeping: it had learned that reusing one controller across retries
// makes every retry a no-op, because the first timeout aborts the signal the
// later attempts are still linked to.

export interface HttpOptions {
  /** Named in every request. A shop should be able to tell who this is. */
  userAgent?: string
  /** Minimum gap between two requests to the same host. */
  minIntervalMs?: number
  timeoutMs?: number
  /** Attempts after the first. Only 429 and 5xx are retried. */
  retries?: number
  /** Consecutive failures before a host is left alone. */
  tripAfter?: number
  cooldownMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface HttpResponse {
  status: number
  ok: boolean
  body: string
  /**
   * The undecoded bytes.
   *
   * Needed because a .xml.gz sitemap is a GZIP FILE, not a gzip-encoded
   * response: there is no content-encoding header, so fetch does not decompress
   * it, and reading it as text turns the bytes into replacement characters
   * before anything can sniff the magic number. Lidl's product sitemap is
   * exactly this, and reading only `body` made it parse as zero URLs -- which
   * the run correctly refused to sweep on, and which would otherwise have been a
   * scraper that silently found nothing every night.
   */
  bytes: Uint8Array
  /** Headers a caller actually reads; VTEX puts its paging total in one. */
  headers: Headers
  url: string
}

const DEFAULT_UA =
  'FamCartCatalogBot/1.0 (+https://famcart-app.vercel.app; shopping list; polite, cached, low rate)'

export class CircuitOpenError extends Error {
  constructor(host: string) {
    super(`circuit open for ${host}`)
    this.name = 'CircuitOpenError'
  }
}

interface HostState {
  failures: number
  openUntil: number
  nextAllowedAt: number
}

export class HttpClient {
  private readonly userAgent: string
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly tripAfter: number
  private readonly cooldownMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /**
   * Per HOST, not global. One slow shop must not pace the others, and one shop
   * that has stopped answering must not stop a run against a different one.
   */
  private readonly hosts = new Map<string, HostState>()
  /**
   * A promise chain per host, which is what actually serialises requests. A
   * counter and a sleep would let ten concurrent callers all read the same
   * "last request was long ago" and fire at once.
   */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(options: HttpOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_UA
    this.minIntervalMs = options.minIntervalMs ?? 1000
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.retries = options.retries ?? 2
    this.tripAfter = options.tripAfter ?? 4
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  isCircuitOpen(url: string): boolean {
    const state = this.hosts.get(hostOf(url))
    return state !== undefined && state.openUntil > this.now()
  }

  /**
   * Fetch a URL, politely.
   *
   * Returns the response even for a 4xx: "this page is gone" is an answer a
   * scraper wants (Carrefour 404s a delisted product), not an exception. Throws
   * only when the request could not be completed at all, or when the host's
   * circuit is open.
   *
   * `tolerant` is for a request the caller can do without. Its failures do not
   * count toward the breaker and it is not retried.
   *
   * THAT DISTINCTION IS NOT A NICETY. Auchan rate-limits /category/tree,
   * /brand/list and /facets on a much smaller budget than /products/search, and
   * they 429 for tens of minutes while the product endpoint answers normally.
   * With one breaker per host and no tolerant mode, four refusals from an
   * OPTIONAL endpoint open the circuit for the host and kill a crawl that was
   * working -- which is precisely the failure the Auchan scraper is built to
   * survive. Found by its own test.
   */
  async get(url: string, init: RequestInit = {}, opts: { tolerant?: boolean } = {}): Promise<HttpResponse> {
    const host = hostOf(url)
    const previous = this.queues.get(host) ?? Promise.resolve()
    const task = previous.then(
      () => this.perform(url, init, host, opts.tolerant === true),
      () => this.perform(url, init, host, opts.tolerant === true),
    )
    // The queue holds a promise that never rejects, so one failed request does
    // not poison every request queued behind it on the same host.
    this.queues.set(host, task.then(noop, noop))
    return task
  }

  private async perform(
    url: string,
    init: RequestInit,
    host: string,
    tolerant: boolean,
  ): Promise<HttpResponse> {
    const state = this.stateOf(host)
    const retries = tolerant ? 0 : this.retries

    if (state.openUntil > this.now()) {
      throw new CircuitOpenError(host)
    }

    const wait = state.nextAllowedAt - this.now()
    if (wait > 0) await this.sleep(wait)

    let lastError: unknown = null

    for (let attempt = 0; attempt <= retries; attempt++) {
      // A FRESH CONTROLLER PER ATTEMPT. Reusing one means the first attempt's
      // timeout aborts every retry before it starts, which looks exactly like a
      // host that is down and is the reason this comment exists.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      const onOuterAbort = () => controller.abort()
      init.signal?.addEventListener('abort', onOuterAbort, { once: true })

      // THE GAP IS MEASURED FROM HERE, not from when the answer arrives.
      //
      // It used to be stamped after the response, which makes the real cadence
      // `response time + minInterval` rather than `minInterval`. On a shop
      // serving 300 KB pages in about 1.9 seconds that turned a nominal one
      // request per second into one every 2.89 -- measured, not guessed -- and
      // the arithmetic built on top of it was wrong by a factor of three: a
      // Carrefour slice budgeted at 4.7 hours actually needs 13.7, so the
      // nightly job was being cut off by its own timeout every time, three
      // quarters of the way short, with nothing saying so.
      //
      // Stamping it here makes the cadence max(minInterval, response time),
      // which is what "at most one request a second" has always meant. It asks
      // no more of the shop than the old code did on its fastest page.
      state.nextAllowedAt = this.now() + this.minIntervalMs

      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { 'user-agent': this.userAgent, ...(init.headers ?? {}) },
        })
        // arrayBuffer, then decode: text() would be lossy for the gzip files.
        const bytes = new Uint8Array(await response.arrayBuffer())
        const body = new TextDecoder('utf-8').decode(bytes)

        // 429 and 5xx are the shop asking for room. Back off and try again.
        if (response.status === 429 || response.status >= 500) {
          if (tolerant) return toResponse(response, body, bytes, url)
          state.failures++
          if (state.failures >= this.tripAfter) {
            state.openUntil = this.now() + this.cooldownMs
            state.failures = 0
            throw new CircuitOpenError(host)
          }
          lastError = new Error(`HTTP ${response.status} for ${url}`)
          if (attempt < retries) {
            // Honour Retry-After when it is given; Auchan gives none, so the
            // exponential ladder is what actually paces it.
            const retryAfter = Number(response.headers.get('retry-after'))
            await this.sleep(
              Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 60_000)
                : 500 * 2 ** attempt,
            )
            continue
          }
          // Out of attempts: hand the response back rather than throwing, so the
          // caller can count it and carry on with the rest of the catalog.
          return toResponse(response, body, bytes, url)
        }

        // Anything else, including a 404, is a real answer.
        state.failures = 0
        return toResponse(response, body, bytes, url)
      } catch (error) {
        if (error instanceof CircuitOpenError) throw error
        // The caller gave up (Ctrl-C, a --limit reached). Not the host's fault,
        // so it must not count toward the breaker.
        if (init.signal?.aborted) throw error

        lastError = error
        if (tolerant) throw error
        state.failures++
        // Re-stamped from HERE on a failure, unlike the success path. A timeout
        // means the host took the whole window and said nothing, and the polite
        // response to that is a fresh gap after it -- not one measured from a
        // request that never landed.
        state.nextAllowedAt = this.now() + this.minIntervalMs
        if (state.failures >= this.tripAfter) {
          state.openUntil = this.now() + this.cooldownMs
          state.failures = 0
          throw new CircuitOpenError(host)
        }
        if (attempt < retries) await this.sleep(500 * 2 ** attempt)
      } finally {
        clearTimeout(timer)
        init.signal?.removeEventListener('abort', onOuterAbort)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`)
  }

  private stateOf(host: string): HostState {
    let state = this.hosts.get(host)
    if (!state) {
      state = { failures: 0, openUntil: 0, nextAllowedAt: 0 }
      this.hosts.set(host, state)
    }
    return state
  }
}

function toResponse(response: Response, body: string, bytes: Uint8Array, url: string): HttpResponse {
  return {
    status: response.status,
    ok: response.ok,
    body,
    bytes,
    headers: response.headers,
    url,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function noop(): void {}
