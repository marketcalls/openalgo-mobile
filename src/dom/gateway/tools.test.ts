import type { Capabilities } from '~/core/capabilities/gates'
import { gate } from '~/core/capabilities/gates'
import { createApi, type FieldGate, type KeyedApi } from '~/core/http/api'
import { createHttpClient } from '~/core/http/client'
import { ENDPOINTS } from '~/core/http/endpoints'
import { createScheduler } from '~/core/http/scheduler'
import { getLogLines } from '~/core/log/logger'
import {
  DOM_WS_URL,
  type DomReply,
  type DomRequest,
  type JSONValue,
  NATIVE_KEY,
  OPENED_IN_APP,
  TOOL_PAGE_IDS,
  type ToolPageId,
  type ToolSeed,
} from '~/dom/bridge/protocol'
import { DEVICE_ROUTES, type RouteDeps } from '~/dom/routes'
import { REQUIRED_COPY } from '~/dom/routes/query'
import { expiryInstantMs, optionsExchangeOf } from '~/market/options/expiry'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type Route as FetchRoute, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { type GoldenInput, goldenCases } from '../../../test/helpers/golden'
import { testRouteDeps } from '../../../test/helpers/routeDeps'
import {
  CANCELLED_COPY,
  createHeldWriteRoutes,
  createHeldWrites,
  type HeldWrites,
  MAX_HELD_WRITES,
  ONE_AT_A_TIME,
  ORDER_WRITE_ENDPOINTS,
  type OrderWriteEndpoint,
  TOOL_ORDERS_LATER,
} from './heldWrites'
import { createOptionChainRoute } from './optionChainRoute'
import { createRequestRouter, MAX_DOM_INFLIGHT, REFUSED_COPY, type Route } from './requests'
import { CSRF_REPLY, createStartupRoutes, TOGGLE_DENIED } from './startupRoutes'
import { MAX_PAGE_BODY, PassThroughSchema, TOOL_ALLOWLIST } from './toolAllowlist'
import { createToolRoutes, type SavedFile } from './toolRoutes'

const ORIGIN = 'https://algo.example.com'
const KEY = 'ab'.repeat(32)
// 10:30 IST on Friday 27 Nov 2026
const NOW = Date.UTC(2026, 10, 27, 5, 0)
const SEED: ToolSeed = {
  broker: 'zerodha',
  capabilities: {
    broker_name: 'zerodha',
    broker_type: 'IN_stock',
    supported_exchanges: ['NSE', 'NFO', 'BSE', 'BFO'],
    leverage_config: false,
  },
}
const REFUSED = { status: 403, body: { status: 'error', message: REFUSED_COPY } }
const error = (status: number, message: string): DomReply => ({
  status,
  body: { status: 'error', message },
})
const PLACED: DomReply = { status: 200, body: { status: 'success', orderid: '2611270001' } }
const ORDER = {
  apikey: NATIVE_KEY,
  strategy: 'Max Pain',
  symbol: 'NIFTY01DEC2624000CE',
  exchange: 'NFO',
  action: 'BUY',
  quantity: 65,
  pricetype: 'MARKET',
  product: 'NRML',
}
/** The capability store's gate, here passing every field: what the server refuses is not known. */
const ALL_FIELDS: FieldGate = { adapt: (_id, body) => body, markUnsupported: () => {} }

const caps = (version: string): Capabilities => ({
  host: ORIGIN,
  version,
  versionSource: 'app-info',
  endpoints: null,
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
  probedAt: 0,
})

let lastRid = 0
function request(
  method: 'GET' | 'POST',
  path: string,
  x: { query?: Record<string, string>; body?: JSONValue } = {},
): DomRequest {
  return { v: 1, kind: 'request', rid: ++lastRid, method, path, ...x }
}
const get = (path: string, query?: Record<string, string>) =>
  request('GET', path, query ? { query } : {})
const post = (path: string, body?: JSONValue) =>
  request('POST', path, body === undefined ? {} : { body })

/** The real Api, scheduler and HTTP client over a scripted server: what reaches the wire. */
function wire(routes: Record<string, FetchRoute>) {
  const fetch = scriptedFetch(routes)
  const http = createHttpClient({
    origin: ORIGIN,
    getKey: () => KEY,
    fetch,
    resolveAuth403: async () => 'key_invalid',
  })
  const api: KeyedApi = createApi({ http, scheduler: createScheduler(), fields: ALL_FIELDS })
  return { fetch, api }
}

/** The pickers answer from fakes; the tool POSTs read no chain in these tests. */
function deviceDeps(api: KeyedApi): RouteDeps {
  return testRouteDeps({
    options: { expiries: async () => ['01-DEC-26', '08-DEC-26'] },
    master: { underlyingsNow: async () => ({ list: ['BANKNIFTY', 'NIFTY'], source: 'defaults' }) },
    api,
    now: () => NOW,
  })
}

