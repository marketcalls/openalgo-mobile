import { z } from 'zod'
import { type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createHttpClient } from './client'
import type { EndpointId, Lane } from './endpoints'
import { ApiError } from './errors'
import { createScheduler, type SchedulerOptions } from './scheduler'
import { envelope } from './schemas'

beforeEach(() => jest.useFakeTimers({ now: 0 }))
afterEach(() => jest.useRealTimers())

/** Moves the fake clock to `ms`, running the timers due and the promises they settle. */
const until = (ms: number) => jest.advanceTimersByTimeAsync(ms - Date.now())

type Outcome = { value?: unknown; error?: unknown }

/** A scheduler whose execs record when they start, then settle after `ms`. */
function harness(o?: SchedulerOptions) {
  const s = createScheduler(o)
  const starts: { name: string; lane: Lane; at: number }[] = []
  const outcomes = new Map<string, Outcome>()
  let historyNow = 0
  let historyMax = 0

  function queue(
    name: string,
    lane: Lane,
    o: { endpoint?: EndpointId; ms?: number; key?: string; fail?: unknown } = {},
  ) {
    const p = s.run({
      endpoint: o.endpoint ?? 'quotes',
      lane,
      dedupeKey: o.key,
      exec: () => {
        starts.push({ name, lane, at: Date.now() })
        if (lane === 'history') historyMax = Math.max(historyMax, ++historyNow)
        return new Promise<string>((resolve, reject) => {
          const settle = () => {
            if (lane === 'history') historyNow -= 1
            if (o.fail) reject(o.fail)
            else resolve(name)
          }
          if (o.ms) setTimeout(settle, o.ms)
          else settle()
        })
      },
    })
    p.then(
      (value) => outcomes.set(name, { value }),
      (error) => outcomes.set(name, { error }),
    )
    return p
  }

  const startOf = (name: string) => starts.find((x) => x.name === name)?.at
  const names = () => starts.map((x) => x.name)
  return { s, queue, starts, outcomes, startOf, names, historyMax: () => historyMax }
}

test('B1 Read bucket', async () => {
  const h = harness()
  for (let i = 1; i <= 20; i++) h.queue(`r${i}`, 'read')

  await until(0)
  expect(h.starts).toHaveLength(5)
  await until(999)
  expect(h.starts).toHaveLength(9)
  await until(1000)
  expect(h.starts).toHaveLength(10)
  await until(2999)
  expect(h.starts).toHaveLength(19)
  await until(3000)
  expect(h.starts).toHaveLength(20)
  // capacity 5, then one token every 200 ms
  expect(h.starts.map((x) => x.at)).toEqual([
    0, 0, 0, 0, 0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800,
    3000,
  ])
})

test('B2 Priority lanes', async () => {
  const h = harness()
  for (let i = 1; i <= 15; i++) h.queue(`r${i}`, 'read')
  // 5 reads took the whole bucket, so 10 wait behind them
  h.queue('order', 'order', { endpoint: 'placeorder' })
  h.queue('toggle', 'control', { endpoint: 'analyzer/toggle' })
  for (const n of [1, 2, 3]) h.queue(`smart${n}`, 'smart', { endpoint: 'placesmartorder' })

  await until(0)
  expect(h.names()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'order', 'toggle', 'smart1'])

  await until(3000)
  expect([h.startOf('smart1'), h.startOf('smart2'), h.startOf('smart3')]).toEqual([0, 500, 1000])
  // the priority lanes skipped the bucket rather than spending its tokens
  expect(h.startOf('r6')).toBe(200)
  expect(h.startOf('r15')).toBe(2000)
})

test('B3 History', async () => {
  const h = harness()
  for (let i = 1; i <= 10; i++) {
    h.queue(`h${i}`, 'history', { endpoint: 'history', ms: 2000 })
    h.queue(`r${i}`, 'read')
  }

  await until(20_000)
  expect(h.starts).toHaveLength(20)
  const at = h.starts.map((x) => x.at)
  // each history start takes a read token, so the app as a whole stays near 5 req/s
  expect(at.filter((t) => t <= 1000).length).toBeLessThanOrEqual(10)
  for (let s = 1000; s < 20_000; s += 1000) {
    expect(at.filter((t) => t > s && t <= s + 1000).length).toBeLessThanOrEqual(5)
  }
  const history = h.starts.filter((x) => x.lane === 'history').map((x) => x.at)
  const gaps = history.slice(1).map((t, i) => t - (history[i] ?? 0))
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(334)
  expect(h.historyMax()).toBe(3)
})

