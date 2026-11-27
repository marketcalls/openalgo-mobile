import { z } from 'zod'
import type { Api } from '~/core/http/api'
import { ApiError, type ApiErrorKind, userMessage } from '~/core/http/errors'
import { SearchSchema } from '~/core/http/schemas'
import { clearLogs, getLogLines } from '~/core/log/logger'
import { type DomRequest, type JSONValue, NATIVE_KEY } from '~/dom/bridge/protocol'
import { HistorySchema } from '~/market/chart/schemas'
import { createChartRoutes } from './chartRoutes'
import {
  createRequestRouter,
  fromApiError,
  MAX_DOM_INFLIGHT,
  ok,
  pickFields,
  REFUSED_COPY,
  type Route,
  refused,
  TOO_MANY_COPY,
} from './requests'

type Call = (
  id: string,
  body: Record<string, unknown>,
  schema: unknown,
  o?: { signal?: AbortSignal },
) => Promise<unknown>

const HISTORY = {
  symbol: 'INFY',
  exchange: 'NSE',
  interval: '5m',
  start_date: '2026-11-20',
  end_date: '2026-11-26',
}
const ROWS = [{ timestamp: 1764215100, open: 1500, high: 1505, low: 1498, close: 1503, volume: 9 }]
const FOUND = [{ symbol: 'INFY', exchange: 'NSE', name: 'INFOSYS LTD' }]
const REFUSED = { status: 403, body: { status: 'error', message: REFUSED_COPY } }
const TOO_MANY = {
  status: 429,
  body: { status: 'error', code: 'TOO_MANY', message: TOO_MANY_COPY },
}

let lastRid = 0
function req(path: string, body?: JSONValue, method: DomRequest['method'] = 'POST'): DomRequest {
  const r: DomRequest = { v: 1, kind: 'request', rid: ++lastRid, method, path }
  if (body !== undefined) r.body = body
  return r
}

function setup(o?: { whenActive?: () => Promise<void> }) {
  // What Api.call resolves with: the parsed reply (HistorySchema keeps its dropped count).
  const call = jest.fn<ReturnType<Call>, Parameters<Call>>(async (id) =>
    id === 'history' ? { rows: ROWS, dropped: 0 } : FOUND,
  )
  const router = createRequestRouter(createChartRoutes({ call } as unknown as Pick<Api, 'call'>), o)
  const ctl = new AbortController()
  return { call, ctl, signal: ctl.signal, route: (r: DomRequest) => router(r, ctl.signal) }
}

