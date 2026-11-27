import { QueryClient } from '@tanstack/react-query'
import type { Api, KeyedApi } from '~/core/http/api'
import { ApiError, type ApiErrorKind } from '~/core/http/errors'
import { createServerClock } from '~/core/http/serverClock'
import { type DomRequest, type JSONValue, NATIVE_KEY } from '~/dom/bridge/protocol'
import { createSymbolMaster } from '~/market/master/master'
import { createMemoryMasterDb } from '~/market/master/memoryDb'
import { createOptionsData } from '~/market/options/data'
import { pyRound } from '~/market/options/pyRound'
import { DEFAULT_UNDERLYINGS } from '~/market/tools/registry'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { testRouteDeps } from '../../../test/helpers/routeDeps'
import { createDeviceRoutes, DEVICE_ROUTES } from './index'

// 10:30 IST on Friday 27 Nov 2026
const NOW = Date.UTC(2026, 10, 27, 5, 0)
const PID = 'p1'

const TOOL_PATHS = [
  '/oitracker/api/oi-data',
  '/oitracker/api/maxpain',
  '/ivsmile/api/iv-smile-data',
  '/gex/api/gex-data',
  '/gammadensity/api/gamma-data',
] as const
const QUERY = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '01DEC26' }

const leg = (symbol: string, o: Record<string, unknown> = {}) => ({
  symbol,
  label: '',
  ltp: 100,
  bid: 0,
  ask: 0,
  bid_qty: 0,
  ask_qty: 0,
  open: 0,
  high: 0,
  low: 0,
  prev_close: 0,
  volume: 0,
  oi: 0,
  lotsize: 65,
  tick_size: 0.05,
  ...o,
})
const chainReply = (chain: unknown[], o: Record<string, unknown> = {}) => ({
  status: 'success',
  underlying: 'NIFTY',
  underlying_ltp: 24010.5,
  underlying_prev_close: 23950,
  expiry_date: '01DEC26',
  atm_strike: 24000,
  chain,
  ...o,
})
const expiryReply = (data: string[]) => ({ status: 'success', data })
const searchRow = (symbol: string, exchange = 'NSE') => ({
  symbol,
  brsymbol: `${symbol}-EQ`,
  name: `${symbol} LTD`,
  exchange,
  brexchange: exchange,
  token: '2885',
  expiry: '',
  strike: -1,
  lotsize: 1,
  instrumenttype: 'EQ',
  tick_size: 0.05,
  freeze_qty: 1,
})

type Call = { id: string; body: Record<string, unknown> }
type Reply = (id: string, body: Record<string, unknown>) => unknown

let lastRid = 0
function request(
  method: 'GET' | 'POST',
  path: string,
  x: { query?: Record<string, string>; body?: JSONValue } = {},
): DomRequest {
  return { v: 1, kind: 'request', rid: ++lastRid, method, path, ...x }
}