test('B5 429 gate', async () => {
  const OK: ScriptedReply = { status: 200, body: { status: 'success', data: {} } }
  // app.py:691-696: the server always says 60 s; the gate ignores it
  const LIMITED: ScriptedReply = {
    status: 429,
    body: {
      status: 'error',
      message: 'Rate limit exceeded. Please slow down your requests.',
      retry_after: 60,
    },
  }
  const replies = [...Array<ScriptedReply>(6).fill(LIMITED), OK, LIMITED, OK]
  const quoteStarts: number[] = []
  const depthStarts: number[] = []
  const fetch = scriptedFetch({
    'POST /api/v1/quotes': () => {
      quoteStarts.push(Date.now())
      return replies.shift() ?? OK
    },
    'POST /api/v1/depth': () => {
      depthStarts.push(Date.now())
      return OK
    },
  })
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => 'ab'.repeat(32),
    fetch,
    resolveAuth403: async () => 'key_invalid',
  })
  const s = createScheduler()
  const call = (id: EndpointId) =>
    s.run({ endpoint: id, lane: 'read', exec: () => http.request(id, {}, envelope(z.unknown())) })

  // each request is queued as soon as the one before it settles
  const results: string[] = []
  const chain = (async () => {
    for (let i = 0; i < 9; i++) {
      results.push(
        await call('quotes').then(
          () => 'ok',
          (e: ApiError) => e.kind,
        ),
      )
    }
  })()

  await until(1000)
  expect(quoteStarts).toEqual([0])
  expect(results).toEqual(['RateLimited'])
  expect(s.stats().gated).toEqual(['quotes'])
  // the gate holds only its own endpoint
  await call('depth')
  expect(depthStarts).toEqual([1000])

  await until(100_000)
  await chain
  // gates of 2, 4, 8, 16, 30 and 30 s; the success at 90 s resets it to 2 s
  expect(quoteStarts).toEqual([0, 2000, 6000, 14_000, 30_000, 60_000, 90_000, 90_000, 92_000])
  expect(results).toEqual([...Array<string>(6).fill('RateLimited'), 'ok', 'RateLimited', 'ok'])
  expect(s.stats().gated).toEqual([])
})

test('429s from requests already in flight when the gate closes count as one strike', async () => {
  const limited = new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'depth' })
  const h = harness()
  for (const n of [1, 2, 3]) h.queue(`d${n}`, 'read', { endpoint: 'depth', ms: 100, fail: limited })

  await until(100)
  h.queue('d4', 'read', { endpoint: 'depth' })
  await until(2100)
  // three 429s from one burst gate for 2 s, not 8 s
  expect(h.startOf('d4')).toBe(2100)
  expect(h.outcomes.get('d1')?.error).toBe(limited)
})

test('B7 Pause', async () => {
  const h = harness()
  h.s.pause()
  h.queue('read', 'read')
  h.queue('history', 'history', { endpoint: 'history' })
  h.queue('order', 'order', { endpoint: 'placeorder' })
  h.queue('smart', 'smart', { endpoint: 'placesmartorder' })
  h.queue('toggle', 'control', { endpoint: 'analyzer/toggle' })

  await until(10_000)
  expect(h.names()).toEqual(['order', 'smart', 'toggle'])
  expect(h.s.stats()).toMatchObject({ paused: true, queued: { read: 1, history: 1 } })

  h.s.resume()
  await until(10_000)
  expect(h.names()).toEqual(['order', 'smart', 'toggle', 'read', 'history'])
})

test('B8 Halt', async () => {
  const h = harness()
  for (let i = 1; i <= 8; i++) h.queue(`r${i}`, 'read', { ms: 1000 })
  h.s.pause()
  h.queue('order', 'order', { endpoint: 'placeorder', ms: 1000 })
  h.queue('history', 'history', { endpoint: 'history' })
  await until(0)

  const banned = new ApiError({ kind: 'IpBanned', status: 403, endpoint: 'funds', banForm: 'text' })
  h.s.halt(banned)
  h.queue('new', 'order', { endpoint: 'placeorder' })
  h.s.resume()
  await until(10_000)

  // queued and new requests reject; those already sent finish normally
  for (const name of ['r6', 'r7', 'r8', 'history', 'new']) {
    expect(h.outcomes.get(name)).toEqual({ error: banned })
  }
  for (const name of ['r1', 'r5', 'order']) expect(h.outcomes.get(name)).toEqual({ value: name })
  expect(h.names()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'order'])
  expect(h.s.stats()).toMatchObject({ halted: true, inFlight: 0 })

  h.s.unhalt()
  await h.queue('after', 'read')
  expect(h.names()).toContain('after')
  expect(h.s.stats().halted).toBe(false)
})
