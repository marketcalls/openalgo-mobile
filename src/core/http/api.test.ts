import { z } from 'zod'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createApi, type FieldGate } from './api'
import { createHttpClient } from './client'
import { ENDPOINTS, type EndpointId } from './endpoints'
import type { ApiErrorKind } from './errors'
import { createScheduler } from './scheduler'
import { envelope } from './schemas'

const KEY = 'ab'.repeat(32)
const ANY = envelope(z.unknown())
const OK: ScriptedReply = { status: 200, body: { status: 'success', data: { ok: true } } }

beforeEach(() => {
  jest.useFakeTimers({ now: 0 })
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

/** The capability store's FieldGate, in memory: `adapt` drops the fields marked unsupported. */
function memoryGate() {
  const off = new Set<string>()
  return {
    adapt: jest.fn((id: EndpointId, body: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(body).filter(([k]) => !off.has(`${id}.${k}`))),
    ),
    markUnsupported: jest.fn((id: EndpointId, field: string) => {
      off.add(`${id}.${field}`)
    }),
  } satisfies FieldGate
}

function setup(routes: Record<string, Route>) {
  const fetch = scriptedFetch(routes)
  /** The signal each fetch got, in call order. */
  const signals: (AbortSignal | null | undefined)[] = []
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => KEY,
    fetch: (input, init) => {
      signals.push(init?.signal)
      return fetch(input, init)
    },
    resolveAuth403: async () => 'key_invalid',
  })
  const scheduler = createScheduler()
  const run = jest.spyOn(scheduler, 'run')
  const fields = memoryGate()
  const api = createApi({ http, scheduler, fields })
  /** The bodies sent to `id`, without the key the client adds. */
  const sent = (id: EndpointId) =>
    fetch.calls
      .filter((c) => c.url.endsWith(`/api/v1/${id}`))
      .map(({ body }) => {
        const { apikey: _, ...rest } = body as Record<string, unknown>
        return rest
      })
  return { api, fetch, fields, run, sent, signals, scheduler }
}

/** Records how `p` settles, so a test can look without awaiting it. */
function track<T>(p: Promise<T>) {
  const out: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  p.then(
    (value) => Object.assign(out, { settled: true, value }),
    (error) => Object.assign(out, { settled: true, error }),
  )
  return out
}

/** Awaits `assertion` while the fake clock runs 1 s: history starts are 334 ms apart. */
async function within1s(assertion: Promise<void>) {
  await jest.advanceTimersByTimeAsync(1000)
  await assertion
}

const later =
  (ms: number, reply: ScriptedReply): Route =>
  () =>
    new Promise((resolve) => setTimeout(() => resolve(reply), ms))

