import { z } from 'zod'
import { clearLogs, getLogLines } from '~/core/log/logger'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import multiquotes from '../../../test/fixtures/openalgo-docs/multiquotes.json'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { createHttpClient } from './client'
import type { EndpointId } from './endpoints'
import { ApiError } from './errors'
import { envelope, FundsSchema, MultiQuotesSchema } from './schemas'

const ORIGIN = 'https://algo.example.com'
const KEY = 'ab'.repeat(32)
type Auth = 'key_invalid' | 'broker_logged_out'

function setup(routes: Record<string, Route>, auth: Auth = 'key_invalid') {
  const fetch = scriptedFetch(routes)
  const resolveAuth403 = jest.fn(async (): Promise<Auth> => auth)
  const onResponse = jest.fn()
  const http = createHttpClient({
    origin: ORIGIN,
    getKey: () => KEY,
    fetch,
    resolveAuth403,
    onResponse,
  })
  return { http, fetch, resolveAuth403, onResponse }
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected the request to fail')
}

const json = (status: number, body: unknown): ScriptedReply => ({ status, body })
const err = (status: number, message: unknown) => json(status, { status: 'error', message })
const html = (status: number): ScriptedReply => ({
  status,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html><body><div id="root"></div></body></html>',
})
const BAN_TEXT: ScriptedReply = {
  status: 403,
  contentType: 'text/plain',
  body: 'Access Denied: Your IP has been banned',
}
const BAN_JSON = json(403, { error: 'Access Denied' })
const INVALID_KEY = err(403, 'Invalid openalgo apikey')
const SEMI_AUTO =
  'Cancel order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.'
const BUSY = 'Another mode change is still in progress. Try again in a moment.'