/** One tool screen's gateway as the tool screen composes it, over plan D's router. */
function gateway(
  page: ToolPageId,
  o: { server?: Record<string, FetchRoute>; held?: boolean; mode?: 'live' | 'analyze' } = {},
) {
  const { fetch, api } = wire(o.server ?? {})
  const call = jest.spyOn(api, 'call')
  const apiGet = jest.spyOn(api, 'get')
  const save = jest.fn(async (_f: SavedFile) => {})
  const analyzer = jest.fn(async () => o.mode ?? 'analyze')
  const onErrorReport = jest.fn()
  const held = createHeldWrites()
  const routes: Route[] = [
    ...createStartupRoutes({ seed: () => SEED, analyzer, onErrorReport }),
    ...createToolRoutes(page, { api, deps: deviceDeps(api), save }),
    ...(o.held === false
      ? []
      : createHeldWriteRoutes(held, page, { reviewable: new Set(['placeorder']) })),
  ]
  const router = createRequestRouter(routes)
  const ctl = new AbortController()
  const send = (r: DomRequest, signal: AbortSignal = ctl.signal) => router(r, signal)
  /** The requests that reached the server, as `METHOD path?query` with the body sent. */
  const sent = () =>
    fetch.calls.map((c) => ({ to: `${c.method} ${c.url.slice(ORIGIN.length)}`, body: c.body }))
  return { fetch, call, apiGet, save, analyzer, onErrorReport, held, send, sent, ctl }
}

