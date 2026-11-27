// The chart's native side against the stock-server mock, on the oldest and the newest profile:
// its calendar and interval reads, the two-route gateway, and the socket emulation over the
// app's own feed, joined to the DOM runtime (T4 client, bridged fetch and socket, openalgo-charts'
// live feed) by an in-memory loop in place of the WebView.
import { OpenAlgoLiveDataFeed } from 'openalgo-charts'
import { createTickStore } from '~/core/realtime/tickStore'
import {
  DOM_ORIGIN,
  DOM_WS_URL,
  type DomReply,
  type DomToNative,
  type JSONValue,
  NATIVE_KEY,
} from '~/dom/bridge/protocol'
import { createChartFeeds } from '~/dom/chart/feeds'
import { createChartRoutes } from '~/dom/gateway/chartRoutes'
import { createRequestRouter } from '~/dom/gateway/requests'
import { createWsEmulation, type EmulationDeps } from '~/dom/gateway/wsEmulation'
import { createDomClient } from '~/dom/web/client'
import { createBridgedFetch } from '~/dom/web/fetch'
import { createBridgedSocketFactory } from '~/dom/web/socket'
import { inSession } from '~/market/chart/calendar'
import { chartIntervalsQuery, sessionCalendarsQuery } from '~/market/chart/queries'
import { type App, type AppOptions, apiCalls, makeApp, sleep, until } from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'

