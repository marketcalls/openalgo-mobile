// The tools' native side against the stock-server mock on every profile: the request budget table
// (design 12), the Option Chain's two reads, the symbol master's one download a day, and the
// gateway's allowlists, from the page's request down to what the mock saw. The gateway is built
// from useToolGateway's pieces (test/helpers/toolGateway.ts); no screen is rendered.
import { gate } from '~/core/capabilities/gates'
import { useConnection } from '~/core/services/connection'
import { TOOL_PAGE_IDS, type ToolPageId } from '~/dom/bridge/protocol'
import { REFUSED_COPY } from '~/dom/gateway/requests'
import { TOOL_ALLOWLIST } from '~/dom/gateway/toolAllowlist'
import { optionChainQuery } from '~/features/optionchain/model'
import { tileState } from '~/features/tools/model'
import { type App, apiCalls, makeApp, PROFILE_IDS, sleep, until } from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'
import { type ToolGateway, toolGateway } from '../helpers/toolGateway'

const mocks: MockServerProcess[] = []
const apps: App[] = []
afterEach(async () => {
  for (const a of apps.splice(0)) a.dispose()
  await Promise.all(mocks.splice(0).map((m) => m.stop()))
})

async function start(profile: string, page: ToolPageId = 'maxpain') {
  const mock = await startMockServerProcess({ PROFILE: profile })
  mocks.push(mock)
  const app = await makeApp(mock)
  apps.push(app)
  // the unlock's broker check has answered: the app's own cold-start calls are not in a window
  await until(() => useConnection.getState().brokerSession === 'active', 3000, 'broker checked')
  await sleep(300)
  return { mock, app, gw: toolGateway(app, page) }
}

const counts = async (mock: MockServerProcess) => apiCalls((await mock.stats()).requests)
const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(b)
      .map(([k, v]) => [k, v - (a[k] ?? 0)] as const)
      .filter(([, v]) => v > 0),
  )
const body = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(200)
  return r.body as Record<string, unknown>
}

/** What a page's first load asks of its routes: the pickers, then its own read. */
async function firstLoad(gw: ToolGateway, mock: MockServerProcess, path: string) {
  // the symbol master is warmed first: its instruments GET belongs to the next test
  await gw.trading.master.ensure('NFO')
  const before = await counts(mock)
  const underlyings = body(
    await gw.send('GET', '/search/api/underlyings', { query: { exchange: 'NFO' } }),
  )
  expect(underlyings.underlyings).toContain('NIFTY')
  const expiries = body(
    await gw.send('GET', '/search/api/expiries', {
      query: { exchange: 'NFO', underlying: 'NIFTY', instrumenttype: 'options' },
    }),
  ).expiries as string[]
  const first = (expiries[0] ?? '').replaceAll('-', '')
  expect(first).toMatch(/^\d{2}[A-Z]{3}\d{2}$/)
  const reply = body(
    await gw.send('POST', path, {
      body: { underlying: 'NIFTY', exchange: 'NFO', expiry_date: first },
    }),
  )
  expect(reply.status).toBe('success')
  return {
    calls: diff(before, await counts(mock)),
    query: { underlying: 'NIFTY', exchange: 'NFO', expiry_date: first },
  }
}

