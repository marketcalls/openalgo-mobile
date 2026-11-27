import { profileStorage } from '~/core/config/storage'
import { createApi, type FieldGate } from '~/core/http/api'
import type { HttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { createScheduler } from '~/core/http/scheduler'
import type { HistoryRow } from '~/market/chart/schemas'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { fetchHistoryBatch, type HistoryRequest, lastCompletedDay } from './batch'
import { createHistoryDayCache } from './dayCache'

// 10:30 IST on 2026-11-24
const T0 = Date.UTC(2026, 10, 24, 5, 0)
const IST_OFFSET_MS = 330 * 60_000

/** A daily candle of the IST date `iso`, stamped at its IST midnight in epoch seconds. */
const candle = (iso: string, close = 100): HistoryRow => ({
  timestamp: (Date.parse(`${iso}T00:00:00Z`) - IST_OFFSET_MS) / 1000,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1000,
  oi: 5000,
})

const request = (symbol: string): HistoryRequest => ({
  symbol,
  exchange: 'NFO',
  interval: 'D',
  start_date: '2026-10-01',
  end_date: '2026-11-24',
})

const PASS_THROUGH: FieldGate = { adapt: (_id, body) => body, markUnsupported: () => {} }

describe('fetchHistoryBatch', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 })
    keepExpectedLogs()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  /** The real api and scheduler over an http fake whose history replies take 1 s each. */
  function setup() {
    let inFlight = 0
    let most = 0
    const sent: Record<string, unknown>[] = []
    const http: Pick<HttpClient, 'request'> = {
      request: (id, body, schema, o) =>
        new Promise((resolve, reject) => {
          expect(id).toBe('history')
          sent.push(body)
          most = Math.max(most, ++inFlight)
          const timer = setTimeout(() => {
            inFlight--
            if (body.symbol === 'BAD') {
              reject(
                new ApiError({
                  kind: 'Validation',
                  status: 400,
                  endpoint: 'history',
                  serverMessage: 'Invalid symbol',
                }),
              )
            } else {
              const data = [candle('2026-11-23', 101), { timestamp: 'x' }, candle('2026-11-24')]
              resolve(schema.parse({ status: 'success', data }))
            }
          }, 1000)
          o?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            inFlight--
            reject(new ApiError({ kind: 'Network', status: 0, endpoint: 'history' }))
          })
        }),
    }
    const api = createApi({ http, scheduler: createScheduler(), fields: PASS_THROUGH })
    return { api, sent, most: () => most }
  }

  test('a history batch reports progress and keeps at most 3 in flight with the real scheduler', async () => {
    const { api, sent, most } = setup()
    const dropped = expectLog('warn', /\[history\] NFO:[A-G] dropped 1 rows/)
    const reqs = ['A', 'B', 'BAD', 'C', 'D', 'E', 'F', 'G'].map(request)
    const progress: [number, number][] = []
    const batch = fetchHistoryBatch(api, reqs, { onProgress: (d, t) => progress.push([d, t]) })
    await jest.advanceTimersByTimeAsync(30_000)
    const out = await batch

    expect(most()).toBe(3)
    expect(sent).toEqual(reqs)
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((d) => [d, 8]))
    // one slot per request, in request order: the candles that parse, or the request's error
    expect(out).toHaveLength(8)
    expect(out[0]).toEqual([candle('2026-11-23', 101), candle('2026-11-24')])
    const bad = out[2]
    expect(bad).toBeInstanceOf(ApiError)
    expect(bad).toMatchObject({ kind: 'Validation', serverMessage: 'Invalid symbol' })
    // the candle without a time is dropped, and said so
    expect(dropped).toHaveLength(7)
  })

  test('an abort ends the batch at once: every request still out or queued is a Network error', async () => {
    const { api, sent } = setup()
    expectLog('warn', /\[history\] NFO:A dropped 1 rows/)
    const ctrl = new AbortController()
    const progress: number[] = []
    const batch = fetchHistoryBatch(api, ['A', 'B', 'C', 'D', 'E'].map(request), {
      signal: ctrl.signal,
      onProgress: (d) => progress.push(d),
    })
    // A is back; B, C and D are out (the lane holds 3) and E is queued
    await jest.advanceTimersByTimeAsync(1100)
    ctrl.abort()
    const out = await batch
    expect(Array.isArray(out[0])).toBe(true)
    expect(out.slice(1).map((r) => (r instanceof ApiError ? r.kind : 'rows'))).toEqual([
      'Network',
      'Network',
      'Network',
      'Network',
    ])
    expect(progress).toEqual([1, 2, 3, 4, 5])
    // nothing more went out after the abort
    const before = sent.length
    await jest.advanceTimersByTimeAsync(10_000)
    expect(sent).toHaveLength(before)
  })

  /** A gate the test opens and shuts; a shut one waits for the next opening or the abort. */
  function gateOf() {
    let shut = false
    let opened: (() => void)[] = []
    const gate = (signal: AbortSignal) =>
      shut
        ? new Promise<void>((resolve, reject) => {
            opened.push(resolve)
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        : Promise.resolve()
    return {
      gate,
      shut: () => {
        shut = true
      },
      open: () => {
        shut = false
        for (const o of opened) o()
        opened = []
      },
    }
  }

  test('a gate is awaited before each read: none starts while it is shut, and none is sent twice', async () => {
    const { api, sent, most } = setup()
    expectLog('warn', /\[history\] NFO:[A-H] dropped 1 rows/)
    const g = gateOf()
    const reqs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(request)
    const settled: [number, string][] = []
    const batch = fetchHistoryBatch(api, reqs, {
      gate: g.gate,
      onSettle: (i, r) => settled.push([i, r instanceof ApiError ? r.kind : `${r.length} rows`]),
    })
    // A, B and C are out; shut, they come back, and nothing more goes
    await jest.advanceTimersByTimeAsync(100)
    g.shut()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(sent.map((b) => b.symbol)).toEqual(['A', 'B', 'C'])
    expect(settled).toEqual([0, 1, 2].map((i) => [i, '2 rows']))
    // open again: the rest go, each once, still at most 3 in flight
    g.open()
    await jest.advanceTimersByTimeAsync(30_000)
    const out = await batch
    expect(sent).toEqual(reqs)
    expect(most()).toBe(3)
    expect(out.every(Array.isArray)).toBe(true)
    expect(settled.map(([i]) => i).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('an abort while the gate is shut ends the batch at once and sends nothing more', async () => {
    const { api, sent } = setup()
    expectLog('warn', /\[history\] NFO:[A-C] dropped 1 rows/)
    const g = gateOf()
    const ctrl = new AbortController()
    const progress: number[] = []
    const batch = fetchHistoryBatch(api, ['A', 'B', 'C', 'D', 'E'].map(request), {
      signal: ctrl.signal,
      gate: g.gate,
      onProgress: (d) => progress.push(d),
    })
    await jest.advanceTimersByTimeAsync(100)
    g.shut()
    await jest.advanceTimersByTimeAsync(5_000)
    ctrl.abort()
    const out = await batch
    expect(out.map((r) => (r instanceof ApiError ? r.kind : 'rows'))).toEqual([
      'rows',
      'rows',
      'rows',
      'Network',
      'Network',
    ])
    expect(progress).toEqual([1, 2, 3, 4, 5])
    await jest.advanceTimersByTimeAsync(10_000)
    expect(sent.map((b) => b.symbol)).toEqual(['A', 'B', 'C'])
  })

  test('an empty batch sends nothing', async () => {
    const { api, sent } = setup()
    const onProgress = jest.fn()
    expect(await fetchHistoryBatch(api, [], { onProgress })).toEqual([])
    expect(sent).toEqual([])
    expect(onProgress).not.toHaveBeenCalled()
  })
})

describe('the history day cache', () => {
  const KEY = 'NFO:NIFTY30DEC2624000CE D'

  test('the day cache is keyed by the last completed day, not today', async () => {
    // daily candles to today (2026-11-24), whose candle is still forming
    const rows = [candle('2026-11-20'), candle('2026-11-23'), candle('2026-11-24')]
    expect(lastCompletedDay(rows)).toBe('2026-11-23')
    expect(lastCompletedDay(rows.slice(0, 1))).toBeNull()
    expect(lastCompletedDay([])).toBeNull()

    const kv = memoryKV()
    const storage = profileStorage(kv, 'p1')
    const cache = createHistoryDayCache(storage)
    const done = rows.slice(0, 2)
    await cache.put(KEY, '2026-11-23', done)
    expect(await cache.get(KEY, '2026-11-23')).toEqual(done)
    // asked by today's date, or another key: a miss
    expect(await cache.get(KEY, '2026-11-24')).toBeNull()
    expect(await cache.get('NFO:NIFTY30DEC2624000PE D', '2026-11-23')).toBeNull()
    // it outlives the app session
    expect(await createHistoryDayCache(storage).get(KEY, '2026-11-23')).toEqual(done)
    // the next day's last completed candle is 2026-11-24: the entry is replaced, not added to
    await cache.put(KEY, '2026-11-24', rows)
    expect(await cache.get(KEY, '2026-11-23')).toBeNull()
    expect(await cache.get(KEY, '2026-11-24')).toEqual(rows)
    expect([...kv.data.keys()].filter((k) => k.startsWith('oa.p1.historyDays'))).toHaveLength(2)
  })

  test('at most 200 entries, oldest dropped; a refreshed entry counts as new', async () => {
    const kv = memoryKV()
    const cache = createHistoryDayCache(profileStorage(kv, 'p1'))
    const rows = [candle('2026-11-23')]
    for (let i = 0; i < 200; i++) await cache.put(`k${i}`, '2026-11-23', rows)
    await cache.put('k0', '2026-11-23', rows)
    await cache.put('k200', '2026-11-23', rows)
    expect(await cache.get('k0', '2026-11-23')).toEqual(rows)
    expect(await cache.get('k1', '2026-11-23')).toBeNull()
    expect(await cache.get('k2', '2026-11-23')).toEqual(rows)
    expect(await cache.get('k200', '2026-11-23')).toEqual(rows)
    const entries = [...kv.data.keys()].filter((k) => k.startsWith('oa.p1.historyDays:'))
    expect(entries).toHaveLength(200)
  })

  test('at most 1,500,000 UTF-8 bytes, oldest dropped; an entry over it alone is not kept', async () => {
    const kv = memoryKV()
    const cache = createHistoryDayCache(profileStorage(kv, 'p1'))
    // about 600 KB of candles each
    const big = Array.from({ length: 6000 }, () => candle('2026-11-23', 24012.35))
    await cache.put('a', '2026-11-23', big)
    await cache.put('b', '2026-11-23', big)
    await cache.put('c', '2026-11-23', big)
    expect(await cache.get('a', '2026-11-23')).toBeNull()
    expect(await cache.get('b', '2026-11-23')).toHaveLength(6000)
    expect(await cache.get('c', '2026-11-23')).toHaveLength(6000)
    const bytes = [...kv.data.entries()]
      .filter(([k]) => k.startsWith('oa.p1.historyDays'))
      .reduce((n, [, v]) => n + v.length, 0)
    expect(bytes).toBeLessThanOrEqual(1_500_000)

    const huge = Array.from({ length: 16_000 }, () => candle('2026-11-23', 24012.35))
    await cache.put('d', '2026-11-23', huge)
    expect(await cache.get('d', '2026-11-23')).toBeNull()
    expect(await cache.get('c', '2026-11-23')).toHaveLength(6000)
  })

  test('puts at the same time all land; an entry the index does not list is dropped', async () => {
    const kv = memoryKV()
    const storage = profileStorage(kv, 'p1')
    // left behind by an app killed between writing an entry and its index
    await storage.setJSON('historyDays:stray', { day: '2026-11-23', rows: [] })
    const cache = createHistoryDayCache(storage)
    const rows = [candle('2026-11-23')]
    await Promise.all(['x', 'y', 'z'].map((k) => cache.put(k, '2026-11-23', rows)))
    for (const k of ['x', 'y', 'z']) expect(await cache.get(k, '2026-11-23')).toEqual(rows)
    expect(kv.data.has('oa.p1.historyDays:stray')).toBe(false)
  })
})