/** A request's reply, or 'pending' while it has none after the queued callbacks ran. */
async function outcome(p: Promise<DomReply>): Promise<DomReply | 'pending'> {
  let out: DomReply | 'pending' = 'pending'
  void p.then((r) => {
    out = r
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  return out
}

beforeEach(() => keepExpectedLogs({ info: /\[http\] / }))
afterEach(() => jest.restoreAllMocks())

describe('startup calls', () => {
  test('the startup calls get their local answers and none reaches Api', async () => {
    const g = gateway('maxpain')
    const report = { message: 'TypeError at https://x/?apikey=abc', stack: 'secret-stack' }
    expect(await g.send(get('/auth/csrf-token'))).toEqual({ status: 200, body: CSRF_REPLY })
    expect(CSRF_REPLY).toEqual({ csrf_token: 'native' })
    expect(await g.send(get('/api/broker/capabilities'))).toEqual({
      status: 200,
      body: { status: 'success', data: SEED.capabilities },
    })
    expect(await g.send(get('/auth/analyzer-mode'))).toEqual({
      status: 200,
      body: { status: 'success', data: { mode: 'analyze', analyze_mode: true } },
    })
    expect(await g.send(get('/api/websocket/config'))).toEqual({
      status: 200,
      body: { status: 'success', websocket_url: DOM_WS_URL },
    })
    expect(await g.send(get('/api/websocket/apikey'))).toEqual({
      status: 200,
      body: { status: 'success', api_key: NATIVE_KEY },
    })
    expect(await g.send(post('/admin/api/errors/client', report))).toEqual({
      status: 204,
      body: null,
    })
    expect(await g.send(post('/admin/api/errors/client', report))).toEqual({
      status: 204,
      body: null,
    })
    // counted, never logged: nothing of the report reaches the app log
    expect(g.onErrorReport).toHaveBeenCalledTimes(2)
    expect(g.onErrorReport).toHaveBeenCalledWith()
    expect(getLogLines().filter((l) => /TypeError|secret-stack|errors\/client/.test(l))).toEqual([])
    expect(g.analyzer).toHaveBeenCalledTimes(1)
    expect(g.call).not.toHaveBeenCalled()
    expect(g.apiGet).not.toHaveBeenCalled()
    expect(g.sent()).toEqual([])
  })

  test('analyzer-mode reads the mode afresh: live is analyze_mode false', async () => {
    const g = gateway('gex', { mode: 'live' })
    const live = {
      status: 200,
      body: { status: 'success', data: { mode: 'live', analyze_mode: false } },
    }
    expect(await g.send(get('/auth/analyzer-mode'))).toEqual(live)
    expect(await g.send(get('/auth/analyzer-mode'))).toEqual(live)
    expect(g.analyzer).toHaveBeenCalledTimes(2)
  })

  test('analyzer-toggle and /auth/logout are refused with JSON 403, never 401', async () => {
    const g = gateway('ivsmile')
    expect(await g.send(post('/auth/analyzer-toggle'))).toEqual(error(403, TOGGLE_DENIED))
    expect(TOGGLE_DENIED).toBe("Switch LIVE or ANALYZE in the app's Account screen.")
    for (const r of [
      post('/auth/logout'),
      get('/auth/logout'),
      get('/auth/analyzer-toggle'),
      get('/auth/session-status'),
      post('/auth/csrf-token'),
      get('/admin/api/errors/client'),
    ]) {
      expect([r.method, r.path, await g.send(r)]).toEqual([r.method, r.path, REFUSED])
    }
    expect(g.analyzer).not.toHaveBeenCalled()
    expect(g.sent()).toEqual([])
  })
})

describe('allowlists', () => {
  test('maxpain allows its three routes and refuses /api/v1/placeorder… except through the held path', async () => {
    expect(TOOL_ALLOWLIST.maxpain).toEqual([
      { method: 'GET', path: '/search/api/underlyings', kind: 'device' },
      { method: 'GET', path: '/search/api/expiries', kind: 'device' },
      { method: 'POST', path: '/oitracker/api/maxpain', kind: 'device' },
    ])
    const g = gateway('maxpain', { held: false })
    expect(await g.send(get('/search/api/underlyings', { exchange: 'NFO' }))).toEqual({
      status: 200,
      body: { status: 'success', underlyings: ['BANKNIFTY', 'NIFTY'] },
    })
    expect(
      await g.send(
        get('/search/api/expiries', {
          exchange: 'NFO',
          underlying: 'NIFTY',
          instrumenttype: 'options',
        }),
      ),
    ).toEqual({ status: 200, body: { status: 'success', expiries: ['01-DEC-26', '08-DEC-26'] } })
    // the ported route answers it, with the web route's own check of the body
    expect(await g.send(post('/oitracker/api/maxpain', { apikey: NATIVE_KEY }))).toEqual(
      error(400, REQUIRED_COPY),
    )
    for (const r of [
      post('/api/v1/placeorder', ORDER),
      post('/oitracker/api/oi-data', { apikey: NATIVE_KEY }),
      post('/gex/api/gex-data', { apikey: NATIVE_KEY }),
      post('/api/v1/portfolio/backtest', { apikey: NATIVE_KEY }),
      get('/api/v1/portfolio/benchmarks', { apikey: NATIVE_KEY }),
      post('/api/v1/optionchain', { apikey: NATIVE_KEY }),
      post('/api/v1/orderbook', { apikey: NATIVE_KEY }),
      get('/chartink/search', { q: 'INF' }),
      get('/oitracker/api/maxpain'),
      post('/oitracker/api/maxpain/'),
      post('/OITRACKER/api/maxpain'),
    ]) {
      expect([r.method, r.path, await g.send(r)]).toEqual([r.method, r.path, REFUSED])
    }
    expect(g.sent()).toEqual([])

    // with the held path, as every tool screen has it, the same placeorder is held for review
    const h = gateway('maxpain')
    const p = h.send(post('/api/v1/placeorder', ORDER))
    expect(await outcome(p)).toBe('pending')
    expect(h.held.getState().current).toMatchObject({ endpoint: 'placeorder', page: 'maxpain' })
    h.held.cancelAll()
    expect(await p).toEqual(error(400, CANCELLED_COPY))
    expect(h.sent()).toEqual([])
  })

  test('every page builds its routes: device rows are the ported routes, the rest /api/v1 endpoints', () => {
    const device = new Set(DEVICE_ROUTES.map((r) => `${r.method} ${r.path}`))
    const writes = new Set(ORDER_WRITE_ENDPOINTS.map((e) => ENDPOINTS[e].path))
    for (const page of TOOL_PAGE_IDS) {
      const specs = TOOL_ALLOWLIST[page]
      const { api } = wire({})
      const routes = createToolRoutes(page, { api, deps: deviceDeps(api), save: async () => {} })
      expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
        specs.map((s) => `${s.method} ${s.path}`),
      )
      for (const s of specs) {
        expect([page, s.path, writes.has(s.path)]).toEqual([page, s.path, false])
        if (s.kind === 'device') expect(device.has(`${s.method} ${s.path}`)).toBe(true)
        else {
          const id = s.path.slice('/api/v1/'.length) as keyof typeof ENDPOINTS
          expect([s.path, ENDPOINTS[id]?.method]).toEqual([
            s.path,
            s.kind === 'lookup' ? 'GET' : 'POST',
          ])
        }
      }
    }
    expect(Object.keys(TOOL_ALLOWLIST).sort()).toEqual([...TOOL_PAGE_IDS].sort())
  })

  test('a row naming an endpoint off the read or history lane never builds (defence in depth)', () => {
    // a mistaken pass row for an order, a close or the analyzer switch would send it unreviewed
    const offLane = (Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]).filter(
      (id) => ENDPOINTS[id].lane !== 'read' && ENDPOINTS[id].lane !== 'history',
    )
    expect(offLane).toEqual(
      expect.arrayContaining(['optionsorder', 'closeposition', 'analyzer/toggle', 'cancelorder']),
    )
    const { api } = wire({})
    for (const id of offLane) {
      const { method, path } = ENDPOINTS[id]
      const kind = method === 'GET' ? 'lookup' : 'pass'
      jest.replaceProperty(TOOL_ALLOWLIST, 'gex', [{ method, path, kind }])
      expect(() =>
        createToolRoutes('gex', { api, deps: deviceDeps(api), save: async () => {} }),
      ).toThrow(/order write|lane/)
    }
    // the lanes a tool reads on still build
    jest.replaceProperty(TOOL_ALLOWLIST, 'gex', [
      { method: 'POST', path: '/api/v1/history', kind: 'pass' },
      { method: 'POST', path: '/api/v1/quotes', kind: 'pass' },
    ])
    expect(
      createToolRoutes('gex', { api, deps: deviceDeps(api), save: async () => {} }),
    ).toHaveLength(2)
  })

  test('the pass-through tools list their /api/v1 calls as the tool contract does', () => {
    const rows = (page: ToolPageId) =>
      TOOL_ALLOWLIST[page].map((s) => `${s.kind} ${s.method} ${s.path}`)
    expect(rows('portfolio-backtester')).toEqual([
      'lookup GET /api/v1/portfolio/benchmarks',
      'pass POST /api/v1/portfolio/backtest',
      'download POST /api/v1/portfolio/tearsheet',
      'device GET /chartink/search',
    ])
    expect(rows('sip-backtester')).toEqual([
      'lookup GET /api/v1/portfolio/benchmarks',
      'pass POST /api/v1/sip/backtest',
      'lookup GET /api/v1/sip/frequencies',
      'device GET /chartink/search',
    ])
    expect(rows('portfolio-analyzer')).toEqual(['pass POST /api/v1/portfolio/holdings'])
    expect(rows('sector-rotation')).toEqual([
      'lookup GET /api/v1/sectorrotation/options',
      'pass POST /api/v1/sectorrotation',
      'device GET /search/api/search',
    ])
  })
})