/** Lets pending promise callbacks run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  clearLogs()
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())
const logged = (text: string) => getLogLines().filter((l) => l.includes(text))

describe('the chart routes', () => {
  test('history goes through Api.call with only its five fields', async () => {
    const { call, route, signal } = setup()
    const reply = await route(
      req('/api/v1/history', {
        apikey: NATIVE_KEY,
        ...HISTORY,
        source: 'api',
        x: 1,
      }),
    )
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('history', HISTORY, HistorySchema, { signal })
    expect(reply).toEqual({ status: 200, body: { status: 'success', data: ROWS } })
    expect(logged('history dropped')).toEqual([])
  })

  test('history answers the candles it could read and logs how many it dropped', async () => {
    const { call, route } = setup()
    // The real schema, on a reply with three unreadable candles among the good one.
    call.mockImplementationOnce(async (_id, _b, schema) =>
      (schema as typeof HistorySchema).parse({
        status: 'success',
        data: [...ROWS, { timestamp: 'x', open: 1, high: 1, low: 1, close: 1 }, 'junk', null],
      }),
    )
    await expect(route(req('/api/v1/history', HISTORY))).resolves.toEqual(ok(ROWS))
    expect(logged('history dropped')).toHaveLength(1)
    expect(logged('WARN [chart] history dropped 3 rows')).toHaveLength(1)
  })

  test('search sends only the query', async () => {
    const { call, route, signal } = setup()
    const reply = await route(
      req('/api/v1/search', { apikey: NATIVE_KEY, query: 'INF', exchange: 'NSE' }),
    )
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('search', { query: 'INF' }, SearchSchema, { signal })
    expect(reply).toEqual({ status: 200, body: { status: 'success', data: FOUND } })
  })

  test('an aborted request aborts its Api.call; a request while inactive waits for whenActive', async () => {
    // A call that settles only when its signal aborts, as the scheduler's does.
    const hung: Call = (id, _b, _s, o) =>
      new Promise((_resolve, reject) => {
        o?.signal?.addEventListener('abort', () =>
          reject(new ApiError({ kind: 'Network', status: 0, endpoint: id })),
        )
      })

    const a = setup()
    a.call.mockImplementation(hung)
    const sent = a.route(req('/api/v1/history', HISTORY))
    await settle()
    expect(a.call).toHaveBeenCalledTimes(1)
    a.ctl.abort()
    await expect(sent).rejects.toBeInstanceOf(Error)
    expect(a.call.mock.calls[0]?.[3]?.signal?.aborted).toBe(true)

    let show = () => {}
    const b = setup({ whenActive: () => new Promise<void>((r) => (show = r)) })
    const waiting = b.route(req('/api/v1/history', HISTORY))
    await settle()
    expect(b.call).not.toHaveBeenCalled()
    show()
    await expect(waiting).resolves.toEqual(ok(ROWS))
    expect(b.call).toHaveBeenCalledTimes(1)

    // An abort while hidden rejects at once, and nothing is sent.
    const c = setup({ whenActive: () => new Promise<void>(() => {}) })
    const dropped = c.route(req('/api/v1/history', HISTORY))
    await settle()
    c.ctl.abort()
    await expect(dropped).rejects.toBeInstanceOf(Error)
    expect(c.call).not.toHaveBeenCalled()

    // A signal that aborted before the request came is not sent either.
    const d = setup()
    d.ctl.abort()
    await expect(d.route(req('/api/v1/search', { query: 'INF' }))).rejects.toBeInstanceOf(Error)
    expect(d.call).not.toHaveBeenCalled()
  })

  test('whenActive gates every request', async () => {
    const whenActive = jest.fn(async () => {})
    const { call, route } = setup({ whenActive })
    await route(req('/api/v1/history', HISTORY))
    await route(req('/api/v1/search', { query: 'INF' }))
    expect(whenActive).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledTimes(2)
  })

  test.each([
    '/api/v1/placeorder',
    '/api/v1/orderbook',
    '/auth/csrf-token',
    '/api/websocket/apikey',
    '/api/v1/history/',
    '/api/v1/History',
    '/api/v1/%68istory',
    '/api/v1',
  ])('%s is a JSON 403 and nothing is sent', async (path) => {
    // A refusal answers at once, even while the screen is hidden.
    const { call, route } = setup({ whenActive: () => new Promise<void>(() => {}) })
    await expect(
      route(req(path, { apikey: NATIVE_KEY, query: 'INF', ...HISTORY })),
    ).resolves.toEqual(REFUSED)
    expect(call).not.toHaveBeenCalled()
  })

  test('GET history, a bad exchange or a bad date is refused and nothing is sent', async () => {
    const { call, route } = setup()
    const bad: Array<[string, JSONValue | undefined, ('GET' | 'POST')?]> = [
      ['/api/v1/history', undefined, 'GET'],
      ['/api/v1/history', HISTORY, 'GET'],
      ['/api/v1/search', { query: 'INF' }, 'GET'],
      ['/api/v1/history', { ...HISTORY, exchange: 'XYZ' }],
      ['/api/v1/history', { ...HISTORY, exchange: 'nse' }],
      ['/api/v1/history', { ...HISTORY, start_date: '2026-11-2' }],
      ['/api/v1/history', { ...HISTORY, end_date: '26-11-2026' }],
      ['/api/v1/history', { ...HISTORY, end_date: '2026-11-26T00:00' }],
      ['/api/v1/history', { ...HISTORY, symbol: '' }],
      ['/api/v1/history', { ...HISTORY, symbol: 'X'.repeat(65) }],
      ['/api/v1/history', { ...HISTORY, symbol: 42 }],
      ['/api/v1/history', { ...HISTORY, interval: '5min' }],
      ['/api/v1/history', { ...HISTORY, interval: '' }],
      ['/api/v1/history', { ...HISTORY, interval: `${'9'.repeat(1000)}m` }],
      ['/api/v1/history', { symbol: 'INFY', exchange: 'NSE', interval: '5m' }],
      ['/api/v1/history', undefined],
      ['/api/v1/history', [HISTORY]],
      ['/api/v1/history', 'INFY'],
      ['/api/v1/search', { query: '' }],
      ['/api/v1/search', { query: 'Q'.repeat(65) }],
      ['/api/v1/search', { query: 7 }],
      ['/api/v1/search', null],
    ]
    for (const [path, body, method] of bad) {
      await expect(route(req(path, body, method))).resolves.toEqual(REFUSED)
    }
    expect(call).not.toHaveBeenCalled()

    // The edges that pass.
    await route(req('/api/v1/history', { ...HISTORY, symbol: 'X'.repeat(64), interval: 'D' }))
    await route(req('/api/v1/search', { query: 'Q'.repeat(64) }))
    expect(call).toHaveBeenCalledTimes(2)
  })

  test.each<[ApiErrorKind, number]>([
    ['RateLimited', 429],
    ['KeyInvalid', 403],
    ['MaybePlaced', 502],
    ['Unsupported', 404],
    ['Validation', 400],
    ['BrokerLoggedOut', 403],
    ['IpBanned', 403],
    ['SemiAutoBlocked', 403],
    ['Server', 502],
    ['Network', 502],
  ])('%s maps to %i, never 401', async (kind, status) => {
    const { call, route } = setup()
    // The server's own status is not passed on: a KeyInvalid is its 401.
    const e = new ApiError({
      kind,
      status: 401,
      endpoint: 'history',
      serverMessage: 'Bad interval',
    })
    call.mockRejectedValueOnce(e)
    await expect(route(req('/api/v1/history', HISTORY))).resolves.toEqual({
      status,
      body: { status: 'error', message: userMessage(e) },
    })
  })

  test('an error that is not an ApiError is a 502 that names nothing of it', async () => {
    const { call, route } = setup()
    call.mockRejectedValueOnce(new TypeError('secret detail'))
    const reply = await route(req('/api/v1/search', { query: 'INF' }))
    expect(reply).toEqual(fromApiError(new TypeError('anything')))
    expect(reply.status).toBe(502)
    expect(JSON.stringify(reply.body)).not.toContain('secret')
    expect(reply.body).toEqual({
      status: 'error',
      message: userMessage(new ApiError({ kind: 'Server', status: 0, endpoint: 'x' })),
    })
  })

  test('a route that throws something other than an ApiError is logged by name only', async () => {
    const { call, route } = setup()
    call.mockRejectedValueOnce(new TypeError('secret detail'))
    await route(req('/api/v1/search', { query: 'INF' }))
    expect(logged('a route failed')).toEqual([
      expect.stringContaining('WARN [dom] a route failed: TypeError'),
    ])
    expect(getLogLines().join('\n')).not.toContain('secret')

    // A thrown value that is not an Error names only its type.
    clearLogs()
    call.mockRejectedValueOnce('secret text')
    await expect(route(req('/api/v1/search', { query: 'INF' }))).resolves.toMatchObject({
      status: 502,
    })
    expect(logged('a route failed')).toEqual([expect.stringContaining('a route failed: string')])
    expect(getLogLines().join('\n')).not.toContain('secret')

    // An ApiError is the client's outcome, not a route bug: the router adds no line.
    clearLogs()
    call.mockRejectedValueOnce(new ApiError({ kind: 'Server', status: 500, endpoint: 'search' }))
    await route(req('/api/v1/search', { query: 'INF' }))
    expect(logged('a route failed')).toEqual([])
  })
})

describe('the in-flight cap', () => {
  /** A router whose Api.call settles only when told to, or when its request aborts. */
  function held(o?: {
    whenActive?: () => Promise<void>
    slotKey?: (r: DomRequest) => string | null
  }) {
    const pending: Array<{ answer(): void; fail(): void }> = []
    const call = jest.fn<ReturnType<Call>, Parameters<Call>>(
      (id, _b, _s, c) =>
        new Promise((resolve, reject) => {
          const failed = () => reject(new ApiError({ kind: 'Network', status: 0, endpoint: id }))
          pending.push({
            answer: () => resolve(id === 'history' ? { rows: ROWS, dropped: 0 } : FOUND),
            fail: failed,
          })
          c?.signal?.addEventListener('abort', failed)
        }),
    )
    const router = createRequestRouter(
      createChartRoutes({ call } as unknown as Pick<Api, 'call'>),
      o,
    )
    const send = (r: DomRequest) => {
      const ctl = new AbortController()
      return { ctl, reply: router(r, ctl.signal) }
    }
    return { call, pending, send }
  }

  test(`request ${MAX_DOM_INFLIGHT + 1} is a 429 at once and nothing is sent`, async () => {
    expect(MAX_DOM_INFLIGHT).toBe(8)
    const { call, pending, send } = held()
    const first = Array.from({ length: MAX_DOM_INFLIGHT }, (_, i) =>
      send(req(i % 2 ? '/api/v1/search' : '/api/v1/history', i % 2 ? { query: 'INF' } : HISTORY)),
    )
    await settle()
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT)

    await expect(send(req('/api/v1/search', { query: 'INF' })).reply).resolves.toEqual(TOO_MANY)
    await expect(send(req('/api/v1/history', HISTORY)).reply).resolves.toEqual(TOO_MANY)
    // A path with no route is still the plain refusal.
    await expect(send(req('/api/v1/placeorder', {})).reply).resolves.toEqual(REFUSED)
    await settle()
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT)

    // A request that is answered frees its slot, and so does one that fails or that the page
    // aborts; each freed slot takes exactly one more.
    pending[0]?.answer()
    await expect(first[0]?.reply).resolves.toEqual(ok(ROWS))
    pending[1]?.fail()
    await expect(first[1]?.reply).resolves.toMatchObject({ status: 502 })
    first[2]?.ctl.abort()
    await expect(first[2]?.reply).rejects.toBeInstanceOf(Error)
    for (let i = 0; i < 3; i++) send(req('/api/v1/search', { query: 'INF' }))
    await settle()
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT + 3)
    await expect(send(req('/api/v1/search', { query: 'INF' })).reply).resolves.toEqual(TOO_MANY)
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT + 3)
  })

  test('requests waiting for whenActive hold their slots; a refused body frees its own', async () => {
    let show = () => {}
    const shown = new Promise<void>((r) => (show = r))
    const { call, pending, send } = held({ whenActive: () => shown })
    const waiting = Array.from({ length: MAX_DOM_INFLIGHT - 1 }, () =>
      send(req('/api/v1/search', { query: 'INF' })),
    )
    const bad = send(req('/api/v1/search', { query: '' }))
    await settle()
    expect(call).not.toHaveBeenCalled()
    // Hidden, the page is full: one more is refused at once, not queued for the focus.
    await expect(send(req('/api/v1/history', HISTORY)).reply).resolves.toEqual(TOO_MANY)

    show()
    await expect(bad.reply).resolves.toEqual(REFUSED)
    await settle()
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT - 1)
    // The bad body's slot is free again.
    send(req('/api/v1/history', HISTORY))
    await settle()
    expect(call).toHaveBeenCalledTimes(MAX_DOM_INFLIGHT)
    for (const p of pending) p.answer()
    await expect(Promise.all(waiting.map((w) => w.reply))).resolves.toHaveLength(
      MAX_DOM_INFLIGHT - 1,
    )
  })

  test('requests with one slotKey share one slot until the last of them ends; a null key has its own', async () => {
    let show = () => {}
    const shown = new Promise<void>((r) => (show = r))
    // the key a caller gives requests that go as one: here, by query
    const slotKey = (r: DomRequest) => {
      const q = (r.body as { query?: string } | undefined)?.query
      return q?.startsWith('same') ? q : null
    }
    const { send } = held({ whenActive: () => shown, slotKey })
    const same = Array.from({ length: MAX_DOM_INFLIGHT * 2 }, () =>
      send(req('/api/v1/search', { query: 'same' })),
    )
    const own = Array.from({ length: MAX_DOM_INFLIGHT - 1 }, () =>
      send(req('/api/v1/search', { query: 'INF' })),
    )
    await settle()
    // 1 shared slot + 7 own: full; a new key or a null key is refused, the same key joins
    await expect(send(req('/api/v1/search', { query: 'same-2' })).reply).resolves.toEqual(TOO_MANY)
    await expect(send(req('/api/v1/search', { query: 'INF' })).reply).resolves.toEqual(TOO_MANY)
    const late = send(req('/api/v1/search', { query: 'same' }))
    // all but one sharer give up: the slot stays with the last
    for (const r of same) r.ctl.abort()
    await Promise.allSettled(same.map((r) => r.reply))
    await expect(send(req('/api/v1/search', { query: 'same-3' })).reply).resolves.toEqual(TOO_MANY)
    // the last one ends: the slot is free
    late.ctl.abort()
    await expect(late.reply).rejects.toBeInstanceOf(Error)
    const next = send(req('/api/v1/search', { query: 'same-4' }))
    let refusedNext = false
    void next.reply.then(
      (x) => {
        refusedNext = x.status === 429
      },
      () => {},
    )
    await settle()
    expect(refusedNext).toBe(false)
    show()
    for (const r of [...own, next]) r.ctl.abort()
    await Promise.allSettled([...own, next].map((r) => r.reply))
  })

  test('each router counts its own page', async () => {
    const a = held()
    const b = held()
    for (let i = 0; i < MAX_DOM_INFLIGHT; i++) a.send(req('/api/v1/search', { query: 'INF' }))
    await settle()
    await expect(a.send(req('/api/v1/search', { query: 'INF' })).reply).resolves.toEqual(TOO_MANY)
    b.send(req('/api/v1/search', { query: 'INF' }))
    await settle()
    expect(b.call).toHaveBeenCalledTimes(1)
  })
})

