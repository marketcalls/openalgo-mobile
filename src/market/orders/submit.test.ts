import type { QueryClient } from '@tanstack/react-query'
import type { PromptResult } from '~/core/credentials/lock'
import { createApi } from '~/core/http/api'
import { createHttpClient } from '~/core/http/client'
import { ApiError } from '~/core/http/errors'
import { createScheduler } from '~/core/http/scheduler'
import { createQueryClient } from '~/core/query/queryClient'
import analyzeFixture from '../../../test/fixtures/openalgo-docs/analyzer-analyze.json'
import liveFixture from '../../../test/fixtures/openalgo-docs/analyzer-live.json'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createAnalyzerGate } from './analyzerGate'
import { createOrderApi } from './api'
import type { OrderSpec } from './schemas'
import { type ActionKind, CONFIRM_FAILED, type Outcome, submitOrderAction } from './submit'

const KEY = 'ab'.repeat(32)
const SPEC: OrderSpec = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 1,
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
}
const LIVE: ScriptedReply = { status: 200, body: liveFixture }
const ANALYZE: ScriptedReply = { status: 200, body: analyzeFixture }
const PLACED: ScriptedReply = {
  status: 200,
  body: { status: 'success', orderid: '250408000989443' },
}
const CANCEL_SEMI_AUTO =
  'Cancel order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.'