describe('pass-through, lookups and downloads', () => {
  test('a pass-through POST loses the placeholder key and returns the server body unchanged', async () => {
    const reply = {
      status: 'success',
      summary: { holdings: [], weights: { INFY: 0.5 }, invested: null, count: 0 },
      analysis: null,
      analysis_error: 'Not enough history',
      skipped: ['MCX:GOLD'],
      meta: { lookback_days: 365, basis: 'today' },
    }
    const g = gateway('portfolio-analyzer', {
      server: { 'POST /api/v1/portfolio/holdings': { status: 200, body: reply } },
    })
    const body = { apikey: NATIVE_KEY, lookback_days: 365, benchmark: 'NIFTY', source: 'api' }
    expect(await g.send(post('/api/v1/portfolio/holdings', body))).toEqual({
      status: 200,
      body: reply,
    })
    expect(g.sent()).toEqual([
      {
        to: 'POST /api/v1/portfolio/holdings',
        body: { lookback_days: 365, benchmark: 'NIFTY', source: 'api', apikey: KEY },
      },
    ])
    expect(g.call).toHaveBeenCalledWith(
      'portfolio/holdings',
      { lookback_days: 365, benchmark: 'NIFTY', source: 'api' },
      PassThroughSchema,
      { signal: g.ctl.signal },
    )
  })

  test("a pass-through refusal reaches the page as the server's message, never a 401", async () => {
    const g = gateway('sector-rotation', {
      server: {
        'POST /api/v1/sectorrotation': {
          status: 400,
          body: { status: 'error', message: 'Unknown benchmark' },
        },
      },
    })
    expect(
      await g.send(post('/api/v1/sectorrotation', { apikey: NATIVE_KEY, benchmark: 'X' })),
    ).toEqual(error(400, 'Unknown benchmark'))
  })

  test('a body that is not an object, or longer than 200,000 characters, is refused unsent', async () => {
    const g = gateway('portfolio-backtester')
    const long = { apikey: NATIVE_KEY, note: 'x'.repeat(MAX_PAGE_BODY) }
    expect(MAX_PAGE_BODY).toBe(200_000)
    for (const r of [
      post('/api/v1/portfolio/backtest'),
      post('/api/v1/portfolio/backtest', [1, 2]),
      post('/api/v1/portfolio/backtest', 'text'),
      post('/api/v1/portfolio/backtest', long),
      post('/api/v1/portfolio/tearsheet', long),
    ]) {
      expect(await g.send(r)).toEqual(REFUSED)
    }
    expect(g.sent()).toEqual([])
    expect(g.save).not.toHaveBeenCalled()
  })

  test('benchmarks goes as a keyed GET; sectorrotation/options as a keyless one', async () => {
    const benchmarks = {
      status: 'success',
      data: [{ symbol: 'NIFTY', exchange: 'NSE_INDEX', name: null }],
    }
    const rotation = { status: 'success', data: { benchmarks: [], timeframes: ['daily'] } }
    const frequencies = { status: 'success', data: [{ value: 'monthly', label: 'Monthly' }] }
    const server = {
      'GET /api/v1/portfolio/benchmarks': { status: 200, body: benchmarks },
      'GET /api/v1/sectorrotation/options': { status: 200, body: rotation },
      'GET /api/v1/sip/frequencies': { status: 200, body: frequencies },
    }
    const b = gateway('portfolio-backtester', { server })
    expect(await b.send(get('/api/v1/portfolio/benchmarks', { apikey: NATIVE_KEY }))).toEqual({
      status: 200,
      body: benchmarks,
    })
    // the real key, once and last; the page's placeholder never travels
    expect(b.sent()).toEqual([
      { to: `GET /api/v1/portfolio/benchmarks?apikey=${KEY}`, body: undefined },
    ])

    const s = gateway('sector-rotation', { server })
    expect(await s.send(get('/api/v1/sectorrotation/options'))).toEqual({
      status: 200,
      body: rotation,
    })
    expect(await s.send(get('/api/v1/sectorrotation/options', { apikey: NATIVE_KEY }))).toEqual({
      status: 200,
      body: rotation,
    })
    expect(s.sent().map((c) => c.to)).toEqual([
      'GET /api/v1/sectorrotation/options',
      'GET /api/v1/sectorrotation/options',
    ])

    const p = gateway('sip-backtester', { server })
    expect(await p.send(get('/api/v1/sip/frequencies'))).toEqual({
      status: 200,
      body: frequencies,
    })
    expect(p.sent().map((c) => c.to)).toEqual(['GET /api/v1/sip/frequencies'])
  })

  test('the tearsheet is fetched once, saved as HTML and the page gets OPENED_IN_APP', async () => {
    const html = '<!doctype html><html><body>tearsheet</body></html>'
    const g = gateway('portfolio-backtester', {
      server: {
        'POST /api/v1/portfolio/tearsheet': {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: html,
        },
      },
    })
    const req = { apikey: NATIVE_KEY, symbols: [{ symbol: 'INFY', exchange: 'NSE', weight: 1 }] }
    expect(await g.send(post('/api/v1/portfolio/tearsheet', req))).toEqual({
      status: 200,
      body: OPENED_IN_APP,
    })
    expect(g.sent()).toEqual([
      {
        to: 'POST /api/v1/portfolio/tearsheet',
        body: { symbols: req.symbols, apikey: KEY },
      },
    ])
    expect(g.save).toHaveBeenCalledTimes(1)
    expect(g.save).toHaveBeenCalledWith({
      name: 'portfolio-tearsheet.html',
      mime: 'text/html',
      text: html,
    })
  })

  test('a tearsheet the server refuses is not saved: the page gets the refusal', async () => {
    const g = gateway('portfolio-backtester', {
      server: {
        'POST /api/v1/portfolio/tearsheet': {
          status: 429,
          body: { status: 'error', message: 'Rate limit exceeded' },
        },
      },
    })
    const reply = await g.send(post('/api/v1/portfolio/tearsheet', { apikey: NATIVE_KEY }))
    expect(reply.status).toBe(429)
    expect(g.save).not.toHaveBeenCalled()
  })
})