describe('the router parts', () => {
  test('ok and refused are the server-shaped envelopes', () => {
    expect(ok([1])).toEqual({ status: 200, body: { status: 'success', data: [1] } })
    expect(refused()).toEqual(REFUSED)
    expect(refused()).not.toBe(refused())
  })

  test('pickFields drops unknown fields and refuses only a bad one', () => {
    const schema = z.object({ query: z.string().max(4) })
    expect(pickFields({ query: 'INF', apikey: NATIVE_KEY, x: 1 }, schema)).toEqual({ query: 'INF' })
    expect(pickFields({ query: 'TOO LONG' }, schema)).toBeNull()
    expect(pickFields({ apikey: NATIVE_KEY }, schema)).toBeNull()
    expect(pickFields(undefined, schema)).toBeNull()
    expect(pickFields(['INF'], schema)).toBeNull()
  })

  test('a route answers only its own method and exact path', async () => {
    const handle = jest.fn(async () => ok(null))
    const router = createRequestRouter([{ method: 'POST', path: '/api/v1/x', handle }])
    const signal = new AbortController().signal
    await expect(router(req('/api/v1/x', {}, 'GET'), signal)).resolves.toEqual(REFUSED)
    await expect(router(req('/api/v1/x/', {}), signal)).resolves.toEqual(REFUSED)
    expect(handle).not.toHaveBeenCalled()
    const r = req('/api/v1/x', {})
    await expect(router(r, signal)).resolves.toEqual(ok(null))
    expect(handle).toHaveBeenCalledWith(r, signal)
  })
})

describe('a route with a path parameter', () => {
  const item: Route = {
    method: 'DELETE',
    path: '/x/:id',
    match: /^\/x\/(\d{1,3})$/,
    handle: async (r) => ok(r.path),
  }
  const signal = new AbortController().signal

  test('matches by its pattern instead of its path, for its own method only', async () => {
    const router = createRequestRouter([item])
    await expect(router(req('/x/42', undefined, 'DELETE'), signal)).resolves.toEqual(ok('/x/42'))
    for (const p of ['/x/:id', '/x/abc', '/x/1234', '/x/4/', '/y/42']) {
      await expect(router(req(p, undefined, 'DELETE'), signal)).resolves.toEqual(REFUSED)
    }
    await expect(router(req('/x/42', undefined, 'GET'), signal)).resolves.toEqual(REFUSED)
    await expect(router(req('/x/42', undefined, 'PUT'), signal)).resolves.toEqual(REFUSED)
  })
})