let qc: QueryClient
beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 10, 25, 4, 0) })
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => {
  qc?.clear()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

/** The real client, scheduler, Api, gate and order api over a scripted server. */
function setup(routes: Record<string, Route>, o: { backoffStartMs?: number } = {}) {
  const fetch = scriptedFetch(routes)
  const http = createHttpClient({
    origin: 'https://algo.example.com',
    getKey: () => KEY,
    fetch,
    resolveAuth403: async () => 'broker_logged_out',
  })
  const scheduler = createScheduler({ backoffStartMs: o.backoffStartMs })
  const api = createApi({ http, scheduler, fields: { adapt: (_id, b) => b, markUnsupported() {} } })
  qc = createQueryClient()
  const gate = createAnalyzerGate({ queryClient: qc, pid: 'p1', api })
  const orders = createOrderApi(api)
  const books = { poke: jest.fn() }
  const confirmLive = jest.fn(async (): Promise<PromptResult> => 'ok')
  const onSemiAuto = jest.fn()
  const requests = (id: string) => fetch.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
  function submit<R>(kind: ActionKind, shownMode: 'live' | 'analyze', send: () => Promise<R>) {
    return submitOrderAction({ kind, shownMode, send, gate, confirmLive, books, onSemiAuto })
  }
  return { gate, orders, books, confirmLive, onSemiAuto, requests, submit }
}

describe('submitOrderAction: the analyzer read (RF 2)', () => {
  test('shown ANALYZE but the server reads LIVE: mode_changed, and send is never called', async () => {
    const t = setup({ 'POST /api/v1/analyzer': LIVE, 'POST /api/v1/placeorder': PLACED })
    const send = jest.fn(() => t.orders.place(SPEC))
    expect(await t.submit('place', 'analyze', send)).toEqual({ kind: 'mode_changed', now: 'live' })
    expect(send).not.toHaveBeenCalled()
    expect(t.requests('placeorder')).toHaveLength(0)
    expect(t.confirmLive).not.toHaveBeenCalled()
    expect(t.books.poke).not.toHaveBeenCalled()
  })

  test('shown LIVE but the server reads ANALYZE: mode_changed', async () => {
    const t = setup({ 'POST /api/v1/analyzer': ANALYZE })
    const send = jest.fn(async () => 'never')
    expect(await t.submit('cancel', 'live', send)).toEqual({ kind: 'mode_changed', now: 'analyze' })
    expect(send).not.toHaveBeenCalled()
  })

  test('an analyzer read that fails with Network: error, and nothing is sent', async () => {
    const t = setup({ 'POST /api/v1/analyzer': 'throw', 'POST /api/v1/placeorder': PLACED })
    const send = jest.fn(() => t.orders.place(SPEC))
    const out = await t.submit('place', 'live', send)
    expect(out).toMatchObject({ kind: 'error', error: { kind: 'Network', endpoint: 'analyzer' } })
    expect(send).not.toHaveBeenCalled()
    expect(t.requests('analyzer')).toHaveLength(1)
    expect(t.requests('placeorder')).toHaveLength(0)
    expect(t.books.poke).not.toHaveBeenCalled()
  })

  test('an analyzer read held behind a 429 gate: error at the 5 s deadline, nothing sent', async () => {
    const t = setup(
      {
        'POST /api/v1/analyzer': {
          status: 429,
          body: { status: 'error', message: 'Rate limited' },
        },
        'POST /api/v1/placeorder': PLACED,
      },
      { backoffStartMs: 30_000 },
    )
    const send = jest.fn(() => t.orders.place(SPEC))
    // the 429 closes the analyzer gate for 30 s
    expect(await t.submit('place', 'live', send)).toMatchObject({
      kind: 'error',
      error: { kind: 'RateLimited', status: 429 },
    })
    let out: Outcome<unknown> | undefined
    void t.submit('place', 'live', send).then((o) => {
      out = o
    })
    await jest.advanceTimersByTimeAsync(4_999)
    expect(out).toBeUndefined()
    await jest.advanceTimersByTimeAsync(1)
    expect(out).toMatchObject({ kind: 'error', error: { kind: 'Network', status: 0 } })
    expect(send).not.toHaveBeenCalled()
    expect(t.requests('analyzer')).toHaveLength(1)
    expect(t.requests('placeorder')).toHaveLength(0)
    // the abandoned read still goes when the gate opens, and only the read
    await jest.advanceTimersByTimeAsync(30_000)
    expect(t.requests('analyzer')).toHaveLength(2)
    expect(t.requests('placeorder')).toHaveLength(0)
  })
})

describe('submitOrderAction: the live confirm', () => {
  test('cancelled in live mode: cancelled, and nothing is sent', async () => {
    const t = setup({ 'POST /api/v1/analyzer': LIVE, 'POST /api/v1/placeorder': PLACED })
    t.confirmLive.mockResolvedValueOnce('cancelled')
    const send = jest.fn(() => t.orders.place(SPEC))
    expect(await t.submit('place', 'live', send)).toEqual({ kind: 'cancelled' })
    expect(send).not.toHaveBeenCalled()
    expect(t.books.poke).not.toHaveBeenCalled()
  })

  test('a failed check is cancelled with the biometrics copy; a throwing one too', async () => {
    const t = setup({ 'POST /api/v1/analyzer': LIVE })
    const send = jest.fn(async () => 'never')
    t.confirmLive.mockResolvedValueOnce('failed')
    expect(await t.submit('closeAll', 'live', send)).toEqual({
      kind: 'cancelled',
      message: CONFIRM_FAILED,
    })
    t.confirmLive.mockRejectedValueOnce(new Error('prompt crashed'))
    expect(await t.submit('closeAll', 'live', send)).toEqual({
      kind: 'cancelled',
      message: CONFIRM_FAILED,
    })
    expect(CONFIRM_FAILED).toBe('Could not confirm with biometrics. Try again.')
    expect(send).not.toHaveBeenCalled()
  })

  test('in analyzer mode the confirm is never asked', async () => {
    const t = setup({
      'POST /api/v1/analyzer': ANALYZE,
      'POST /api/v1/placeorder': {
        status: 200,
        body: { status: 'success', orderid: 'A1', mode: 'analyze' },
      },
    })
    const out = await t.submit('place', 'analyze', () => t.orders.place(SPEC))
    expect(out).toEqual({ kind: 'done', reply: { kind: 'placed', orderid: 'A1', analyze: true } })
    expect(t.confirmLive).not.toHaveBeenCalled()
    expect(t.requests('placeorder')).toHaveLength(1)
  })

  test('live, confirmed: the read, the confirm, one send, then the books poke, in that order', async () => {
    const events: string[] = []
    const t = setup({
      'POST /api/v1/analyzer': () => {
        events.push('read')
        return LIVE
      },
      'POST /api/v1/placeorder': () => {
        events.push('send')
        return PLACED
      },
    })
    t.confirmLive.mockImplementationOnce(async () => {
      events.push('confirm')
      return 'ok'
    })
    t.books.poke.mockImplementation(() => events.push('poke'))
    const out = await t.submit('place', 'live', () => t.orders.place(SPEC))
    expect(out).toEqual({
      kind: 'done',
      reply: { kind: 'placed', orderid: '250408000989443', analyze: false },
    })
    expect(events).toEqual(['read', 'confirm', 'send', 'poke'])
    expect(t.requests('placeorder')[0]?.body).toMatchObject({ strategy: 'mobile' })
  })
})

describe('submitOrderAction: replies and failures', () => {
  test('MaybePlaced (a 502): maybe, sent once, and the books are poked', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/placeorder': {
        status: 502,
        contentType: 'text/html',
        body: '<html><body>502 Bad Gateway</body></html>',
      },
    })
    const send = jest.fn(() => t.orders.place(SPEC))
    expect(await t.submit('place', 'live', send)).toEqual({ kind: 'maybe' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.requests('placeorder')).toHaveLength(1)
    expect(t.books.poke).toHaveBeenCalledTimes(1)
  })

  test('a timeout on the order lane is maybe too, and is not sent again', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/placeorder': () => new Promise<never>(() => {}),
    })
    let out: Outcome<unknown> | undefined
    void t
      .submit('place', 'live', () => t.orders.place(SPEC))
      .then((o) => {
        out = o
      })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(out).toEqual({ kind: 'maybe' })
    expect(t.requests('placeorder')).toHaveLength(1)
  })

  test('SemiAutoBlocked carries the server message and calls onSemiAuto', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/cancelorder': {
        status: 403,
        body: { status: 'error', message: CANCEL_SEMI_AUTO },
      },
    })
    const out = await t.submit('cancel', 'live', () => t.orders.cancel('250408000989443'))
    expect(out).toEqual({ kind: 'semi_auto_blocked', message: CANCEL_SEMI_AUTO })
    expect(t.onSemiAuto).toHaveBeenCalledTimes(1)
    expect(t.books.poke).toHaveBeenCalledTimes(1)
    expect(t.requests('cancelorder')).toHaveLength(1)
  })

  test('a queued reply is done, and calls onSemiAuto', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/placeorder': {
        status: 200,
        body: {
          status: 'success',
          message: 'Order queued for approval in Action Center',
          mode: 'semi_auto',
          pending_order_id: 12,
        },
      },
    })
    const out = await t.submit('place', 'live', () => t.orders.place(SPEC))
    expect(out).toEqual({ kind: 'done', reply: { kind: 'queued', pendingId: '12' } })
    expect(t.onSemiAuto).toHaveBeenCalledTimes(1)
    expect(t.books.poke).toHaveBeenCalledTimes(1)
  })

  test('any other refusal is error, with its ApiError; still sent once and poked', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/placeorder': {
        status: 400,
        body: { status: 'error', message: 'Invalid symbol' },
      },
    })
    const out = await t.submit('place', 'live', () => t.orders.place(SPEC))
    expect(out.kind).toBe('error')
    const error = out.kind === 'error' ? out.error : undefined
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'Validation', serverMessage: 'Invalid symbol' })
    expect(t.requests('placeorder')).toHaveLength(1)
    expect(t.books.poke).toHaveBeenCalledTimes(1)
    expect(t.onSemiAuto).not.toHaveBeenCalled()
  })

  test('a failure that is not an ApiError is maybe: the request may have gone', async () => {
    const t = setup({ 'POST /api/v1/analyzer': LIVE })
    const send = jest.fn(async () => {
      throw new TypeError('undefined is not a function')
    })
    expect(await t.submit('modify', 'live', send)).toEqual({ kind: 'maybe' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.books.poke).toHaveBeenCalledTimes(1)
  })

  test('a sandbox reply while LIVE was shown notes ANALYZE for the next read', async () => {
    const t = setup({
      'POST /api/v1/analyzer': LIVE,
      'POST /api/v1/placeorder': {
        status: 200,
        body: { status: 'success', orderid: 'A1', mode: 'analyze' },
      },
    })
    expect(await t.submit('place', 'live', () => t.orders.place(SPEC))).toMatchObject({
      kind: 'done',
      reply: { analyze: true },
    })
    expect(t.gate.peek()).toBe('analyze')
    const send = jest.fn(async () => 'never')
    expect(await t.submit('place', 'live', send)).toEqual({ kind: 'mode_changed', now: 'analyze' })
    expect(t.requests('analyzer')).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })

  test('a reply without a mode leaves the reading alone', async () => {
    const t = setup({
      'POST /api/v1/analyzer': ANALYZE,
      'POST /api/v1/cancelallorder': {
        status: 200,
        body: {
          status: 'success',
          message: 'Canceled 0 orders.',
          canceled_orders: [],
          failed_cancellations: [],
        },
      },
    })
    expect(await t.submit('cancelAll', 'analyze', () => t.orders.cancelAll())).toEqual({
      kind: 'done',
      reply: { canceled: [], failed: [] },
    })
    expect(t.gate.peek()).toBe('analyze')
  })
})
