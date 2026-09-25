// The run's log, shipped to the catalog as it is written.
//
// What must hold: nothing written before the run opened is lost, the info
// flood is capped but warnings never are, and no failure to ship a line can
// ever surface as an exception inside a crawl.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { RunLogShipper } from '../src/importer/runLog.ts'
import { createLogger, type LogLine } from '../src/core/logger.ts'

type Call = { name: string; args: { p_run_id: string; p_lines: LogLine[] } }

function fakeDb(fail = 0) {
  const calls: Call[] = []
  let failures = fail
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args: args as Call['args'] })
      if (failures > 0) {
        failures--
        return { data: null, error: { message: 'fetch failed' } }
      }
      return { data: (args.p_lines as unknown[]).length, error: null }
    },
  }
}

const line = (message: string, level: LogLine['level'] = 'info'): LogLine => ({
  t: '2026-09-25T01:20:00.000Z',
  level,
  scope: 'lidl',
  message,
})

afterEach(() => vi.restoreAllMocks())

describe('RunLogShipper', () => {
  it('holds what was written before the run opened, and sends it once attached', async () => {
    const db = fakeDb()
    const shipper = new RunLogShipper(db)
    shipper.push(line('known groceries loaded'))
    expect(db.calls).toHaveLength(0)
    shipper.attach('run-1')
    await shipper.close()
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].name).toBe('catalog_run_log')
    expect(db.calls[0].args.p_run_id).toBe('run-1')
    expect(db.calls[0].args.p_lines.map((l) => l.message)).toEqual(['known groceries loaded'])
  })

  it('sends in batches of a hundred', async () => {
    const db = fakeDb()
    const shipper = new RunLogShipper(db)
    shipper.attach('run-1')
    for (let i = 0; i < 250; i++) shipper.push(line(`line ${i}`))
    await shipper.close()
    const sizes = db.calls.map((c) => c.args.p_lines.length)
    expect(sizes.every((n) => n <= 100)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250)
  })

  it('caps info lines, keeps every warning, and says what it dropped', async () => {
    const db = fakeDb()
    const shipper = new RunLogShipper(db, { maxInfo: 2 })
    shipper.attach('run-1')
    shipper.push(line('a'))
    shipper.push(line('b'))
    shipper.push(line('c'))
    shipper.push(line('careful', 'warn'))
    await shipper.close()
    const sent = db.calls.flatMap((c) => c.args.p_lines)
    expect(sent.map((l) => l.message)).toEqual([
      'a',
      'b',
      'careful',
      '1 info lines were not kept: a run keeps at most 2',
    ])
    expect(sent.at(-1)?.level).toBe('warn')
  })

  it('retries a failed batch once, then drops it without throwing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const db = fakeDb(2)
    const shipper = new RunLogShipper(db)
    shipper.attach('run-1')
    shipper.push(line('lost'))
    await expect(shipper.close()).resolves.toBeUndefined()
    expect(db.calls).toHaveLength(2)
    expect(stderr).toHaveBeenCalledTimes(1)
  })

  it('never throws even when the client itself throws', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const shipper = new RunLogShipper({
      rpc: async () => {
        throw new TypeError('fetch failed')
      },
    })
    shipper.attach('run-1')
    shipper.push(line('x'))
    await expect(shipper.close()).resolves.toBeUndefined()
  })

  it('sends nothing for a run that never opened', async () => {
    const db = fakeDb()
    const shipper = new RunLogShipper(db)
    shipper.push(line('run could not open'))
    await shipper.close()
    expect(db.calls).toHaveLength(0)
  })

  it('sends on its own every interval', async () => {
    vi.useFakeTimers()
    try {
      const db = fakeDb()
      const shipper = new RunLogShipper(db, { intervalMs: 2_000 })
      shipper.attach('run-1')
      await vi.advanceTimersByTimeAsync(0)
      shipper.push(line('tick'))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(db.calls.flatMap((c) => c.args.p_lines).map((l) => l.message)).toEqual(['tick'])
      await shipper.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createLogger sink', () => {
  it('hands every line to the sink, info included when quiet', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const got: LogLine[] = []
    const log = createLogger('lidl', true, (l) => got.push(l))
    log.info('hello', { n: 1 })
    log.error('boom')
    expect(got.map((l) => [l.level, l.scope, l.message])).toEqual([
      ['info', 'lidl', 'hello'],
      ['error', 'lidl', 'boom'],
    ])
    expect(got[0].fields).toEqual({ n: 1 })
  })
})