test('B4 Dedupe', async () => {
  const { api, run, sent } = setup({
    'POST /api/v1/quotes': later(100, OK),
    'POST /api/v1/multiquotes': later(100, OK),
    'POST /api/v1/placeorder': later(100, OK),
  })
  const order = { symbol: 'SBIN', exchange: 'NSE', action: 'BUY', quantity: 1 }
  const calls = [
    api.call('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, ANY),
    api.call('quotes', { exchange: 'NSE', symbol: 'RELIANCE' }, ANY),
    api.call('quotes', { symbol: 'TCS', exchange: 'NSE' }, ANY),
    api.call('multiquotes', { symbols: [{ symbol: 'A', exchange: 'NSE' }] }, ANY),
    api.call('multiquotes', { symbols: [{ exchange: 'NSE', symbol: 'A' }] }, ANY),
    api.call('placeorder', order, ANY),
    api.call('placeorder', order, ANY),
  ]
  await jest.advanceTimersByTimeAsync(100)
  await Promise.all(calls)

  // the same endpoint and arguments share one request, whatever the key order
  expect(sent('quotes')).toEqual([
    { symbol: 'RELIANCE', exchange: 'NSE' },
    { symbol: 'TCS', exchange: 'NSE' },
  ])
  expect(sent('multiquotes')).toHaveLength(1)
  // orders are never deduplicated
  expect(sent('placeorder')).toEqual([order, order])

  const key = run.mock.calls[0]?.[0].dedupeKey
  expect(key).toBe('quotes {"exchange":"NSE","symbol":"RELIANCE"}')
  expect(key).not.toContain(KEY)

  // once the shared request settles, the next read goes out afresh
  const again = api.call('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, ANY)
  await jest.advanceTimersByTimeAsync(100)
  await again
  expect(sent('quotes')).toHaveLength(3)
})

describe('Deduped callers abort on their own (ruling 3b)', () => {
  const quote = { symbol: 'RELIANCE', exchange: 'NSE' }
  // what the client gives a caller abort on a read (client.test.ts)
  const ABORTED = { kind: 'Network', status: 0, endpoint: 'quotes' }

  test('the first caller aborting leaves a joiner its response', async () => {
    const { api, sent, signals } = setup({ 'POST /api/v1/quotes': later(100, OK) })
    const first = new AbortController()
    const a = track(api.call('quotes', quote, ANY, { signal: first.signal }))
    const b = track(api.call('quotes', quote, ANY, { signal: new AbortController().signal }))
    await jest.advanceTimersByTimeAsync(50)
    expect(sent('quotes')).toHaveLength(1)

    first.abort()
    await jest.advanceTimersByTimeAsync(0)
    expect(a.error).toMatchObject(ABORTED)
    expect(b.settled).toBe(false)
    expect(signals[0]?.aborted).toBe(false)

    await jest.advanceTimersByTimeAsync(50)
    expect(b.value).toEqual({ ok: true })
    expect(sent('quotes')).toHaveLength(1)
  })

  test('callers that all abort before the start send nothing', async () => {
    const { api, sent, scheduler } = setup({ 'POST /api/v1/quotes': later(100, OK) })
    // five other quotes take the bucket, so the shared one queues for the next token
    for (let i = 1; i <= 5; i++) api.call('quotes', { symbol: `S${i}`, exchange: 'NSE' }, ANY)
    const [x, y] = [new AbortController(), new AbortController()]
    const a = track(api.call('quotes', quote, ANY, { signal: x.signal }))
    const b = track(api.call('quotes', quote, ANY, { signal: y.signal }))
    // a signal that is already aborted never queues
    const c = track(api.call('quotes', quote, ANY, { signal: AbortSignal.abort() }))
    await jest.advanceTimersByTimeAsync(50)
    expect(scheduler.stats().queued.read).toBe(1)
    x.abort()
    y.abort()
    // dropped from the queue at once: it never takes a token or counts as started
    expect(scheduler.stats().queued.read).toBe(0)
    await jest.advanceTimersByTimeAsync(2000)
    expect(scheduler.stats().started).toBe(5)

    for (const r of [a, b, c]) expect(r.error).toMatchObject(ABORTED)
    expect(sent('quotes')).not.toContainEqual(quote)
    expect(sent('quotes')).toHaveLength(5)

    // the dropped job is gone: the same read later goes out afresh
    const again = track(api.call('quotes', quote, ANY))
    await jest.advanceTimersByTimeAsync(100)
    expect(again.value).toEqual({ ok: true })
    expect(sent('quotes')).toHaveLength(6)
  })

  test('a caller that aborts as its request starts sends nothing', async () => {
    const { api, fetch } = setup({ 'POST /api/v1/quotes': later(100, OK) })
    const x = new AbortController()
    // the bucket is full, so run() starts it at once; exec waits for a microtask
    const a = track(api.call('quotes', quote, ANY, { signal: x.signal }))
    x.abort()
    await jest.advanceTimersByTimeAsync(1000)
    expect(a.error).toMatchObject(ABORTED)
    expect(fetch.calls).toHaveLength(0)
  })

  test('callers that all abort in flight abort the request', async () => {
    const { api, sent, signals } = setup({ 'POST /api/v1/quotes': later(1000, OK) })
    const [x, y] = [new AbortController(), new AbortController()]
    const a = track(api.call('quotes', quote, ANY, { signal: x.signal }))
    const b = track(api.call('quotes', quote, ANY, { signal: y.signal }))
    await jest.advanceTimersByTimeAsync(10)
    expect(sent('quotes')).toHaveLength(1)

    x.abort()
    await jest.advanceTimersByTimeAsync(0)
    expect(a.error).toMatchObject(ABORTED)
    expect(signals[0]?.aborted).toBe(false)

    y.abort()
    // a read queued right after the last abort does not join the aborted request,
    // and that request's end does not unshare the new one
    const c = track(api.call('quotes', quote, ANY))
    await jest.advanceTimersByTimeAsync(0)
    expect(b.error).toMatchObject(ABORTED)
    expect(signals[0]?.aborted).toBe(true)
    const d = track(api.call('quotes', quote, ANY))

    await jest.advanceTimersByTimeAsync(1000)
    expect(c.value).toEqual({ ok: true })
    expect(d.value).toEqual({ ok: true })
    expect(sent('quotes')).toHaveLength(2)
  })
})

test('B6 No retry', async () => {
  const cases: [EndpointId, Record<string, unknown>, ScriptedReply | 'throw', ApiErrorKind][] = [
    [
      'funds',
      {},
      { status: 403, body: { status: 'error', message: 'Invalid openalgo apikey' } },
      'KeyInvalid',
    ],
    // endpoint-level Unsupported: nothing to drop, even on a lane that self-heals
    [
      'history',
      { symbol: 'SBIN', source: 'api' },
      { status: 404, body: { status: 'error', message: 'Not found' } },
      'Unsupported',
    ],
    [
      'sectorrotation',
      {},
      { status: 200, contentType: 'text/html', body: '<!doctype html>' },
      'Unsupported',
    ],
    [
      'placeorder',
      { symbol: 'SBIN' },
      {
        status: 429,
        body: {
          status: 'error',
          message: 'Rate limit exceeded. Please slow down your requests.',
          retry_after: 60,
        },
      },
      'RateLimited',
    ],
    ['placeorder', { symbol: 'SBIN' }, 'throw', 'MaybePlaced'],
    [
      'placesmartorder',
      { symbol: 'SBIN' },
      { status: 502, body: '<html>Bad Gateway</html>' },
      'MaybePlaced',
    ],
  ]
  for (const [id, body, reply, kind] of cases) {
    const { api, fetch, fields } = setup({ [`POST /api/v1/${id}`]: reply })
    await expect(api.call(id, body, ANY)).rejects.toMatchObject({ kind, endpoint: id })
    await jest.advanceTimersByTimeAsync(120_000)
    expect(fetch.calls).toHaveLength(1)
    expect(fields.markUnsupported).not.toHaveBeenCalled()
  }
})

describe('B9 Self-heal', () => {
  /** Refuses `field` with `reply` (one of the S7 shapes) and answers OK without it. */
  const refuses =
    (field: string, reply: ScriptedReply): Route =>
    (req) =>
      field in (req.body as object) ? reply : OK
  const SOURCE_UNKNOWN: ScriptedReply = {
    status: 400,
    body: { status: 'error', message: { source: ['Unknown field.'] } },
  }
  const GREEKS_UNKNOWN: ScriptedReply = {
    status: 400,
    body: {
      status: 'error',
      message: 'Validation error',
      errors: { with_greeks: ['Unknown field.'] },
    },
  }
  const history = {
    symbol: 'SBIN',
    exchange: 'NSE',
    interval: 'D',
    start_date: '2026-11-02',
    end_date: '2026-11-20',
    source: 'api',
  }
  const { source: _, ...historyWithoutSource } = history

  test('history drops source and retries once, then never sends it again', async () => {
    const { api, fields, sent } = setup({
      'POST /api/v1/history': refuses('source', SOURCE_UNKNOWN),
    })
    await within1s(expect(api.call('history', history, ANY)).resolves.toEqual({ ok: true }))
    expect(fields.adapt).toHaveBeenCalledWith('history', history)
    expect(fields.markUnsupported).toHaveBeenCalledWith('history', 'source')
    expect(sent('history')).toEqual([history, historyWithoutSource])

    await within1s(expect(api.call('history', history, ANY)).resolves.toEqual({ ok: true }))
    expect(sent('history')).toEqual([history, historyWithoutSource, historyWithoutSource])
  })

  test('optionchain drops with_greeks and keeps the fields the server knows', async () => {
    const { api, fields, sent } = setup({
      'POST /api/v1/optionchain': refuses('with_greeks', GREEKS_UNKNOWN),
    })
    const body = {
      underlying: 'NIFTY',
      exchange: 'NSE_INDEX',
      with_greeks: true,
      interest_rate: 6.5,
    }
    await expect(api.call('optionchain', body, ANY)).resolves.toEqual({ ok: true })
    expect(fields.markUnsupported).toHaveBeenCalledTimes(1)
    expect(fields.markUnsupported).toHaveBeenCalledWith('optionchain', 'with_greeks')
    expect(sent('optionchain')[1]).toEqual({
      underlying: 'NIFTY',
      exchange: 'NSE_INDEX',
      interest_rate: 6.5,
    })
  })

  test('placeorder never retries', async () => {
    // even if an order endpoint listed the field as optional: the order lane never heals
    jest.replaceProperty(ENDPOINTS, 'placeorder', {
      ...ENDPOINTS.placeorder,
      optional: ['strategy'],
    })
    const { api, fields, sent } = setup({
      'POST /api/v1/placeorder': {
        status: 400,
        body: { status: 'error', message: "{'strategy': ['Unknown field.']}" },
      },
    })
    await expect(
      api.call('placeorder', { strategy: 'mobile', symbol: 'SBIN' }, ANY),
    ).rejects.toMatchObject({
      kind: 'Unsupported',
      unknownFields: ['strategy'],
    })
    expect(sent('placeorder')).toHaveLength(1)
    expect(fields.markUnsupported).not.toHaveBeenCalled()
  })

  test('only optional fields heal, and only once', async () => {
    const stillRefused = setup({ 'POST /api/v1/history': SOURCE_UNKNOWN })
    await within1s(
      expect(stillRefused.api.call('history', history, ANY)).rejects.toMatchObject({
        kind: 'Unsupported',
      }),
    )
    expect(stillRefused.sent('history')).toEqual([history, historyWithoutSource])

    const notOptional = setup({
      'POST /api/v1/history': {
        status: 400,
        body: { status: 'error', message: { oi: ['Unknown field.'] } },
      },
    })
    await expect(
      notOptional.api.call('history', { ...history, oi: true }, ANY),
    ).rejects.toMatchObject({
      kind: 'Unsupported',
      unknownFields: ['oi'],
    })
    expect(notOptional.sent('history')).toHaveLength(1)
    expect(notOptional.fields.markUnsupported).not.toHaveBeenCalled()
  })
})