describe.each(PROFILE_IDS)('tools on %s', (profile) => {
  test.each([
    [
      'maxpain',
      '/oitracker/api/maxpain',
      { expiry: 2, optionchain: 1, quotes: 1 },
      { optionchain: 1, quotes: 1 },
    ],
    [
      'oitracker',
      '/oitracker/api/oi-data',
      { expiry: 2, optionchain: 1, quotes: 1 },
      { optionchain: 1, quotes: 1 },
    ],
    ['ivsmile', '/ivsmile/api/iv-smile-data', { expiry: 1, optionchain: 1 }, { optionchain: 1 }],
    [
      'gex',
      '/gex/api/gex-data',
      { expiry: 2, optionchain: 1, quotes: 1 },
      { optionchain: 1, quotes: 1 },
    ],
    [
      'gammadensity',
      '/gammadensity/api/gamma-data',
      { expiry: 1, optionchain: 1 },
      { optionchain: 1 },
    ],
  ] as const)('first loads cost the budget table: %s', async (page, path, first, refresh) => {
    const { mock, gw } = await start(profile, page)
    const load = await firstLoad(gw, mock, path)
    expect(load.calls).toEqual(first)
    // Max Pain, OI Tracker and GEX: 4 (expiry, chain, futures expiry, quote); IV Smile and Gamma Density: 2
    const total = Object.values(load.calls).reduce((a, b) => a + b, 0)
    expect(total).toBe(page === 'ivsmile' || page === 'gammadensity' ? 2 : 4)
    // a refresh: the lists are cached, so the chain (and the futures quote) alone
    const before = await counts(mock)
    expect((await gw.send('POST', path, { body: load.query })).status).toBe(200)
    expect(diff(before, await counts(mock))).toEqual(refresh)
  })

  test('Option Chain opens with expiry + optionchain; with_greeks is sent only from 2.0.2.0', async () => {
    const { mock, app, gw } = await start(profile)
    await gw.trading.master.ensure('NFO')
    const before = await counts(mock)
    const { options } = gw.trading
    const list = await app.queryClient.fetchQuery(options.expiriesQuery('NFO', 'NIFTY', 'options'))
    const caps = app.caps.get()
    const withGreeks = caps !== null && gate(caps, 'optionchainGreeks').on
    expect(withGreeks).toBe(profile === '2.0.2.0' || profile === '2.0.3.5')
    const chain = await app.queryClient.fetchQuery(
      optionChainQuery(options, app.profile.get().id, {
        target: { optionsExchange: 'NFO', underlying: 'NIFTY' },
        expiry: list[0] ?? '',
        count: 20,
        withGreeks,
      }),
    )
    expect(chain.chain.length).toBeGreaterThan(10)
    expect(diff(before, await counts(mock))).toEqual({ expiry: 1, optionchain: 1 })
    const sent = (await mock.stats()).lastBody.optionchain ?? {}
    expect('with_greeks' in sent).toBe(withGreeks)
  })

  test('the instruments CSV is fetched once per day for NFO and underlyings list NIFTY', async () => {
    const { mock, gw } = await start(profile)
    const { master } = gw.trading
    const before = await counts(mock)
    expect(await master.ensure('NFO')).toBe('today')
    expect(await master.ensure('NFO')).toBe('today')
    const { list, source } = await master.underlyingsNow('NFO')
    expect(source).toBe('today')
    expect(list).toEqual(expect.arrayContaining(['NIFTY', 'BANKNIFTY']))
    expect(diff(before, await counts(mock))).toEqual({ instruments: 1 })
  })

  test('every DOM request of each page outside its allowlist gets 403 and never reaches the mock', async () => {
    const { mock, app } = await start(profile)
    const everyone = [
      ...new Set(
        Object.values(TOOL_ALLOWLIST)
          .flat()
          .flatMap((r) => [
            `${r.method} ${r.path}`,
            `${r.method === 'GET' ? 'POST' : 'GET'} ${r.path}`,
          ]),
      ),
      'GET /api/v1/funds',
      'POST /api/v1/funds',
      'POST /api/v1/orderbook',
      'POST /api/v1/cancelallorder',
      'POST /api/v1/closeposition',
      'GET /auth/logout',
      'POST /auth/login',
      'GET /api/v1/instruments',
      'GET /strategy/api/list',
      'POST /api/strategy-portfolio',
    ]
    const before = await counts(mock)
    const fetchesBefore = app.fetchCalls()
    let refused = 0
    for (const page of TOOL_PAGE_IDS) {
      const gw = toolGateway(app, page)
      const own = new Set(TOOL_ALLOWLIST[page].map((r) => `${r.method} ${r.path}`))
      for (const id of everyone) {
        const [method, path] = id.split(' ') as ['GET' | 'POST', string]
        if (own.has(id) || path.startsWith('/auth/csrf')) continue
        // the startup answers and the held order writes are on every page, by design
        if (/^\/(auth\/(analyzer|csrf)|api\/(broker|websocket)|admin)/.test(path)) continue
        if (
          /^\/api\/v1\/(placeorder|placesmartorder|basketorder|optionsmultiorder|splitorder)$/.test(
            path,
          )
        )
          continue
        const r = await gw.send(method, path, method === 'POST' ? { body: {} } : {})
        expect({
          id,
          status: r.status,
          message: (r.body as { message?: string })?.message,
        }).toEqual({
          id,
          status: 403,
          message: REFUSED_COPY,
        })
        refused++
      }
    }
    expect(refused).toBeGreaterThan(100)
    expect(app.fetchCalls()).toBe(fetchesBefore)
    expect(diff(before, await counts(mock))).toEqual({})
  })
})

test('2.0.0.0: Portfolio Backtester is gated off; 2.0.3.5: benchmarks, backtest and tearsheet pass through', async () => {
  const old = await start('2.0.0.0', 'portfolio-backtester')
  const oldState = tileState('portfolio-backtester', old.app.caps.get())
  expect(oldState.kind).toBe('needs')
  expect(tileState('sip-backtester', old.app.caps.get()).kind).toBe('needs')
  expect(tileState('maxpain', old.app.caps.get()).kind).toBe('open')

  const { mock, app, gw } = await start('2.0.3.5', 'portfolio-backtester')
  expect(tileState('portfolio-backtester', app.caps.get()).kind).toBe('open')
  const before = await counts(mock)
  const bench = body(
    await gw.send('GET', '/api/v1/portfolio/benchmarks', { query: { apikey: '__native__' } }),
  )
  expect((bench.data as unknown[]).length).toBeGreaterThan(0)
  const req = {
    holdings: [{ symbol: 'NIFTYBEES', exchange: 'NSE', weight: 100 }],
    start_date: '2025-01-01',
    end_date: '2026-01-01',
  }
  const bt = body(
    await gw.send('POST', '/api/v1/portfolio/backtest', { body: { apikey: '__native__', ...req } }),
  )
  expect(bt.status).toBe('success')
  const ts = await gw.send('POST', '/api/v1/portfolio/tearsheet', {
    body: { apikey: '__native__', ...req },
  })
  expect(ts.status).toBe(200)
  expect(gw.saved).toHaveLength(1)
  expect(gw.saved[0]?.name).toBe('OpenAlgo-tearsheet-2025-01-01-to-2026-01-01.html')
  expect(diff(before, await counts(mock))).toEqual({
    'portfolio/benchmarks': 1,
    'portfolio/backtest': 1,
    'portfolio/tearsheet': 1,
  })
  // the page's placeholder never reached the wire as the key, and the key never reached the page
  const last = (await mock.stats()).lastBody['portfolio/backtest'] ?? {}
  expect('apikey' in last).toBe(false)
  expect(JSON.stringify(bt)).not.toContain('ab'.repeat(32))
})