describe('optionchain', () => {
  /** A chain reply as a 2.0.0.0 server sends it: no quote identity, instants, clock or Greeks. */
  function oldServerChain(input: GoldenInput): Record<string, unknown> {
    const key = Object.keys(input.responses).find(
      (k) => k.startsWith('optionchain ') && k.includes('"strike_count":25'),
    )
    if (!key) throw new Error(`golden ${input.case}: no chain 25`)
    const {
      underlying_symbol: _s,
      underlying_exchange: _e,
      expiry_ts: _x,
      server_ts: _t,
      quotes_included: _q,
      greeks_included: _g,
      forward_price: _f,
      ...rest
    } = structuredClone(input.responses[key]) as Record<string, unknown>
    return rest
  }

  function chainGateway(reply: unknown, o: { version: string; now: number }) {
    const { fetch, api } = wire({ 'POST /api/v1/optionchain': { status: 200, body: reply } })
    const route = createOptionChainRoute({
      api,
      greeksOnServer: () => gate(caps(o.version), 'optionchainGreeks').on,
      now: () => o.now,
    })
    const router = createRequestRouter([route])
    return {
      fetch,
      send: (body: JSONValue) =>
        router(post('/api/v1/optionchain', body), new AbortController().signal),
    }
  }

  type Leg = Record<string, unknown> | null
  type Row = { strike: number; ce: Leg; pe: Leg }
  const GREEKS = ['implied_volatility', 'delta', 'gamma', 'theta', 'vega'] as const
  const withoutGreeks = (leg: Leg) =>
    leg &&
    Object.fromEntries(
      Object.entries(leg).filter(([k]) => !(GREEKS as readonly string[]).includes(k)),
    )
  const greeksOf = (leg: Leg) =>
    leg && 'delta' in leg
      ? {
          iv: leg.implied_volatility,
          delta: leg.delta,
          gamma: leg.gamma,
          theta: leg.theta,
          vega: leg.vega,
        }
      : null

  test.each(goldenCases())(
    '$id: optionchain with_greeks on a 2.0.0.0 server: the field is not sent and the legs come back with the Greeks',
    async (c) => {
      const old = oldServerChain(c.input)
      const g = chainGateway(old, { version: '2.0.0.0', now: c.input.serverNowMs })
      const asked = {
        apikey: NATIVE_KEY,
        underlying: c.input.underlying,
        exchange: c.input.exchange,
        expiry_date: c.input.expiry,
        strike_count: 25,
        with_greeks: true,
        interest_rate: 0,
      }
      const reply = await g.send(asked)
      expect(g.fetch.calls.map((x) => x.body)).toEqual([
        {
          underlying: c.input.underlying,
          exchange: c.input.exchange,
          expiry_date: c.input.expiry,
          strike_count: 25,
          apikey: KEY,
        },
      ])
      expect(reply.status).toBe(200)
      const body = reply.body as Record<string, unknown> & { chain: Row[] }
      const expiryMs = expiryInstantMs(c.input.expiry, optionsExchangeOf(c.input.exchange))
      expect(body).toMatchObject({
        greeks_included: true,
        forward_price: c.expected.withGreeks.forward,
        expiry_ts: (expiryMs ?? 0) / 1000,
      })
      // what calculate_chain_greeks gave the same chain (scripts/golden/harness.py)
      expect(
        body.chain.map((r) => ({ strike: r.strike, ce: greeksOf(r.ce), pe: greeksOf(r.pe) })),
      ).toEqual(c.expected.withGreeks.rows)
      // every other field is the server's, as it was sent
      const sentRows = old.chain as Row[]
      expect(
        body.chain.map((r) => ({ ...r, ce: withoutGreeks(r.ce), pe: withoutGreeks(r.pe) })),
      ).toEqual(sentRows)
      expect(Object.keys(body).sort()).toEqual(
        [...Object.keys(old), 'greeks_included', 'forward_price', 'expiry_ts'].sort(),
      )
    },
  )

  test('a 2.0.3.5 server that priced the Greeks: with_greeks is sent and the reply passes unchanged', async () => {
    const [c] = goldenCases()
    if (!c) throw new Error('no golden case')
    const chain = { ...oldServerChain(c.input), greeks_included: true, forward_price: 1 }
    const g = chainGateway(chain, { version: '2.0.3.5', now: c.input.serverNowMs })
    const asked = {
      apikey: NATIVE_KEY,
      underlying: 'NIFTY',
      exchange: 'NFO',
      expiry_date: '01DEC26',
      strike_count: 25,
      with_greeks: true,
      interest_rate: 6.5,
    }
    expect(await g.send(asked)).toEqual({ status: 200, body: chain })
    const { apikey: _, ...rest } = asked
    expect(g.fetch.calls.map((x) => x.body)).toEqual([{ ...rest, apikey: KEY }])
  })

  test('a server that left greeks_included false gets them priced on the phone', async () => {
    const [c] = goldenCases()
    if (!c) throw new Error('no golden case')
    const chain = { ...oldServerChain(c.input), greeks_included: false, forward_price: null }
    const g = chainGateway(chain, { version: '2.0.3.5', now: c.input.serverNowMs })
    const reply = await g.send({
      underlying: c.input.underlying,
      exchange: c.input.exchange,
      expiry_date: c.input.expiry,
      strike_count: 25,
      with_greeks: true,
    })
    const body = reply.body as Record<string, unknown> & { chain: Row[] }
    expect(body.greeks_included).toBe(true)
    expect(body.forward_price).toBe(c.expected.withGreeks.forward)
    expect(body.chain.map((r) => greeksOf(r.ce))).toEqual(
      c.expected.withGreeks.rows.map((r) => r.ce),
    )
  })

  test("a server's own expiry_ts is kept, and is the instant the phone prices at", async () => {
    const [c] = goldenCases()
    if (!c) throw new Error('no golden case')
    const derivedMs = expiryInstantMs(c.input.expiry, optionsExchangeOf(c.input.exchange)) ?? 0
    // a server instant a day before the derived one, and a clock a minute past it
    const serverTs = derivedMs / 1000 - 86_400
    const old = oldServerChain(c.input)
    const chain = { ...old, expiry_ts: serverTs, greeks_included: false }
    const asked = {
      underlying: c.input.underlying,
      exchange: c.input.exchange,
      expiry_date: c.input.expiry,
      strike_count: 25,
      with_greeks: true,
    }
    const early = chainGateway(chain, { version: '2.0.3.5', now: serverTs * 1000 + 60_000 })
    const body = (await early.send(asked)).body as Record<string, unknown> & { chain: Row[] }
    expect(body.expiry_ts).toBe(serverTs)
    // past the server's instant, the chain has expired: no leg is priced
    expect(body.chain).toEqual(old.chain)
  })

  test('without with_greeks the reply passes unchanged; a leg with no ltp keeps the null', async () => {
    const chain = {
      status: 'success',
      underlying: 'NIFTY',
      underlying_ltp: 24010.5,
      expiry_date: '01DEC26',
      atm_strike: 24000,
      chain: [{ strike: 24000, ce: { symbol: 'NIFTY01DEC2624000CE', ltp: null }, pe: null }],
    }
    const g = chainGateway(chain, { version: '2.0.0.0', now: NOW })
    const asked = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '01DEC26', strike_count: 1 }
    expect(await g.send({ ...asked, apikey: NATIVE_KEY })).toEqual({ status: 200, body: chain })
    expect(g.fetch.calls.map((x) => x.body)).toEqual([{ ...asked, apikey: KEY }])

    // priced on the phone, the unpriced leg gets no Greeks and its ltp stays the server's null
    const p = chainGateway(chain, { version: '2.0.0.0', now: NOW })
    const reply = await p.send({ ...asked, with_greeks: true })
    expect(reply.body).toEqual({
      ...chain,
      expiry_ts: (expiryInstantMs('01DEC26', 'NFO') ?? 0) / 1000,
      greeks_included: true,
      forward_price: 24010.5,
    })
  })

  test('an expired chain (RF 1): greeks_included, the forward, and no leg priced', async () => {
    const [c] = goldenCases()
    if (!c) throw new Error('no golden case')
    const old = oldServerChain(c.input)
    const expiryMs = expiryInstantMs(c.input.expiry, optionsExchangeOf(c.input.exchange)) ?? 0
    const g = chainGateway(old, { version: '2.0.0.0', now: expiryMs + 60_000 })
    const reply = await g.send({
      underlying: c.input.underlying,
      exchange: c.input.exchange,
      expiry_date: c.input.expiry,
      strike_count: 25,
      with_greeks: true,
    })
    const body = reply.body as Record<string, unknown> & { chain: Row[] }
    expect(body).toMatchObject({
      greeks_included: true,
      forward_price: c.expected.withGreeks.forward,
      expiry_ts: expiryMs / 1000,
    })
    expect(body.chain).toEqual(old.chain)
  })

  test('a chain the Greeks cannot be read from is a 502, logged without its body', async () => {
    const g = chainGateway(
      { status: 'success', underlying: 'NIFTY', chain: 'none' },
      { version: '2.0.0.0', now: NOW },
    )
    const warned = expectLog('warn', /\[dom\] optionchain/)
    const reply = await g.send({
      underlying: 'NIFTY',
      exchange: 'NFO',
      expiry_date: '01DEC26',
      with_greeks: true,
    })
    expect(reply.status).toBe(502)
    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain('none')
  })

  test('a page with an optionchain row gets the route; with no gate given the phone prices the Greeks', async () => {
    const [c] = goldenCases()
    if (!c) throw new Error('no golden case')
    jest.replaceProperty(TOOL_ALLOWLIST, 'gex', [
      { method: 'POST', path: '/api/v1/optionchain', kind: 'optionchain' },
    ])
    const { fetch, api } = wire({
      'POST /api/v1/optionchain': { status: 200, body: oldServerChain(c.input) },
    })
    const deps = { ...deviceDeps(api), now: () => c.input.serverNowMs }
    const [route] = createToolRoutes('gex', { api, deps, save: async () => {} })
    if (!route) throw new Error('no route')
    const reply = await route.handle(
      post('/api/v1/optionchain', {
        underlying: c.input.underlying,
        exchange: c.input.exchange,
        expiry_date: c.input.expiry,
        strike_count: 25,
        with_greeks: true,
      }),
      new AbortController().signal,
    )
    expect(fetch.calls.map((x) => (x.body as Record<string, unknown>).with_greeks)).toEqual([
      undefined,
    ])
    expect((reply.body as Record<string, unknown>).forward_price).toBe(
      c.expected.withGreeks.forward,
    )
  })
})