function setup(reply: Reply = () => new Error('no reply')) {
  const calls: Call[] = []
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema) {
      calls.push({ id, body })
      const r = reply(id, body)
      if (r instanceof Error) throw r
      return schema.parse(r)
    },
  }
  const gets: string[] = []
  // A fresh install: the instruments CSV is still downloading.
  const keyed: Pick<KeyedApi, 'get'> = {
    get: (id) => {
      gets.push(id)
      return new Promise(() => {})
    },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const clock = createServerClock(() => NOW)
  const options = createOptionsData({ api, queryClient, pid: PID, clock })
  const master = createSymbolMaster({
    api: keyed,
    db: Promise.resolve(createMemoryMasterDb()),
    pid: PID,
    now: () => NOW,
  })
  const deps = testRouteDeps({ options, master, api, now: clock.now })
  const routes = createDeviceRoutes(deps)
  const send = (r: DomRequest) => {
    const route = routes.find((x) => x.method === r.method && x.path === r.path)
    if (!route) throw new Error(`no route ${r.method} ${r.path}`)
    return route.handle(r, new AbortController().signal)
  }
  const post = (path: string, body: JSONValue) => send(request('POST', path, { body }))
  const get = (path: string, query: Record<string, string>) => send(request('GET', path, { query }))
  return { calls, gets, send, post, get, queryClient, routes }
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((r) => setImmediate(r))

beforeEach(() => keepExpectedLogs())
afterEach(() => jest.restoreAllMocks())

test('the device routes are the nine session routes the tool pages call', () => {
  expect(DEVICE_ROUTES).toEqual([
    { method: 'GET', path: '/search/api/underlyings' },
    { method: 'GET', path: '/search/api/expiries' },
    { method: 'GET', path: '/search/api/search' },
    { method: 'GET', path: '/chartink/search' },
    ...TOOL_PATHS.map((path) => ({ method: 'POST', path })),
  ])
  const h = setup()
  expect(h.routes.map(({ method, path }) => ({ method, path }))).toEqual(DEVICE_ROUTES)
})

describe('a bad underlying, exchange or expiry is a 400 with the web message and sends nothing', () => {
  const REQUIRED = 'underlying, exchange, and expiry_date are required'
  const FORMAT = 'Invalid input format'
  const EXPIRY = 'Invalid expiry_date format. Expected DDMMMYY'
  const cases: [string, JSONValue | undefined, number, string][] = [
    ['no body', undefined, 400, REQUIRED],
    ['an empty body', {}, 400, REQUIRED],
    ['no expiry', { underlying: 'NIFTY', exchange: 'NFO' }, 400, REQUIRED],
    ['a blank underlying', { ...QUERY, underlying: '   ' }, 400, REQUIRED],
    ['a lower-case underlying', { ...QUERY, underlying: 'nifty' }, 400, FORMAT],
    ['M&M', { ...QUERY, underlying: 'M&M' }, 400, FORMAT],
    ['a hyphenated exchange', { ...QUERY, exchange: 'NSE-INDEX' }, 400, FORMAT],
    ['a dashed expiry', { ...QUERY, expiry_date: '01-DEC-26' }, 400, EXPIRY],
    ['an ISO date', { ...QUERY, expiry_date: '2026-12-01' }, 400, EXPIRY],
    // data.get("underlying", "").strip() raises on anything but a string: the route's 500
    ['a number', { ...QUERY, underlying: 123 }, 500, 'An error occurred processing your request'],
    ['a null', { ...QUERY, exchange: null }, 500, 'An error occurred processing your request'],
  ]

  test.each(TOOL_PATHS)('%s', async (path) => {
    const h = setup()
    for (const [label, body, status, message] of cases) {
      const r = await h.send(request('POST', path, body === undefined ? {} : { body }))
      expect([label, r]).toEqual([label, { status, body: { status: 'error', message } }])
    }
    expect(h.calls).toEqual([])
  })

  test('the web route trims and truncates first, and every other field is dropped', async () => {
    const h = setup(() => new ApiError({ kind: 'Server', status: 503, endpoint: 'optionchain' }))
    await h.post('/oitracker/api/oi-data', {
      underlying: ` ${'A'.repeat(25)} `,
      exchange: ' NFO ',
      expiry_date: '01DEC26',
      apikey: NATIVE_KEY,
      strike_count: 99,
    })
    expect(h.calls).toEqual([
      {
        id: 'optionchain',
        body: {
          underlying: 'A'.repeat(20),
          exchange: 'NFO',
          expiry_date: '01DEC26',
          strike_count: 23,
        },
      },
    ])
  })
})

test('oiData sends exactly optionchain {strike_count:23}, expiry futures and quotes', async () => {
  const h = setup((id) => {
    if (id === 'optionchain') {
      return chainReply([
        // a lot size of 0 is not a lot size: the next leg's is taken
        { strike: 23950, ce: leg('NIFTY01DEC2623950CE', { oi: 100, volume: 10, lotsize: 0 }) },
        {
          strike: 24000,
          ce: leg('NIFTY01DEC2624000CE', { oi: 300, volume: 30 }),
          pe: leg('NIFTY01DEC2624000PE', { oi: 250, volume: 45, lotsize: 75 }),
        },
        { strike: 24050, ce: null, pe: leg('NIFTY01DEC2624050PE', { oi: 200, volume: 25 }) },
      ])
    }
    if (id === 'expiry') return expiryReply(['29-DEC-26', '26-JAN-27'])
    if (id === 'quotes') return { status: 'success', data: { ltp: 24050.25 } }
    return new Error(`unexpected ${id}`)
  })
  const r = await h.post('/oitracker/api/oi-data', { ...QUERY, apikey: NATIVE_KEY })
  expect(h.calls).toEqual([
    { id: 'optionchain', body: { ...QUERY, strike_count: 23 } },
    { id: 'expiry', body: { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'futures' } },
    { id: 'quotes', body: { symbol: 'NIFTY29DEC26FUT', exchange: 'NFO' } },
  ])
  expect(r).toEqual({
    status: 200,
    body: {
      status: 'success',
      underlying: 'NIFTY',
      spot_price: 24010.5,
      futures_price: 24050.25,
      lot_size: 65,
      // 450 / 400 = 1.125 exactly: Python's round keeps the even digit
      pcr_oi: 1.12,
      pcr_volume: 1.75,
      total_ce_oi: 400,
      total_pe_oi: 450,
      atm_strike: 24000,
      expiry_date: '01DEC26',
      chain: [
        { strike: 23950, ce_oi: 100, pe_oi: 0 },
        { strike: 24000, ce_oi: 300, pe_oi: 250 },
        { strike: 24050, ce_oi: 0, pe_oi: 200 },
      ],
    },
  })
  h.queryClient.clear()
})

test('maxPain picks the first of equal minima', async () => {
  let rows: unknown[] = [
    // total pain 200.004 at 100 and 200.001 at 200: equal once rounded to 2 places, as
    // min() compares them, so the first strike wins
    { strike: 100, ce: leg('X01DEC26100CE', { oi: 2.00001 }), pe: leg('X01DEC26100PE') },
    { strike: 200, ce: leg('X01DEC26200CE'), pe: leg('X01DEC26200PE', { oi: 2.00004 }) },
    { strike: 300, ce: leg('X01DEC26300CE'), pe: leg('X01DEC26300PE') },
  ]
  const h = setup((id) => {
    if (id === 'optionchain') return chainReply(rows, { atm_strike: 200 })
    if (id === 'expiry') return expiryReply([])
    return new Error(`unexpected ${id}`)
  })
  const r = await h.post('/oitracker/api/maxpain', QUERY)
  expect(r).toEqual({
    status: 200,
    body: {
      status: 'success',
      underlying: 'NIFTY',
      spot_price: 24010.5,
      futures_price: null,
      atm_strike: 200,
      max_pain_strike: 100,
      lot_size: 65,
      pcr_oi: 1,
      pcr_volume: 0,
      expiry_date: '01DEC26',
      pain_data: [
        { strike: 100, ce_pain: 0, pe_pain: 200, total_pain: 200, total_pain_cr: 0 },
        { strike: 200, ce_pain: 200, pe_pain: 0, total_pain: 200, total_pain_cr: 0 },
        { strike: 300, ce_pain: 400, pe_pain: 0, total_pain: 400, total_pain_cr: 0 },
      ],
    },
  })
  // no futures listed: no quote is asked for
  expect(h.calls.map((c) => c.id)).toEqual(['optionchain', 'expiry'])

  rows = []
  expect(await h.post('/oitracker/api/maxpain', QUERY)).toEqual({
    status: 404,
    body: { status: 'error', message: 'No OI data available' },
  })
  h.queryClient.clear()
})

test('the IV Smile skew takes the earlier of two strikes as near to 5% out of the money', async () => {
  // ATM 100: the put side aims at 95, which 94 and 96 are as near to; the call side at 105
  const h = setup(() =>
    chainReply(
      [
        { strike: 94, ce: null, pe: leg('ABC01DEC2694PE', { ltp: 0.6 }) },
        { strike: 96, ce: null, pe: leg('ABC01DEC2696PE', { ltp: 1.1 }) },
        {
          strike: 100,
          ce: leg('ABC01DEC26100CE', { ltp: 2.4 }),
          pe: leg('ABC01DEC26100PE', { ltp: 2.3 }),
        },
        { strike: 104, ce: leg('ABC01DEC26104CE', { ltp: 1.2 }), pe: null },
        { strike: 106, ce: leg('ABC01DEC26106CE', { ltp: 0.7 }), pe: null },
      ],
      { underlying: 'ABC', underlying_ltp: 100, atm_strike: 100 },
    ),
  )
  const r = await h.post('/ivsmile/api/iv-smile-data', { ...QUERY, underlying: 'ABC' })
  const body = r.body as {
    skew: number
    atm_iv: number
    chain: { strike: number; ce_iv: number; pe_iv: number }[]
  }
  const at = (k: number) => body.chain.find((x) => x.strike === k)
  for (const k of [94, 96]) expect(at(k)?.pe_iv).toBeGreaterThan(0)
  for (const k of [104, 106]) expect(at(k)?.ce_iv).toBeGreaterThan(0)
  expect(body.skew).toBe(pyRound((at(94)?.pe_iv ?? 0) - (at(104)?.ce_iv ?? 0), 2))
  expect(body.skew).not.toBe(pyRound((at(96)?.pe_iv ?? 0) - (at(106)?.ce_iv ?? 0), 2))
  expect(body.atm_iv).toBe(pyRound(((at(100)?.ce_iv ?? 0) + (at(100)?.pe_iv ?? 0)) / 2, 2))
})

describe('Gamma Density without an ATM IV or an ATM forward', () => {
  const STRIKES: [number, number, number][] = [
    [23900, 180, 60],
    [23950, 140, 80],
    [24050, 75, 115],
    [24100, 50, 140],
  ]
  const ladder = (price: (ltp: number) => number) => [
    ...STRIKES.slice(0, 2).map(([k, c, p]) => ({
      strike: k,
      ce: leg(`NIFTY01DEC26${k}CE`, { ltp: price(c), oi: 1000 }),
      pe: leg(`NIFTY01DEC26${k}PE`, { ltp: price(p), oi: 1000 }),
    })),
    // the ATM row lacks its put, so F is the spot, and its call has no price, so no ATM IV
    { strike: 24000, ce: leg('NIFTY01DEC2624000CE', { ltp: 0, oi: 1000 }), pe: null },
    ...STRIKES.slice(2).map(([k, c, p]) => ({
      strike: k,
      ce: leg(`NIFTY01DEC26${k}CE`, { ltp: price(c), oi: 1000 }),
      pe: leg(`NIFTY01DEC26${k}PE`, { ltp: price(p), oi: 1000 }),
    })),
  ]
  type Body = { atm_iv: number; forward_price: number; chain: { iv: number | null }[] }

  test('the ATM IV is the median strike IV, sorted(...)[n // 2], at F = spot', async () => {
    const h = setup(() => chainReply(ladder((ltp) => ltp)))
    const r = await h.post('/gammadensity/api/gamma-data', QUERY)
    const body = r.body as Body
    expect(body.forward_price).toBe(24010.5)
    const ivs = body.chain.flatMap((x) => (x.iv === null ? [] : [x.iv])).sort((a, b) => a - b)
    expect(ivs).toHaveLength(4)
    // of four, the upper middle one
    expect(body.atm_iv).toBe(ivs[2])
    expect(body.atm_iv).not.toBe(ivs[1])
  })

  test('no strike IV at all: the 0.15 fallback', async () => {
    const h = setup(() => chainReply(ladder(() => 0)))
    const r = await h.post('/gammadensity/api/gamma-data', QUERY)
    expect((r.body as Body).atm_iv).toBe(15)
    expect((r.body as Body).chain.every((x) => x.iv === null)).toBe(true)
  })
})

test('the Gamma Density forward is the spot when an ATM leg has no ltp, and K + C − P when it is 0', async () => {
  const forward = async (ce: Record<string, unknown>, pe: Record<string, unknown>) => {
    const row = {
      strike: 24000,
      ce: leg('NIFTY01DEC2624000CE', { ltp: 120, oi: 1000, ...ce }),
      pe: leg('NIFTY01DEC2624000PE', { ltp: 95.5, oi: 1000, ...pe }),
    }
    const h = setup(() => chainReply([row]))
    const r = await h.post('/gammadensity/api/gamma-data', QUERY)
    expect(r.status).toBe(200)
    return (r.body as { forward_price: number }).forward_price
  }
  // a leg's ltp null (or not sent): synthetic_future_service.py:133-150 cannot price the forward,
  // so `forward or spot_price` (gamma_density_service.py:212) is the spot (conflict 24)
  expect(await forward({ ltp: null }, {})).toBe(24010.5)
  expect(await forward({}, { ltp: null })).toBe(24010.5)
  expect(await forward({}, { ltp: undefined })).toBe(24010.5)
  // 0 is a price, taken as given: K + C − 0
  expect(await forward({}, { ltp: 0 })).toBe(24120)
  expect(await forward({}, {})).toBe(24024.5)
})

describe('a chain error passes its status and message; no route ever answers 401', () => {
  test('a refused chain is the server reason with its status', async () => {
    const h = setup(
      () =>
        new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'optionchain',
          serverMessage: 'No strikes found for expiry 01DEC26',
        }),
    )
    for (const path of TOOL_PATHS) {
      expect(await h.post(path, QUERY)).toEqual({
        status: 400,
        body: { status: 'error', message: 'No strikes found for expiry 01DEC26' },
      })
    }
  })

  const KINDS: ApiErrorKind[] = [
    'KeyInvalid',
    'BrokerLoggedOut',
    'IpBanned',
    'Unsupported',
    'SemiAutoBlocked',
    'RateLimited',
    'Validation',
    'Server',
    'Network',
    'MaybePlaced',
  ]
  test.each(KINDS)('%s', async (kind) => {
    const h = setup((id) => new ApiError({ kind, status: 401, endpoint: id }))
    const replies = [
      ...(await Promise.all(TOOL_PATHS.map((path) => h.post(path, QUERY)))),
      await h.get('/search/api/expiries', { exchange: 'NFO', underlying: 'NIFTY' }),
      await h.get('/search/api/search', { q: 'REL', exchange: 'NSE' }),
      await h.get('/chartink/search', { q: 'REL', exchange: 'NSE' }),
    ]
    for (const r of replies) {
      expect(r.status).not.toBe(401)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.body).toMatchObject({ status: 'error', message: expect.any(String) })
    }
    h.queryClient.clear()
  })

  test('no spot price is the services’ own replies', async () => {
    const h = setup((id) =>
      id === 'expiry' ? expiryReply([]) : chainReply([], { underlying_ltp: 0 }),
    )
    const replies = await Promise.all(TOOL_PATHS.map((path) => h.post(path, QUERY)))
    expect(replies.map((r) => [r.status, (r.body as { message?: string }).message])).toEqual([
      // OI and Max Pain read no spot; Max Pain has no strikes to price
      [200, undefined],
      [404, 'No OI data available'],
      [500, 'Could not determine spot price'],
      [500, 'Could not determine spot price'],
      [404, 'Spot price or option chain unavailable'],
    ])
    h.queryClient.clear()
  })
})

