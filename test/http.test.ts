// The transport: pacing, retries, the circuit breaker, and the abort handling.
//
// All of it driven by an injected fetch and an injected clock, so the suite
// proves the behaviour in milliseconds rather than by waiting for it.

import { describe, it, expect } from 'vitest'
import { HttpClient, CircuitOpenError } from '../src/core/http.ts'

/** A fetch that answers from a script, recording what it was asked. */
function scriptedFetch(script: Array<number | Error>): {
  impl: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  let index = 0
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    const next = script[Math.min(index++, script.length - 1)]
    if (next instanceof Error) throw next
    return new Response('body', { status: next })
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

/** A clock and a sleep that advance together without any real waiting. */
function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
    advance: (ms: number) => {
      time += ms
    },
  }
}

describe('HttpClient', () => {
  it('returns a 404 rather than throwing, because delisted is an answer', async () => {
    const { impl } = scriptedFetch([404])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, ...clock })
    const response = await client.get('https://example.test/gone')
    expect(response.status).toBe(404)
    expect(response.ok).toBe(false)
  })

  it('retries a 429 and succeeds', async () => {
    const { impl, calls } = scriptedFetch([429, 429, 200])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 2, ...clock })
    const response = await client.get('https://example.test/a')
    expect(response.status).toBe(200)
    expect(calls.length).toBe(3)
  })

  it('does not retry a 404: a missing page will still be missing', async () => {
    const { impl, calls } = scriptedFetch([404])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 3, ...clock })
    await client.get('https://example.test/a')
    expect(calls.length).toBe(1)
  })

  it('backs off longer each attempt', async () => {
    const { impl } = scriptedFetch([500, 500, 200])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 2, ...clock })
    await client.get('https://example.test/a')
    // 500 then 1000: the ladder, not a fixed pause.
    expect(clock.now()).toBe(1500)
  })

  it('keeps a minimum gap between requests to one host', async () => {
    const { impl } = scriptedFetch([200])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 1000, ...clock })
    await client.get('https://example.test/a')
    await client.get('https://example.test/b')
    await client.get('https://example.test/c')
    expect(clock.now()).toBeGreaterThanOrEqual(2000)
  })

  it('paces hosts independently, so one slow shop does not gate another', async () => {
    const { impl } = scriptedFetch([200])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 1000, ...clock })
    await client.get('https://one.test/a')
    await client.get('https://two.test/a')
    expect(clock.now()).toBe(0)
  })

  it('trips the breaker after repeated failures and then refuses fast', async () => {
    const { impl, calls } = scriptedFetch([500])
    const clock = fakeClock()
    const client = new HttpClient({
      fetchImpl: impl, minIntervalMs: 0, retries: 0, tripAfter: 3, cooldownMs: 60_000, ...clock,
    })
    await client.get('https://example.test/1')
    await client.get('https://example.test/2')
    await expect(client.get('https://example.test/3')).rejects.toBeInstanceOf(CircuitOpenError)

    const before = calls.length
    await expect(client.get('https://example.test/4')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls.length).toBe(before)
    expect(client.isCircuitOpen('https://example.test/x')).toBe(true)
  })

  it('closes the breaker again after the cooldown', async () => {
    const { impl } = scriptedFetch([500, 500, 500, 200])
    const clock = fakeClock()
    const client = new HttpClient({
      fetchImpl: impl, minIntervalMs: 0, retries: 0, tripAfter: 3, cooldownMs: 60_000, ...clock,
    })
    await client.get('https://example.test/1')
    await client.get('https://example.test/2')
    await expect(client.get('https://example.test/3')).rejects.toBeInstanceOf(CircuitOpenError)
    clock.advance(61_000)
    const response = await client.get('https://example.test/4')
    expect(response.status).toBe(200)
  })

  it('lets a TOLERANT request fail without condemning the host', async () => {
    // THE AUCHAN CASE. Its /category/tree 429s for tens of minutes on a budget
    // the product endpoint does not share. Without this, four refusals from an
    // endpoint the crawl does not need would open the circuit and kill a crawl
    // that was working.
    const { impl } = scriptedFetch([429])
    const clock = fakeClock()
    const client = new HttpClient({
      fetchImpl: impl, minIntervalMs: 0, retries: 0, tripAfter: 2, ...clock,
    })
    for (let i = 0; i < 6; i++) {
      const response = await client.get('https://example.test/tree', {}, { tolerant: true })
      expect(response.status).toBe(429)
    }
    expect(client.isCircuitOpen('https://example.test/anything')).toBe(false)
  })

  it('does not retry a tolerant request', async () => {
    const { impl, calls } = scriptedFetch([500])
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 5, ...clock })
    await client.get('https://example.test/opt', {}, { tolerant: true })
    expect(calls.length).toBe(1)
  })

  it('sends a user agent that says who it is', async () => {
    let seen: HeadersInit | undefined
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const clock = fakeClock()
    await new HttpClient({ fetchImpl: impl, minIntervalMs: 0, ...clock }).get('https://example.test/a')
    const agent = (seen as Record<string, string>)['user-agent']
    expect(agent).toContain('FamCart')
    expect(agent).toContain('https://')
  })

  it('gives up when the caller aborts, without blaming the host', async () => {
    const controller = new AbortController()
    const impl = (async () => {
      controller.abort()
      throw new Error('aborted')
    }) as unknown as typeof fetch
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 2, tripAfter: 1, ...clock })
    await expect(client.get('https://example.test/a', { signal: controller.signal })).rejects.toThrow()
    // A user pressing Ctrl-C is not evidence that the shop is down.
    expect(client.isCircuitOpen('https://example.test/a')).toBe(false)
  })

  it('honours Retry-After when the server sends one', async () => {
    let call = 0
    const impl = (async () => {
      call++
      return call === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '5' } })
        : new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const clock = fakeClock()
    const client = new HttpClient({ fetchImpl: impl, minIntervalMs: 0, retries: 1, ...clock })
    await client.get('https://example.test/a')
    expect(clock.now()).toBe(5000)
  })
})