describe('held order writes', () => {
  const holding = (page: ToolPageId = 'oitracker') => gateway(page)

  test('a held placeorder sends nothing until settle; the next waits its turn, first in, first out; cancelAll answers 400 CANCELLED_COPY', async () => {
    const g = holding()
    const first = g.send(post('/api/v1/placeorder', ORDER))
    expect(await outcome(first)).toBe('pending')
    const current = g.held.getState().current
    expect(current).toEqual({
      id: expect.any(Number),
      endpoint: 'placeorder',
      body: ORDER,
      page: 'oitracker',
    })
    if (!current) throw new Error('nothing held')
    expect(g.held.getState().waiting).toBe(0)

    // the second waits behind the first (T12-12): unanswered, not shown, counted
    const second = g.send(post('/api/v1/placeorder', { ...ORDER, quantity: 130 }))
    expect(await outcome(second)).toBe('pending')
    expect(g.held.getState()).toEqual({ current, waiting: 1 })
    // while it waits it can be neither begun nor settled: only the one on show can be sent
    expect(g.held.begin(current.id + 1)).toBe(false)
    g.held.settle(current.id + 1, PLACED)
    expect(await outcome(second)).toBe('pending')
    expect(g.held.getState()).toEqual({ current, waiting: 1 })

    g.held.settle(current.id, PLACED)
    expect(await first).toEqual(PLACED)
    // the first answered, the second is shown
    const next = g.held.getState().current
    expect(next).toEqual({
      id: current.id + 1,
      endpoint: 'placeorder',
      body: { ...ORDER, quantity: 130 },
      page: 'oitracker',
    })
    expect(g.held.getState().waiting).toBe(0)
    // the first write's id neither settles nor begins the second
    g.held.settle(current.id, PLACED)
    expect(g.held.begin(current.id)).toBe(false)
    expect(await outcome(second)).toBe('pending')
    expect(g.held.getState().current).toBe(next)
    g.held.cancelAll()
    expect(await second).toEqual(error(400, CANCELLED_COPY))
    expect(CANCELLED_COPY).toBe('Order cancelled in the app.')
    expect(g.held.getState().current).toBeNull()
    // an answered hold takes no later settle, and begins no send
    if (next) {
      g.held.settle(next.id, PLACED)
      expect(g.held.begin(next.id)).toBe(false)
    }
    expect(g.sent()).toEqual([])
    expect(g.call).not.toHaveBeenCalled()
  })

  test('a DOM abort before begin answers 400 CANCELLED_COPY and frees the hold', async () => {
    const g = holding()
    const ctl = new AbortController()
    const p = g.send(post('/api/v1/placeorder', ORDER), ctl.signal)
    expect(await outcome(p)).toBe('pending')
    const id = g.held.getState().current?.id ?? -1
    ctl.abort()
    expect(await p).toEqual(error(400, CANCELLED_COPY))
    expect(g.held.getState().current).toBeNull()
    expect(g.held.begin(id)).toBe(false)
    // the next order is held as usual
    const q = g.send(post('/api/v1/placeorder', ORDER))
    expect(await outcome(q)).toBe('pending')
    expect(g.held.getState().current).not.toBeNull()
    g.held.cancelAll()
    await q
    expect(g.sent()).toEqual([])

    // a request already given up on is never held
    const held = createHeldWrites()
    const [place] = createHeldWriteRoutes(held, 'oitracker', {
      reviewable: new Set(['placeorder']),
    })
    const gone = new AbortController()
    gone.abort()
    expect(await place?.handle(post('/api/v1/placeorder', ORDER), gone.signal)).toEqual(
      error(400, CANCELLED_COPY),
    )
    expect(held.getState().current).toBeNull()
  })

  test('after begin, cancelAll and a DOM abort answer nothing; the later settle reaches the page', async () => {
    const g = holding()
    const ctl = new AbortController()
    const p = g.send(post('/api/v1/placeorder', ORDER), ctl.signal)
    expect(await outcome(p)).toBe('pending')
    const held = g.held.getState().current
    if (!held) throw new Error('nothing held')
    expect(g.held.begin(held.id)).toBe(true)
    // a second order waits its turn behind the one sending
    const q = g.send(post('/api/v1/placeorder', ORDER))
    expect(await outcome(q)).toBe('pending')
    expect(g.held.getState()).toEqual({ current: held, waiting: 1 })
    g.held.cancelAll()
    ctl.abort()
    expect(await outcome(p)).toBe('pending')
    // the waiting one never began: it hears cancelled; the one sending is still held
    expect(await q).toEqual(error(400, CANCELLED_COPY))
    expect(g.held.getState()).toEqual({ current: held, waiting: 0 })
    g.held.settle(held.id, PLACED)
    expect(await p).toEqual(PLACED)
    expect(g.held.getState().current).toBeNull()
    expect(g.sent()).toEqual([])
  })

  test('a waiting write the page gives up on leaves the queue; the rest keep their order', async () => {
    const g = holding()
    const a = g.send(post('/api/v1/placeorder', ORDER))
    const gaveUp = new AbortController()
    const b = g.send(post('/api/v1/placeorder', { ...ORDER, quantity: 130 }), gaveUp.signal)
    const c = g.send(post('/api/v1/placeorder', { ...ORDER, quantity: 140 }))
    expect(await outcome(c)).toBe('pending')
    const shown = g.held.getState().current
    if (!shown) throw new Error('nothing held')
    expect(shown.body).toEqual(ORDER)
    expect(g.held.getState().waiting).toBe(2)
    gaveUp.abort()
    expect(await b).toEqual(error(400, CANCELLED_COPY))
    // the one on show is untouched
    expect(g.held.getState()).toEqual({ current: shown, waiting: 1 })
    expect(await outcome(a)).toBe('pending')
    // the one on show answered, the next still waiting is shown: the third, not the withdrawn second
    g.held.settle(shown.id, PLACED)
    expect(await a).toEqual(PLACED)
    expect(g.held.getState()).toEqual({
      current: {
        id: shown.id + 2,
        endpoint: 'placeorder',
        body: { ...ORDER, quantity: 140 },
        page: 'oitracker',
      },
      waiting: 0,
    })
    g.held.cancelAll()
    expect(await c).toEqual(error(400, CANCELLED_COPY))
    expect(g.held.getState()).toEqual({ current: null, waiting: 0 })
    expect(g.sent()).toEqual([])
  })

  test('at most MAX_HELD_WRITES are held, the one on show included: one more gets 409 ONE_AT_A_TIME', async () => {
    const g = holding()
    const held = Array.from({ length: MAX_HELD_WRITES }, (_, i) =>
      g.send(post('/api/v1/placeorder', { ...ORDER, quantity: 75 * (i + 1) })),
    )
    expect(await outcome(held[MAX_HELD_WRITES - 1] as Promise<DomReply>)).toBe('pending')
    expect(g.held.getState().waiting).toBe(MAX_HELD_WRITES - 1)
    expect(await g.send(post('/api/v1/placeorder', ORDER))).toEqual(error(409, ONE_AT_A_TIME))
    expect(g.held.getState().waiting).toBe(MAX_HELD_WRITES - 1)
    // half the page's request cap: its reads still go while its orders wait
    expect(MAX_HELD_WRITES).toBe(MAX_DOM_INFLIGHT / 2)
    expect(await g.send(get('/auth/csrf-token'))).toEqual({ status: 200, body: CSRF_REPLY })
    // leaving answers every one cancelled, the one on show and those waiting
    g.held.cancelAll()
    for (const p of held) expect(await p).toEqual(error(400, CANCELLED_COPY))
    expect(g.held.getState()).toEqual({ current: null, waiting: 0 })
    expect(g.sent()).toEqual([])
    expect(g.call).not.toHaveBeenCalled()
  })

  test.each(ORDER_WRITE_ENDPOINTS.filter((e) => e !== 'placeorder'))(
    '%s answers 501 TOOL_ORDERS_LATER and is never held or sent',
    async (endpoint) => {
      const g = holding('portfolio-analyzer')
      const seen = jest.fn()
      g.held.subscribe(seen)
      expect(await g.send(post(`/api/v1/${endpoint}`, ORDER))).toEqual(
        error(501, TOOL_ORDERS_LATER),
      )
      expect(TOOL_ORDERS_LATER).toBe("This tool's orders aren't supported in this build.")
      expect(seen).not.toHaveBeenCalled()
      expect(g.held.getState().current).toBeNull()
      expect(g.sent()).toEqual([])
    },
  )

  test('every order write is routed for every page, whatever its allowlist', async () => {
    for (const page of TOOL_PAGE_IDS) {
      const held = createHeldWrites()
      const routes = createHeldWriteRoutes(held, page, { reviewable: new Set(['placeorder']) })
      expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
        ORDER_WRITE_ENDPOINTS.map((e) => `POST /api/v1/${e}`),
      )
    }
    // F's baskets: a reviewable endpoint is held like placeorder
    const held: HeldWrites = createHeldWrites()
    const reviewable = new Set<OrderWriteEndpoint>(['placeorder', 'basketorder'])
    const router = createRequestRouter(createHeldWriteRoutes(held, 'gammadensity', { reviewable }))
    const p = router(
      post('/api/v1/basketorder', { apikey: NATIVE_KEY, orders: [] }),
      new AbortController().signal,
    )
    expect(await outcome(p)).toBe('pending')
    expect(held.getState().current).toMatchObject({ endpoint: 'basketorder', page: 'gammadensity' })
    held.cancelAll()
    expect(await p).toEqual(error(400, CANCELLED_COPY))
  })

  test('a write whose body is not an object is refused, never held', async () => {
    const g = holding()
    expect(await g.send(post('/api/v1/placeorder', [ORDER]))).toEqual(REFUSED)
    expect(await g.send(post('/api/v1/placeorder'))).toEqual(REFUSED)
    expect(g.held.getState().current).toBeNull()
    expect(ONE_AT_A_TIME).toBe('Another order from this tool is waiting for your review.')
  })
})