test('underlyings answers at once from defaults on a fresh install', async () => {
  const h = setup()
  expect(await h.get('/search/api/underlyings', { exchange: 'NFO' })).toEqual({
    status: 200,
    body: { status: 'success', underlyings: [...(DEFAULT_UNDERLYINGS.NFO ?? [])] },
  })
  // it did not wait for the master, but started its download
  await settle()
  expect(h.gets).toEqual(['instruments'])
  expect(await h.get('/search/api/underlyings', { exchange: 'NSE' })).toEqual({
    status: 200,
    body: { status: 'success', underlyings: [] },
  })
  expect(h.calls).toEqual([])
})

test('expiries without instrumenttype asks for options', async () => {
  const h = setup((_id, body) =>
    expiryReply(body.instrumenttype === 'futures' ? ['29-DEC-26'] : ['01-DEC-26', '08-DEC-26']),
  )
  expect(await h.get('/search/api/expiries', { exchange: 'NFO', underlying: 'NIFTY' })).toEqual({
    status: 200,
    body: { status: 'success', expiries: ['01-DEC-26', '08-DEC-26'] },
  })
  expect(
    await h.get('/search/api/expiries', {
      exchange: 'NFO',
      underlying: 'NIFTY',
      instrumenttype: 'futures',
    }),
  ).toEqual({ status: 200, body: { status: 'success', expiries: ['29-DEC-26'] } })
  expect(h.calls).toEqual([
    { id: 'expiry', body: { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'options' } },
    { id: 'expiry', body: { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'futures' } },
  ])
  // no underlying yet: nothing to ask the server
  expect(await h.get('/search/api/expiries', { exchange: 'NFO' })).toEqual({
    status: 200,
    body: { status: 'success', expiries: [] },
  })
  expect(h.calls).toHaveLength(2)
  h.queryClient.clear()
})