const ACCEPTED: DomReply = { status: 202, body: null }
// Thursday 2026-11-26: a weekday the mock's holiday fixture leaves alone.
const DAY = '2026-11-26'
const IST = 19_800_000
const at = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`) - IST
const BARS = { symbol: 'RELIANCE', exchange: 'NSE', interval: '5m' }

let mock: MockServerProcess | null = null
let app: App | null = null
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  app?.dispose()
  app = null
  await mock?.stop()
  mock = null
})

// A Thursday 10:00 IST, so the app's own polling gate is open however late the suite runs.
const T0 = Date.UTC(2026, 10, 26, 4, 30)
const marketClock = () => {
  const start = Date.now()
  return () => T0 + (Date.now() - start)
}

async function start(profile: string, env: Record<string, string> = {}, o: AppOptions = {}) {
  mock = await startMockServerProcess({ PROFILE: profile, ...env })
  app = await makeApp(mock, o)
  return { mock, app }
}

/** The page's runtime on the in-memory loop: its calls go to native's handlers, native's posts come back. */
function page(a: App, o: Partial<EmulationDeps> = {}) {
  const emulation = createWsEmulation({
    realtime: a.realtime,
    store: a.store,
    polling: a.polling,
    orderEvents: a.orderEvents,
    feedMode: () => (a.realtime.status().state === 'polling' ? 'polling' : 'live'),
    whenPolling: 'relay',
    active: () => true,
    post: (m) => queueMicrotask(() => client.deliver([m])),
    ...o,
  })
  const router = createRequestRouter(createChartRoutes(a.api))
  const bridge = async (m: JSONValue): Promise<JSONValue> => {
    const msg = m as DomToNative
    if (msg.kind === 'request') return (await router(msg, new AbortController().signal)) as never
    if (msg.kind === 'socket') {
      emulation.handle(msg)
      return ACCEPTED as never
    }
    return ACCEPTED as never
  }
  const client = createDomClient(bridge)
  const feeds = createChartFeeds(client)
  cleanups.push(() => {
    feeds.live.close()
    emulation.closeAll()
  })
  return { client, emulation, feeds }
}

describe.each(['2.0.0.0', '2.0.3.5'])('chart on %s', (profile) => {
  test('opening costs at most 5 native calls, and none the second time that day', async () => {
    const { mock, app } = await start(profile)
    const pid = app.profile.get().id
    const opening = async () => {
      await app.queryClient.fetchQuery(chartIntervalsQuery(app.api, pid))
      return app.queryClient.fetchQuery(sessionCalendarsQuery(app.api, pid, DAY))
    }
    const first = apiCalls((await mock.stats()).requests)
    const cal = await opening()
    expect(cal.source).toBe('server')
    const calls = Object.fromEntries(
      Object.entries(apiCalls((await mock.stats()).requests))
        .map(([k, v]) => [k, v - (first[k] ?? 0)] as const)
        .filter(([, v]) => v > 0),
    )
    // the instrument's own `symbol` call stays in the chart screen's budget test
    expect(calls.intervals).toBe(1)
    expect(calls['market/timings']).toBeLessThanOrEqual(1)
    expect(calls['market/holidays']).toBeLessThanOrEqual(2)
    // the app's own cold-start traffic may land in the window: count the chart's endpoints only
    const chart =
      (calls.intervals ?? 0) + (calls['market/timings'] ?? 0) + (calls['market/holidays'] ?? 0)
    expect(chart).toBeLessThanOrEqual(4)

    // the chart's own endpoints only: the app's other traffic is not under test here
    const chartCalls = async () => {
      const r = apiCalls((await mock.stats()).requests)
      return [r.intervals, r['market/timings'], r['market/holidays']]
    }
    const before = await chartCalls()
    await opening()
    expect(await chartCalls()).toEqual(before)
  })

  test('history through the gateway returns the mock bars; a placeorder path never reaches the server', async () => {
    const { mock, app } = await start(profile)
    const { client, feeds } = page(app)
    const to = Math.floor(Date.now() / 1000)
    const bars = await feeds.live.getBars({ ...BARS, from: to - 5 * 86_400, to })
    expect(bars.length).toBeGreaterThan(10)
    const times = bars.map((b) => b.time)
    expect(times).toEqual([...times].sort((x, y) => x - y))

    const res = await createBridgedFetch(client)(`${DOM_ORIGIN}/api/v1/placeorder`, {
      method: 'POST',
      body: JSON.stringify({ apikey: NATIVE_KEY, symbol: 'RELIANCE', exchange: 'NSE' }),
    })
    expect(res.status).toBe(403)
    const requests = (await mock.stats()).requests
    expect(requests.history).toBe(1)
    expect(requests.placeorder).toBeUndefined()
    expect(requests.placesmartorder).toBeUndefined()
  })

  test('the emulated socket gets Depth ticks over the real feed', async () => {
    const { app } = await start(profile)
    const { feeds } = page(app)
    const depths: unknown[] = []
    const stop = feeds.live.subscribeDepth(BARS, (d) => depths.push(d), { depthLevel: 5 })
    cleanups.push(stop)
    await until(() => depths.length > 0, 5000, 'a Depth tick')
    expect(JSON.stringify(depths[0])).toContain('bids')
    expect(app.realtime.confirmedDepth('NSE', 'RELIANCE')).toBe(5)
  })

  test('polling relay: with WS off, frames come from multiquotes', async () => {
    const { mock, app } = await start(
      profile,
      { WS_PORT: 'off' },
      {
        wsUrl: null,
        now: marketClock(),
      },
    )
    await until(() => app.realtime.status().state === 'polling', 5000, 'polling')
    // the session check is the screen's calendar; the test runs at any hour
    const { feeds } = page(app, { feedMode: () => 'polling', isOpen: () => true })
    const bars: number[] = []
    const stop = feeds.live.subscribeBars(BARS, (b) => bars.push(b.close))
    cleanups.push(stop)
    await until(() => bars.length > 0, 5000, 'a bar from a polled quote')
    expect((await mock.stats()).requests.multiquotes).toBeGreaterThan(0)
    expect((await mock.stats()).wsConnections).toBe(0)
  })

  test("a UTC server's timings are corrected to 09:15–15:30 IST", async () => {
    const { mock, app } = await start(profile)
    await mock.control({ timingsSkewMs: IST })
    const cal = await app.queryClient.fetchQuery(
      sessionCalendarsQuery(app.api, app.profile.get().id, DAY),
    )
    const nse = cal.calendars.NSE
    expect(nse?.sessions[0]).toMatch(/^0915-1530/)
    if (!nse) return
    expect(inSession(nse, at('09:14'))).toBe(false)
    expect(inSession(nse, at('09:15'))).toBe(true)
    expect(inSession(nse, at('15:29'))).toBe(true)
    expect(inSession(nse, at('15:30'))).toBe(false)
  })
})

test('2.0.3.5: a 1012 close is handled natively and the DOM socket keeps getting ticks', async () => {
  const { mock, app } = await start('2.0.3.5')
  const { client } = page(app)
  const socket = createBridgedSocketFactory(client)(DOM_WS_URL)
  let frames = 0
  let closed = false
  socket.onclose = () => {
    closed = true
  }
  socket.onmessage = (e) => {
    if ((JSON.parse(e.data as string) as { type?: string }).type === 'market_data') frames++
  }
  socket.onopen = () => {
    socket.send(JSON.stringify({ action: 'authenticate', api_key: NATIVE_KEY }))
    socket.send(
      JSON.stringify({
        action: 'subscribe',
        mode: 'Quote',
        symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }],
      }),
    )
  }
  await until(() => frames > 0, 5000, 'a first tick')

  await mock.control({ closeSockets: 1012 })
  await until(() => app.realtime.status().lastCloseCode === 1012, 5000, 'the 1012 close')
  await until(() => app.realtime.status().state === 'live', 8000, 'the feed live again')
  const seen = frames
  await until(() => frames > seen, 5000, 'a tick after the reconnect')
  expect(closed).toBe(false)
  expect(socket.readyState).toBe(1)
  expect((await mock.stats()).wsConnections).toBeGreaterThanOrEqual(2)
  socket.close()
  await sleep(0)
})

test('OpenAlgoLiveDataFeed gets live bars through the bridged socket', async () => {
  // The T4 client and socket against the emulation, over the app's tick store alone.
  const store = createTickStore((flush) => void setTimeout(flush, 16))
  const acquired: string[] = []
  const post = (m: Parameters<EmulationDeps['post']>[0]) =>
    queueMicrotask(() => client.deliver([m]))
  const emulation = createWsEmulation({
    realtime: {
      acquire: (r) => {
        acquired.push(`${r.exchange}:${r.symbol}:${r.mode}`)
        return () => {}
      },
      status: () => ({
        state: 'live',
        lastCloseCode: null,
        failures: 0,
        everLive: true,
        broker: 'zerodha',
      }),
      onStatus: () => () => {},
    },
    store,
    polling: { register: () => () => {} },
    orderEvents: { subscribe: () => () => {} },
    feedMode: () => 'live',
    whenPolling: 'relay',
    active: () => true,
    post,
  })
  const client = createDomClient(async (m) => {
    const msg = m as DomToNative
    if (msg.kind === 'socket') emulation.handle(msg)
    return ACCEPTED as never
  })
  // reset clears the store's eviction timers, which would hold the process for a minute
  cleanups.push(() => {
    emulation.closeAll()
    store.reset()
  })
  const feed = new OpenAlgoLiveDataFeed({
    baseUrl: DOM_ORIGIN,
    apiKey: NATIVE_KEY,
    wsUrl: DOM_WS_URL,
    fetchImpl: createBridgedFetch(client),
    socketFactory: createBridgedSocketFactory(client),
    timezone: 'Asia/Kolkata',
  })
  const closes: number[] = []
  const stop = feed.subscribeBars({ symbol: 'INFY', exchange: 'NSE', interval: '1m' }, (bar) =>
    closes.push(bar.close),
  )
  cleanups.push(stop)
  await until(() => acquired.includes('NSE:INFY:1'), 3000, 'the subscription')
  // a tick after the subscribe, as the app's feed would put it
  store.put('NSE:INFY', { ltp: 1500 }, 'ws')
  await until(() => closes.includes(1500), 3000, 'a bar closing at 1500')
  feed.close()
})