beforeEach(() => {
  clearLogs()
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

describe('classification (first match wins)', () => {
  type Expected = Partial<
    Pick<
      ApiError,
      'kind' | 'banForm' | 'serverMessage' | 'unknownFields' | 'invalidSymbols' | 'refusedAt'
    >
  >
  test.each<[string, EndpointId, ScriptedReply | 'throw', Expected, Auth?]>([
    ['fetch throws on the order lane', 'placeorder', 'throw', { kind: 'MaybePlaced' }],
    ['fetch throws on the smart lane', 'placesmartorder', 'throw', { kind: 'MaybePlaced' }],
    ['fetch throws on a read', 'funds', 'throw', { kind: 'Network' }],
    ['403 text/plain Access Denied', 'funds', BAN_TEXT, { kind: 'IpBanned', banForm: 'text' }],
    [
      '403 JSON Access Denied, no status',
      'search',
      BAN_JSON,
      { kind: 'IpBanned', banForm: 'json' },
    ],
    ['429 restx', 'quotes', json(429, { message: '10 per 1 second' }), { kind: 'RateLimited' }],
    [
      '429 broker busy',
      'history',
      err(429, 'OpenAlgo is pacing requests'),
      { kind: 'RateLimited' },
    ],
    [
      '429 nginx html',
      'placeorder',
      { ...html(429), body: '<html>429</html>' },
      { kind: 'RateLimited' },
    ],
    ['no status: 200 html', 'multioptiongreeks', html(200), { kind: 'Unsupported' }],
    ['no status: 404 html', 'ping', html(404), { kind: 'Unsupported' }],
    ['no status: 502 on an order lane', 'placesmartorder', html(502), { kind: 'MaybePlaced' }],
    // A proxy's own page on an order lane: the order may have reached the broker (design 7.5).
    ['no status: nginx 504 on an order lane', 'placeorder', html(504), { kind: 'MaybePlaced' }],
    [
      'no status: Cloudflare 520 on an order lane',
      'placeorder',
      html(520),
      { kind: 'MaybePlaced' },
    ],
    [
      'no status: Cloudflare 524 on an order lane',
      'placeorder',
      html(524),
      { kind: 'MaybePlaced' },
    ],
    [
      'no status: 500 text/plain on an order lane',
      'placeorder',
      { status: 500, body: 'An unexpected error occurred' },
      { kind: 'MaybePlaced' },
    ],
    [
      'no status: 503 on an order lane (not forwarded)',
      'placeorder',
      html(503),
      { kind: 'Server' },
    ],
    ['no status: 501 on an order lane', 'placeorder', html(501), { kind: 'Server' }],
    ['no status: 502 on a read', 'funds', html(502), { kind: 'Server' }],
    ['no status: 504 on a read', 'funds', html(504), { kind: 'Server' }],
    [
      'no status: 500 text/plain',
      'search',
      { status: 500, body: 'An unexpected error occurred' },
      { kind: 'Server' },
    ],
    ['no status: 403 html from a proxy', 'funds', html(403), { kind: 'Server' }],
    ['no status: 200 JSON', 'funds', json(200, { data: {} }), { kind: 'Server' }],
    // An order lane's 2xx means the server took the request: the order may exist.
    [
      'no status: 200 JSON on an order lane',
      'placeorder',
      json(200, { data: {} }),
      { kind: 'MaybePlaced' },
    ],
    [
      'no status: 200 text on an order lane',
      'splitorder',
      { status: 200, body: 'OK' },
      { kind: 'MaybePlaced' },
    ],
    [
      'no status: 200 non-JSON on the smart lane',
      'placesmartorder',
      { status: 200, contentType: 'application/json', body: '{"status":"succ' },
      { kind: 'MaybePlaced' },
    ],
    // The web app's page: this server has no such route, so nothing was sent on.
    ['no status: 200 html on an order lane', 'placeorder', html(200), { kind: 'Unsupported' }],
    [
      '403 Semi-Auto',
      'cancelorder',
      err(403, SEMI_AUTO),
      { kind: 'SemiAutoBlocked', serverMessage: SEMI_AUTO },
    ],
    ['403 invalid key on keyOnly search', 'search', INVALID_KEY, { kind: 'KeyInvalid' }],
    [
      '403 invalid key, resolved key_invalid',
      'funds',
      INVALID_KEY,
      { kind: 'KeyInvalid' },
      'key_invalid',
    ],
    [
      '403 invalid key, resolved broker_logged_out',
      'ping',
      INVALID_KEY,
      { kind: 'BrokerLoggedOut' },
      'broker_logged_out',
    ],
    [
      '400 with unknown fields',
      'history',
      err(400, { source: ['Unknown field.'] }),
      { kind: 'Unsupported', unknownFields: ['source'] },
    ],
    [
      '404 JSON',
      'sectorrotation',
      json(404, { status: 'error', message: 'Not found', path: '/api/v1/sectorrotation' }),
      { kind: 'Unsupported' },
    ],
    ['501', 'margin', err(501, 'Margin calculation is not supported'), { kind: 'Unsupported' }],
    [
      'other 403',
      'portfolio/backtest',
      err(403, "No broker session for source='api'."),
      { kind: 'Validation', serverMessage: "No broker session for source='api'." },
    ],
    [
      '400 without unknown fields',
      'search',
      err(400, { query: ['Missing data for required field.'] }),
      { kind: 'Validation', serverMessage: 'query: Missing data for required field.' },
    ],
    [
      '400 multiquotes with no valid symbol (quotes_service.py:237-253)',
      'multiquotes',
      json(400, {
        status: 'error',
        message: 'Symbol NIFTY25NOV25FUT not found in exchange NFO',
        invalid_symbols: [
          {
            symbol: 'NIFTY25NOV25FUT',
            exchange: 'NFO',
            error: 'Symbol NIFTY25NOV25FUT not found in exchange NFO',
          },
        ],
      }),
      {
        kind: 'Validation',
        serverMessage: 'Symbol NIFTY25NOV25FUT not found in exchange NFO',
        invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
      },
    ],
    [
      "400 multiquotes refusing an entry's exchange: the whole batch, by index (OneOf, 2.0.0.1+)",
      'multiquotes',
      json(400, {
        status: 'error',
        message: { symbols: { '3': { exchange: ['Must be one of: NSE, NFO, CDS.'] } } },
      }),
      { kind: 'Validation', refusedAt: [3] },
    ],
    ['401', 'multioptiongreeks', err(401, 'Unauthorized'), { kind: 'Validation' }],
    ['409', 'analyzer/toggle', err(409, BUSY), { kind: 'Validation', serverMessage: BUSY }],
    ['422', 'placeorder', err(422, 'Unprocessable'), { kind: 'Validation' }],
    ['other 4xx', 'funds', err(405, 'Method not allowed'), { kind: 'Validation' }],
    [
      '2xx with status error',
      'quotes',
      err(200, 'No data'),
      { kind: 'Validation', serverMessage: 'No data' },
    ],
    ['502 JSON on an order lane', 'placeorder', err(502, 'Bad gateway'), { kind: 'MaybePlaced' }],
    ['502 JSON on a read', 'funds', err(502, 'Bad gateway'), { kind: 'Server' }],
    ['500 JSON', 'funds', err(500, 'An unexpected error occurred'), { kind: 'Server' }],
    ['503 JSON on an order lane', 'placeorder', err(503, 'Unavailable'), { kind: 'Server' }],
    [
      '2xx with status error on an order lane',
      'placeorder',
      err(200, 'Order rejected'),
      { kind: 'Validation', serverMessage: 'Order rejected' },
    ],
    [
      '2xx failing its schema on a read',
      'funds',
      json(200, { status: 'success', data: { availablecash: 'lots' } }),
      { kind: 'Server' },
    ],
    [
      '2xx failing its schema on an order lane',
      'placeorder',
      json(200, { status: 'success', data: { availablecash: 'lots' } }),
      { kind: 'MaybePlaced' },
    ],
    [
      '2xx failing its schema on the smart lane',
      'placesmartorder',
      json(200, { status: 'ok' }),
      { kind: 'MaybePlaced' },
    ],
    // A rest parameter: a fifth named one would make jest wait for `done` on 4-cell rows.
  ])('%s', async (...[, id, reply, expected, auth]) => {
    const { http } = setup({ [`POST /api/v1/${id}`]: reply }, auth)
    const e = await failure(http.request(id, {}, FundsSchema))
    expect(e).toMatchObject({
      ...expected,
      endpoint: id,
      status: reply === 'throw' ? 0 : reply.status,
    })
  })
})

describe('request', () => {
  test('POSTs to origin/api/v1/<path> with the key, JSON headers, the ngrok header and no cookies', async () => {
    const { http, fetch } = setup({
      'POST /api/v1/quotes': json(200, { status: 'success', data: {} }),
    })
    await http.request('quotes', { symbol: 'RELIANCE', exchange: 'NSE' }, z.unknown())
    expect(fetch.calls).toEqual([
      {
        method: 'POST',
        url: 'https://algo.example.com/api/v1/quotes',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'ngrok-skip-browser-warning': '1',
        },
        credentials: 'omit',
        body: { symbol: 'RELIANCE', exchange: 'NSE', apikey: KEY },
      },
    ])
  })

  test('a trailing slash on the origin is dropped', async () => {
    const fetch = scriptedFetch({ 'POST /api/v1/funds': json(200, funds) })
    const http = createHttpClient({
      origin: `${ORIGIN}/`,
      getKey: () => KEY,
      fetch,
      resolveAuth403: async () => 'key_invalid',
    })
    await http.request('funds', {}, FundsSchema)
    expect(fetch.calls[0]?.url).toBe('https://algo.example.com/api/v1/funds')
  })

  test('returns the schema output for a success', async () => {
    const { http } = setup({
      'POST /api/v1/funds': json(200, funds),
      'POST /api/v1/multiquotes': json(200, multiquotes),
    })
    expect((await http.request('funds', {}, FundsSchema)).availablecash).toBe(320.66)
    const quotes = await http.request('multiquotes', { symbols: [] }, MultiQuotesSchema)
    expect(quotes.map((q) => q.data?.ltp)).toEqual([1569.9, 3162.9, 1557.9])
  })

  test('an html endpoint hands its 200 html text to the schema', async () => {
    const page = '<html><body>tearsheet</body></html>'
    const { http } = setup({
      'POST /api/v1/portfolio/tearsheet': { status: 200, contentType: 'text/html', body: page },
    })
    expect(await http.request('portfolio/tearsheet', {}, z.string())).toBe(page)
  })

  test('resolveAuth403 runs only when the endpoint is not keyOnly', async () => {
    const { http, resolveAuth403 } = setup({
      'POST /api/v1/search': INVALID_KEY,
      'POST /api/v1/funds': INVALID_KEY,
    })
    expect((await failure(http.request('search', { query: 'NIFTY' }, z.unknown()))).kind).toBe(
      'KeyInvalid',
    )
    expect(resolveAuth403).not.toHaveBeenCalled()
    expect((await failure(http.request('funds', {}, FundsSchema))).kind).toBe('KeyInvalid')
    expect(resolveAuth403).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['Network', new ApiError({ kind: 'Network', status: 0, endpoint: 'search' })],
    ['Server', new ApiError({ kind: 'Server', status: 503, endpoint: 'search' })],
    ['a plain Error', new Error('boom')],
  ])(
    'a key check that fails with %s keeps the 403, so the read is never retried',
    async (_name, rejection) => {
      const { http, resolveAuth403 } = setup({ 'POST /api/v1/funds': INVALID_KEY })
      resolveAuth403.mockRejectedValueOnce(rejection)
      const e = await failure(http.request('funds', {}, FundsSchema))
      expect(e).toMatchObject({ kind: 'Server', status: 403, endpoint: 'funds' })
    },
  )

  test('a key check that hits a ban passes the ban on', async () => {
    const { http, resolveAuth403 } = setup({ 'POST /api/v1/funds': INVALID_KEY })
    const ban = new ApiError({ kind: 'IpBanned', status: 403, endpoint: 'search', banForm: 'text' })
    resolveAuth403.mockRejectedValueOnce(ban)
    expect(await failure(http.request('funds', {}, FundsSchema))).toBe(ban)
  })

  test('onResponse sees every response before classification', async () => {
    const { http, onResponse } = setup({
      'POST /api/v1/cancelorder': err(403, SEMI_AUTO),
      'POST /api/v1/funds': json(200, funds),
      'POST /api/v1/quotes': 'throw',
    })
    expect((await failure(http.request('cancelorder', {}, z.unknown()))).kind).toBe(
      'SemiAutoBlocked',
    )
    await http.request('funds', {}, FundsSchema)
    await failure(http.request('quotes', {}, z.unknown()))
    expect(onResponse.mock.calls).toMatchObject([
      [
        'cancelorder',
        {
          status: 403,
          contentType: 'application/json',
          text: JSON.stringify({ status: 'error', message: SEMI_AUTO }),
          json: { status: 'error', message: SEMI_AUTO },
        },
      ],
      ['funds', expect.objectContaining({ status: 200, json: funds })],
    ])
  })

  test('a getKey error rejects before any fetch', async () => {
    const fetch = scriptedFetch({ 'POST /api/v1/funds': json(200, funds) })
    const http = createHttpClient({
      origin: ORIGIN,
      getKey: () => {
        throw new Error('locked')
      },
      fetch,
      resolveAuth403: async () => 'key_invalid',
    })
    await expect(http.request('funds', {}, FundsSchema)).rejects.toThrow('locked')
    expect(fetch.calls).toHaveLength(0)
  })

  test('a GET-only endpoint is refused, since its key would go in the URL', async () => {
    const { http, fetch } = setup({})
    await expect(http.request('instruments', {}, z.unknown())).rejects.toThrow(/GET/)
    expect(fetch.calls).toHaveLength(0)
  })

  test('logs only id, status and ms, never the key or response values', async () => {
    const { http } = setup({
      'POST /api/v1/funds': json(200, funds),
      'POST /api/v1/depth': json(200, { status: 'success', data: { bids: 'SECRET-VALUE' } }),
      'POST /api/v1/quotes': 'throw',
      'POST /api/v1/ping': INVALID_KEY,
    })
    await http.request('funds', {}, FundsSchema)
    await failure(http.request('depth', {}, envelope(z.object({ bids: z.array(z.unknown()) }))))
    await failure(http.request('quotes', {}, z.unknown()))
    await failure(http.request('ping', {}, z.unknown()))
    await http.probe('ping').catch(() => {})
    const lines = getLogLines()
    expect(lines.find((l) => l.includes('[http] funds'))).toMatch(/\[http\] funds 200 \d+ms$/)
    expect(lines.find((l) => l.includes('[http] quotes'))).toMatch(/\[http\] quotes failed \d+ms$/)
    expect(lines.some((l) => /\[http\] depth schema mismatch at data\.bids$/.test(l))).toBe(true)
    const all = lines.join('\n')
    expect(all).not.toContain(KEY)
    expect(all).not.toContain('[redacted')
    expect(all).not.toContain('SECRET-VALUE')
  })
})

describe('get', () => {
  const CSV = 'exchange,symbol\nNSE,RELIANCE\n'
  const csv = (status = 200): ScriptedReply => ({ status, contentType: 'text/csv', body: CSV })

  test('a keyed GET puts the key in the query once and logs no URL', async () => {
    const { http, fetch } = setup({ 'GET /api/v1/instruments': csv() })
    await http.get('instruments', { exchange: 'NSE' }, z.string(), { withKey: true })
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]?.method).toBe('GET')
    expect(fetch.calls[0]?.url).toBe(`${ORIGIN}/api/v1/instruments?exchange=NSE&apikey=${KEY}`)
    expect(fetch.calls[0]?.body).toBeUndefined()
    const all = getLogLines().join('\n')
    expect(all).toMatch(/\[http\] instruments 200 \d+ms/)
    expect(all).not.toContain('apikey')
    expect(all).not.toContain(KEY)
    expect(all).not.toContain('exchange=NSE')
  })

  test('every get() sends Cache-Control: no-store so the key URL is not disk-cached', async () => {
    const { http, fetch } = setup({
      'GET /api/v1/instruments': csv(),
      'GET /api/v1/sip/frequencies': json(200, { status: 'success', data: [] }),
    })
    await http.get('instruments', {}, z.string(), { withKey: true })
    await http.get('sip/frequencies', {}, z.unknown())
    expect(fetch.calls[0]?.headers['cache-control']).toBe('no-store')
    expect(fetch.calls[1]?.headers['cache-control']).toBe('no-store')
  })

  test('a keyed GET with an empty query still sends the key', async () => {
    const { http, fetch } = setup({
      'GET /api/v1/portfolio/benchmarks': json(200, { status: 'success', data: [] }),
    })
    await http.get('portfolio/benchmarks', {}, z.unknown(), { withKey: true })
    expect(fetch.calls[0]?.url).toBe(`${ORIGIN}/api/v1/portfolio/benchmarks?apikey=${KEY}`)
  })

  test('a keyless GET sends no key; withKey on it throws; get on a POST endpoint throws', async () => {
    const { http, fetch } = setup({
      'GET /api/v1/sip/frequencies': json(200, { status: 'success', data: [] }),
    })
    await http.get('sip/frequencies', {}, z.unknown())
    expect(fetch.calls[0]?.url).toBe(`${ORIGIN}/api/v1/sip/frequencies`)
    await expect(http.get('sip/frequencies', {}, z.unknown(), { withKey: true })).rejects.toThrow(
      /no key/,
    )
    await expect(http.get('instruments', {}, z.string())).rejects.toThrow(/withKey/)
    await expect(http.get('funds', {}, z.unknown())).rejects.toThrow(/POST/)
    expect(fetch.calls).toHaveLength(1)
  })

  test('instruments returns the CSV text and waits 120 s', async () => {
    jest.useFakeTimers()
    try {
      const { http } = setup({
        'GET /api/v1/instruments': () =>
          new Promise<ScriptedReply>((resolve) => setTimeout(() => resolve(csv()), 100_000)),
      })
      const p = http.get('instruments', { exchange: 'NSE' }, z.string(), { withKey: true })
      await jest.advanceTimersByTimeAsync(100_000)
      await expect(p).resolves.toBe(CSV)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a text/plain 403 on instruments is Server and never retried', async () => {
    const { http, fetch, resolveAuth403 } = setup({
      'GET /api/v1/instruments': { status: 403, contentType: 'text/plain', body: 'Forbidden' },
    })
    const e = await failure(http.get('instruments', {}, z.string(), { withKey: true }))
    expect([e.kind, e.status]).toEqual(['Server', 403])
    expect(fetch.calls).toHaveLength(1)
    expect(resolveAuth403).not.toHaveBeenCalled()
  })

  test('a dropped GET is Network, and onResponse sees the date and elapsed time', async () => {
    const { http, onResponse } = setup({
      'GET /api/v1/instruments': { ...csv(), headers: { Date: 'Tue, 24 Nov 2026 04:00:00 GMT' } },
      'GET /api/v1/portfolio/benchmarks': 'throw',
    })
    expect(
      (await failure(http.get('portfolio/benchmarks', {}, z.unknown(), { withKey: true }))).kind,
    ).toBe('Network')
    await http.get('instruments', {}, z.string(), { withKey: true })
    const res = onResponse.mock.calls[0]?.[1]
    expect(res?.date).toBe('Tue, 24 Nov 2026 04:00:00 GMT')
    expect(typeof res?.elapsedMs).toBe('number')
  })
})