test('the searches map /api/v1/search rows to the web shapes; an empty query sends nothing', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => searchRow(`REL${i}`))
  const h = setup(() => ({ status: 'success', message: 'Found 150', data: rows }))
  const hit = (i: number) => ({ symbol: `REL${i}`, name: `REL${i} LTD`, exchange: 'NSE' })
  const first100 = Array.from({ length: 100 }, (_, i) => hit(i))

  expect(await h.get('/chartink/search', { q: ' REL ', exchange: 'NSE' })).toEqual({
    status: 200,
    body: { results: first100 },
  })
  expect(await h.get('/search/api/search', { q: 'REL', exchange: 'NSE' })).toEqual({
    status: 200,
    body: { results: first100 },
  })
  expect(await h.get('/chartink/search', { q: 'REL' })).toEqual({
    status: 200,
    body: { results: first100 },
  })
  expect(h.calls).toEqual([
    { id: 'search', body: { query: 'REL', exchange: 'NSE' } },
    { id: 'search', body: { query: 'REL', exchange: 'NSE' } },
    { id: 'search', body: { query: 'REL' } },
  ])

  for (const path of ['/chartink/search', '/search/api/search']) {
    const empty: Record<string, string>[] = [{}, { q: '' }, { q: '   ', exchange: 'NSE' }]
    for (const query of empty) {
      expect(await h.get(path, query)).toEqual({ status: 200, body: { results: [] } })
    }
  }
  expect(h.calls).toHaveLength(3)
})

test('a route the page aborts rejects, so the router answers nothing', async () => {
  const h = setup(
    (id) => new ApiError({ kind: 'Network', status: 0, endpoint: id, serverMessage: 'aborted' }),
  )
  const route = h.routes.find((r) => r.path === '/gex/api/gex-data')
  const ctl = new AbortController()
  ctl.abort()
  await expect(
    route?.handle(request('POST', '/gex/api/gex-data', { body: QUERY }), ctl.signal),
  ).rejects.toBeInstanceOf(ApiError)
})