describe('timeouts', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())
  const hang: Route = () => new Promise<never>(() => {})

  function track(p: Promise<unknown>) {
    const state: { error?: unknown } = {}
    p.catch((e) => {
      state.error = e
    })
    return state
  }

  test('history times out at 30 s', async () => {
    const { http, fetch } = setup({ 'POST /api/v1/history': hang })
    const s = track(http.request('history', {}, z.unknown()))
    await jest.advanceTimersByTimeAsync(29_999)
    expect(s.error).toBeUndefined()
    await jest.advanceTimersByTimeAsync(1)
    expect(s.error).toMatchObject({ kind: 'Network', status: 0, endpoint: 'history' })
    expect(fetch.calls).toHaveLength(1)
  })

  test('a placeorder timeout gives MaybePlaced, and fetch is called exactly once', async () => {
    const { http, fetch } = setup({ 'POST /api/v1/placeorder': hang })
    const s = track(http.request('placeorder', {}, z.unknown()))
    await jest.advanceTimersByTimeAsync(15_000)
    expect(s.error).toMatchObject({ kind: 'MaybePlaced', endpoint: 'placeorder' })
    await jest.advanceTimersByTimeAsync(120_000)
    expect(fetch.calls).toHaveLength(1)
    expect(getLogLines().join('\n')).toMatch(/placeorder timeout \d+ms/)
  })

  test("the caller's signal aborts the request", async () => {
    const { http } = setup({ 'POST /api/v1/funds': hang })
    const ctrl = new AbortController()
    const s = track(http.request('funds', {}, FundsSchema, { signal: ctrl.signal }))
    ctrl.abort()
    await jest.advanceTimersByTimeAsync(0)
    expect(s.error).toMatchObject({ kind: 'Network', endpoint: 'funds' })
  })

  test('a finished request leaves no timer behind', async () => {
    const { http } = setup({ 'POST /api/v1/funds': json(200, funds) })
    await http.request('funds', {}, FundsSchema)
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('probe', () => {
  test('POSTs an empty JSON body with no key', async () => {
    const reply = err(400, { apikey: ['x'] })
    const { http, fetch, onResponse } = setup({ 'POST /api/v1/multioptiongreeks': reply })
    await http.probe('multioptiongreeks')
    expect(onResponse).toHaveBeenCalledWith(
      'multioptiongreeks',
      expect.objectContaining({ status: 400, json: reply.body }),
    )
    expect(fetch.calls).toEqual([
      {
        method: 'POST',
        url: 'https://algo.example.com/api/v1/multioptiongreeks',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'ngrok-skip-browser-warning': '1',
        },
        credentials: 'omit',
        body: {},
      },
    ])
  })

  test.each<[string, ScriptedReply | 'throw', 'present' | 'absent' | 'unknown']>([
    ['400 JSON', err(400, { apikey: ['Missing data for required field.'] }), 'present'],
    ['404 JSON', json(404, { status: 'error', message: 'Not found', path: '/api/v1/x' }), 'absent'],
    ['404 html', html(404), 'absent'],
    ['200 html', html(200), 'absent'],
    ['500 JSON', err(500, 'An unexpected error occurred'), 'unknown'],
    ['500 text/plain', { status: 500, body: 'An unexpected error occurred' }, 'unknown'],
    ['400 without a JSON status', json(400, { message: 'Bad request' }), 'unknown'],
    ['429', json(429, { message: '10 per 1 second' }), 'unknown'],
    ['fetch throws', 'throw', 'unknown'],
  ])('%s → %s', async (_name, reply, out) => {
    const { http } = setup({ 'POST /api/v1/sip/backtest': reply })
    expect(await http.probe('sip/backtest')).toBe(out)
  })

  test.each([
    ['text', BAN_TEXT],
    ['json', BAN_JSON],
  ])('a %s ban throws IpBanned', async (form, reply) => {
    const { http } = setup({ 'POST /api/v1/ping': reply })
    expect(await failure(http.probe('ping'))).toMatchObject({ kind: 'IpBanned', banForm: form })
  })
})

describe('getPublic', () => {
  test('GETs origin + path with no key and no content type, and returns the raw response', async () => {
    const body = { status: 'success', version: '2.0.3.5', name: 'OpenAlgo' }
    const { http, fetch } = setup({ 'GET /auth/app-info': json(200, body) })
    expect(await http.getPublic('/auth/app-info')).toMatchObject({
      status: 200,
      contentType: 'application/json',
      text: JSON.stringify(body),
      json: body,
    })
    expect(fetch.calls).toEqual([
      {
        method: 'GET',
        url: 'https://algo.example.com/auth/app-info',
        headers: { accept: 'application/json', 'ngrok-skip-browser-warning': '1' },
        credentials: 'omit',
        body: undefined,
      },
    ])
  })

  test('anything but a ban comes back raw, html included', async () => {
    const { http } = setup({ 'GET /api/v1/swagger.json': html(200) })
    const raw = await http.getPublic('/api/v1/swagger.json')
    expect(raw).toMatchObject({ status: 200, contentType: 'text/html; charset=utf-8' })
    expect(raw.json).toBeUndefined()
  })

  test('a fetch failure throws Network', async () => {
    const { http } = setup({ 'GET /auth/app-info': 'throw' })
    expect(await failure(http.getPublic('/auth/app-info'))).toMatchObject({
      kind: 'Network',
      status: 0,
      endpoint: '/auth/app-info',
    })
  })

  test.each([
    ['text', BAN_TEXT],
    ['json', BAN_JSON],
  ])('a %s ban throws IpBanned', async (form, reply) => {
    const { http } = setup({ 'GET /auth/app-info': reply })
    expect(await failure(http.getPublic('/auth/app-info'))).toMatchObject({
      kind: 'IpBanned',
      banForm: form,
    })
  })
})
