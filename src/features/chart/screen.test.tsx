import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Alert, type AlertButton, Linking } from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import type { Capabilities } from '~/core/capabilities/gates'
import { usePrefs } from '~/core/config/prefs'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { qk } from '~/core/query/keys'
import { quoteKey } from '~/core/realtime/protocol'
import type { SubRequest } from '~/core/realtime/subscriptions'
import { LiveContext } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useConnection } from '~/core/services/connection'
import {
  type AppDeps,
  createServices,
  disposeServices,
  type Services,
  ServicesProvider,
} from '~/core/services/services'
import type { DomHostProps } from '~/dom/bridge/DomHost'
import {
  CHART_TOPICS,
  type ChartDomProps,
  type ChartInit,
  type ChartIntent,
  DOM_WS_URL,
  type DomEvent,
  type DomReply,
  type DomSocketMsg,
  type Inst,
  type JSONValue,
  type NativeToDom,
} from '~/dom/bridge/protocol'
import { DEFAULT_CALENDARS, DEFAULT_TIMINGS, IST_OFFSET_MS } from '~/market/chart/calendar'
import { FALLBACK_INTERVALS } from '~/market/chart/intervals'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { liveSurpriseText } from '~/market/orders/submit'
import { TradingProvider } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, PONG } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import ChartRoute from '../../app/(app)/chart/[key]'
import { WRONG_SYMBOL } from './hooks/useChartIntents'
import {
  CHART_READY_TIMEOUT_MS,
  ChartScreen,
  GONE_COPY,
  POLLING_NOTE,
  TIMEOUT_COPY,
} from './screens/ChartScreen'

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  dismissTo: jest.fn(),
  setParams: jest.fn(),
}
let mockParams: Record<string, string> = {}
/** Whether the chart is the screen in front; a ticket or a sheet over it takes the focus. */
const mockFocus = { on: true, subs: new Set<() => void>() }
jest.mock('expo-router', () => {
  const { useEffect, useSyncExternalStore } = require('react')
  const useIsFocused = (): boolean =>
    useSyncExternalStore(
      (fn: () => void) => {
        mockFocus.subs.add(fn)
        return () => mockFocus.subs.delete(fn)
      },
      () => mockFocus.on,
    )
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    useIsFocused,
    // as React Navigation runs it: at each focus, cleaned up at the blur
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const on = useIsFocused()
      useEffect(() => (on ? effect() : undefined), [on, effect])
    },
  }
})
// Focused and in the foreground: the test's focus (jest's AppState is never 'active').
jest.mock('~/core/realtime/useScreenActive', () => ({
  useScreenActive: () => require('expo-router').useIsFocused(),
}))
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}))

/**
 * A DOM host that records what the screen gives it, as the real one would see it: each mount
 * (a new `key`) is a new page with its own number. The page itself is played by the test.
 */
type Host = DomHostProps<ChartDomProps> & { n: number }
const mockDom: { mounts: number; host: Host | null } = { mounts: 0, host: null }
jest.mock('~/dom/bridge/DomHost', () => {
  const { createElement, useEffect, useState } = require('react')
  const { View } = require('react-native')
  return {
    ...jest.requireActual('~/dom/bridge/DomHost'),
    DomHost: (p: DomHostProps<ChartDomProps>) => {
      const [n] = useState(() => ++mockDom.mounts)
      mockDom.host = { ...p, n }
      useEffect(
        () => () => {
          // the real host stops delivering when it goes
          p.outbox.detach()
          if (mockDom.host?.n === n) mockDom.host = null
        },
        [n],
      )
      return createElement(View, { testID: p.testID })
    },
  }
})
// The page's own code runs in the dom project; here it is never loaded.
jest.mock('~/dom/chart/ChartDom', () => ({ __esModule: true, default: () => null }))

const ORIGIN = 'https://algo.example.com'
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
// A Tuesday, 09:30 IST: NSE is open.
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const DAY = '2026-11-24'

const PROFILE: ServerProfile = {
  id: PID,
  restOrigin: ORIGIN,
  wsUrl: 'wss://algo.example.com/ws',
  feedMode: 'live',
  httpWarningAcked: false,
  serverVersion: '2.0.3.5',
  broker: 'zerodha',
  createdAt: T0,
  lastFeedRetryAt: null,
}

const CAPS: Capabilities = {
  host: ORIGIN,
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: null,
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: T0,
}

const meta = (symbol: string, o: Partial<InstrumentMeta> = {}): InstrumentMeta => ({
  exchange: 'NSE',
  symbol,
  name: `${symbol} LTD`,
  lotsize: 1,
  tick: 0.05,
  freezeQty: 0,
  instrumenttype: 'EQ',
  expiry: null,
  strike: null,
  quoteOnly: false,
  lots: false,
  ...o,
})
const RELIANCE: Inst = { exchange: 'NSE', symbol: 'RELIANCE' }
const INFY: Inst = { exchange: 'NSE', symbol: 'INFY' }
/** Not in today's instrument cache: its metadata needs a `/symbol` read. */
const TCS: Inst = { exchange: 'NSE', symbol: 'TCS' }
/** An expired contract, marked unknown in today's cache. */
const GONE: Inst = { exchange: 'NFO', symbol: 'NIFTY28OCT26FUT' }
const RELIANCE_META = { exchange: 'NSE', symbol: 'RELIANCE', tick: 0.05, lotsize: 1 }

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const success = (data: unknown) => ok({ status: 'success', data })
const analyzer = (mode: 'live' | 'analyze') =>
  success({ mode, analyze_mode: mode === 'analyze', total_logs: 0 })

/** An orderbook row as the stock server sends it. */
const order = (o: Record<string, unknown> = {}) => ({
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid: 'A1',
  product: 'CNC',
  quantity: '1',
  price: 1390,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '24-Nov-2026 09:30:00',
  ...o,
})
const book = (rows: unknown[]) => success({ orders: rows, statistics: {} })
const position = (o: Record<string, unknown> = {}) => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  product: 'CNC',
  quantity: '10',
  average_price: '1398.5',
  ...o,
})

const midnight = (d: string) => Date.parse(`${d}T00:00:00Z`) - IST_OFFSET_MS
/** The server's own hours for a day (an IST server), every exchange at its defaults. */
const timings = (d: string) =>
  DEFAULT_TIMINGS.map((r) => ({
    exchange: r.exchange,
    start_time: midnight(d) + r.start_offset,
    end_time: midnight(d) + r.end_offset,
  }))
/** This year's one holiday: what tells the server's calendar from the defaults. */
const CHRISTMAS = {
  date: '2026-12-25',
  holiday_type: 'TRADING_HOLIDAY',
  closed_exchanges: ['NSE', 'BSE', 'NFO'],
  open_exchanges: [],
}
const INTERVALS = { seconds: ['5s'], minutes: ['1m', '3m', '60m'], hours: ['1h'], days: ['D'] }
const CANDLE = { timestamp: 1764000000, open: 1400, high: 1402, low: 1399, close: 1401, volume: 9 }

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([]),
  'POST /api/v1/positionbook': success([]),
  'POST /api/v1/tradebook': success([]),
  'POST /api/v1/intervals': success(INTERVALS),
  'POST /api/v1/market/holidays': (req) =>
    success((req.body as { year: number }).year === 2026 ? [CHRISTMAS] : []),
  'POST /api/v1/market/timings': (req) =>
    success(timings(String((req.body as { date: string }).date))),
  'POST /api/v1/history': success([CANDLE]),
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
let sockets = fakeSockets()
let view: { rerender: (el: ReactElement) => Promise<unknown>; unmount: () => unknown } | null = null
/** What every page was sent, in order, since it loaded. */
let delivered: NativeToDom[] = []
/** The app-feed holds the page made, by mode: LTP (1) and depth (3); the header's quote is mode 2. */
const holds = { 1: 0, 2: 0, 3: 0 }

/** The real container over a scripted server; today's instrument cache knows RELIANCE and INFY. */
async function setup(
  routes: Record<string, Route> = {},
  o: { live?: boolean; feedMode?: 'live' | 'polling' } = {},
) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  sockets = fakeSockets()
  // a polling profile that just tried the live feed: no retry during the test (B8)
  const profile: ServerProfile =
    o.feedMode === 'polling' ? { ...PROFILE, feedMode: 'polling', lastFeedRetryAt: T0 } : PROFILE
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
    [`oa.${PID}.instruments`]: JSON.stringify({
      day: DAY,
      items: [meta('RELIANCE'), meta('INFY')],
      unknown: [{ k: `${GONE.exchange}:${GONE.symbol}`, at: T0 }],
    }),
  })
  await createProfileRepo(kv).save(profile)
  const deps: AppDeps = {
    fetch: fetchFake,
    WebSocketImpl: sockets.WebSocketImpl,
    secureKV: memoryKV({ [`oa.${PID}.apikey`]: KEY }),
    kv,
    now: () => Date.now(),
    uuid: () => 'u',
    allowDevHosts: false,
    lock: {
      settings: () => ({ enabled: false, lockAfterMs: 60_000 }),
      authenticate: async () => true,
      available: async () => true,
      confirm: async () => 'ok',
    },
  }
  const s = createServices(profile, deps)
  services = s
  const acquire = s.realtime.acquire.bind(s.realtime)
  jest.spyOn(s.realtime, 'acquire').mockImplementation((r: SubRequest) => {
    const release = acquire(r)
    holds[r.mode]++
    let done = false
    return () => {
      if (done) return
      done = true
      holds[r.mode]--
      release()
    }
  })
  await s.caps.load()
  await s.lock.unlock()
  // the unlock's own book refresh (a 500 ms debounce) goes before the chart opens
  await pass(600)
  if (o.live) {
    sockets.last().serverOpen()
    sockets.last().serverSend(AUTH_OK)
    await pass(0)
  }
  // the header's badge, which the tabs layout's useAnalyzer writes once it has read the mode
  useConnection.getState().set({ analyzer: 'live' })
  return s
}

/** The device's safe area: none unless a test sets it. */
let insets = { top: 0, bottom: 0, left: 0, right: 0 }
const tree = (s: Services, node: ReactElement | null) => (
  <SafeAreaInsetsContext.Provider value={insets}>
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={s.queryClient}>
          <TickStoreContext.Provider value={s.store}>
            <LiveContext.Provider
              value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
            >
              {node}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  </SafeAreaInsetsContext.Provider>
)

/** The app's shell first (its instrument cache loads), then the chart pushed over it. */
async function open(node: ReactElement = <ChartScreen initial={RELIANCE} />) {
  if (!services) throw new Error('setup first')
  view = await render(tree(services, null))
  await pass(10)
  await view.rerender(tree(services, node))
  await pass(10)
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

/**
 * A reply or a timer lands, and what it makes the screen push reaches the page: React runs its
 * effects as the act ends, and the outbox delivers on the next frame.
 */
async function settle() {
  await pass(20)
  await pass(20)
}

/** The app's pings the fake server has answered. */
let answered = 0
/** `ms` with the live feed answering each of the app's pings. */
async function passLive(ms: number) {
  const s = sockets.last()
  for (let t = 0; t < ms; t += 1_000) {
    await pass(1_000)
    const pings = s.actions().filter((a) => a === 'ping').length
    for (; answered < pings; answered++) s.serverSend(PONG)
  }
}

const host = (): Host => {
  const h = mockDom.host
  if (!h) throw new Error('no DOM host is mounted')
  return h
}

/** The page loads: its host takes the outbox (DomHost does on 'loaded'), then says so. */
async function load() {
  const h = host()
  delivered = []
  h.outbox.attach((batch) => {
    delivered.push(...batch)
    return true
  })
  await event({ name: 'loaded' })
}

type EventBody = DomEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'v' | 'kind'>
    : never
  : never
async function event(e: EventBody) {
  await act(async () => host().handlers.event?.({ v: 1, kind: 'event', ...e } as DomEvent))
  await pass(20)
}
/** The widget has painted its first load; the screen logs the open time. */
async function ready(bars = 120) {
  const opened = expectLog('info', /\[chart\] open \d+ ms, bars \d+, csp (on|off)$/)
  await event({ name: 'ready', info: { bars, indicators: 112, mobile: true, csp: true } })
  return opened
}
/** The OS killed the page's render process: the host detaches, then says so. */
async function gone() {
  const h = host()
  h.outbox.detach()
  await act(async () => h.onGone())
  await pass(20)
}

/** The page sends an intent. A book it reads may wait for the client's next token (5/s). */
async function intent(i: ChartIntent) {
  await act(async () => host().handlers.intent?.({ v: 1, kind: 'intent', intent: i }))
  await pass(250)
}

type SocketBody = DomSocketMsg extends infer M
  ? M extends unknown
    ? Omit<M, 'v' | 'kind' | 'sid'>
    : never
  : never
async function sock(sid: number, m: SocketBody) {
  await act(async () =>
    host().handlers.socket?.({ v: 1, kind: 'socket', sid, ...m } as DomSocketMsg),
  )
  await pass(20)
}
const send = (sid: number, frame: object) => sock(sid, { op: 'send', data: JSON.stringify(frame) })
/** A page socket that is open, authenticated and subscribed to RELIANCE's LTP (and depth). */
async function subscribed(sid: number, modes: (1 | 3)[] = [1]) {
  await sock(sid, { op: 'open', url: DOM_WS_URL })
  await send(sid, { action: 'authenticate', api_key: '__native__' })
  for (const mode of modes) {
    await send(sid, { action: 'subscribe', symbols: [RELIANCE], mode })
  }
}

/** A page request, answered or not yet. */
function request(rid: number, path: string, body: JSONValue) {
  const out: { reply: DomReply | null } = { reply: null }
  const ctl = new AbortController()
  void host()
    .handlers.request?.({ v: 1, kind: 'request', rid, method: 'POST', path, body }, ctl.signal)
    .then((r) => {
      out.reply = r
    })
  return out
}

const pushes = (topic: string) =>
  delivered.flatMap((m) => (m.kind === 'push' && m.topic === topic ? [m.payload] : []))
const socketEvents = (sid: number) =>
  delivered.flatMap((m) => (m.kind === 'socket' && m.sid === sid ? [m] : []))

/** The market_data frames a page socket was sent. */
const marketData = (sid: number) =>
  socketEvents(sid).flatMap((m) => {
    if (m.event !== 'message') return []
    const f = JSON.parse(m.data) as { type?: string; data?: unknown }
    return f.type === 'market_data' ? [f.data] : []
  })
/** The server's multiquotes with RELIANCE at `ltp`. */
const quoted = (ltp: number) =>
  ok({ status: 'success', results: [{ symbol: 'RELIANCE', exchange: 'NSE', data: { ltp } }] })

const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(20)
}
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
const text = (id: string) => textOf(screen.getByTestId(id))
async function setFocus(on: boolean) {
  await act(async () => {
    mockFocus.on = on
    for (const fn of Array.from(mockFocus.subs)) fn()
  })
  await pass(20)
}
/** A promise the test settles: a route that is still out until then. */
function gate() {
  let open: (r: ScriptedReply) => void = () => {}
  const promise = new Promise<ScriptedReply>((resolve) => {
    open = resolve
  })
  return { route: () => promise, open }
}

/**
 * The log lines every test here makes over the real services container: the http client's line
 * for each request, and the feed's over the fake socket.
 */
const HARNESS_LOGS = {
  info: / INFO \[(http\] [\w/]+ (\d{3}|failed|timeout) \d+ms|ws\] state \w+)$/,
  warn: / WARN \[ws\] no auth_ok in time$/,
  debug: / DEBUG \[ws\] (→ \w+|← \w+)$/,
}

let asked: string[] = []

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false, chartOneTap: false })
  mockFocus.on = true
  mockParams = {}
  mockDom.mounts = 0
  mockDom.host = null
  delivered = []
  holds[1] = 0
  holds[2] = 0
  holds[3] = 0
  answered = 0
  asked = []
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  // every native confirm is accepted
  jest.spyOn(Alert, 'alert').mockImplementation((title, _body, buttons?: AlertButton[]) => {
    asked.push(String(title))
    buttons?.find((b) => b.style !== 'cancel')?.onPress?.()
  })
  keepExpectedLogs(HARNESS_LOGS)
})
afterEach(async () => {
  await cleanup()
  if (services) disposeServices(services)
  services = null
  view = null
  jest.clearAllMocks()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the chart route', () => {
  test('a bad key shows the incomplete-link message', async () => {
    await setup()
    mockParams = { key: 'NSE' }
    await open(<ChartRoute />)
    expect(screen.getByText('This chart link is incomplete.')).toBeTruthy()
    expect(mockDom.mounts).toBe(0)
    // the route has no header: its own button goes back
    await press('chart-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)

    mockParams = { key: 'NSE%3ARELIANCE' }
    await view?.rerender(tree(services as Services, <ChartRoute />))
    await pass(10)
    expect(screen.getByTestId('chart-screen')).toBeTruthy()
    expect(screen.getByTestId('chart-dom')).toBeTruthy()
  })
})

describe('chart.init', () => {
  test('after loaded the DOM gets init with intervals, calendars and meta', async () => {
    await setup({
      'POST /api/v1/orderbook': book([order(), order({ orderid: 'B1', symbol: 'INFY' })]),
      'POST /api/v1/positionbook': success([position()]),
    })
    await open()
    services?.store.put(quoteKey('NSE', 'RELIANCE'), { ltp: 1401.5 }, 'poll')
    expect(screen.getByTestId('chart-dom')).toBeTruthy()
    expect(host().props).toEqual({ scheme: 'dark' })
    expect(pushes(CHART_TOPICS.init)).toHaveLength(0)

    await load()
    const [init] = pushes(CHART_TOPICS.init) as ChartInit[]
    expect(init).toEqual({
      inst: RELIANCE,
      // the server's codes that history takes (60m is refused there, ruling 6)
      intervals: ['5s', '1m', '3m', '1h', 'D'],
      calendars: expect.objectContaining({
        NSE: {
          timezone: 'Asia/Kolkata',
          sessions: ['0915-1530:23456'],
          exceptions: { '2026-12-25': [] },
          preMarketMinutes: 15,
        },
      }),
      meta: { ...RELIANCE_META, lots: false, quoteOnly: false, freezeQty: 0 },
      ltp: 1401.5,
      polling: false,
    })
    // then the books: this instrument's working order and position only
    expect(pushes(CHART_TOPICS.orders)).toEqual([
      [{ id: 'A1', side: 'BUY', type: 'LIMIT', qty: 1, price: 1390, trigger: null }],
    ])
    expect(pushes(CHART_TOPICS.positions)).toEqual([[{ product: 'CNC', net: 10, avg: 1398.5 }]])
    // what init carried is not sent again
    expect(pushes(CHART_TOPICS.meta)).toEqual([])
    expect(pushes(CHART_TOPICS.calendars)).toEqual([])
    // the page's first load: symbol, intervals, holidays, timings, orderbook and positionbook
    expect(requests('intervals')).toHaveLength(1)
    expect(requests('market/timings')).toHaveLength(1)
    expect(requests('positionbook')).toHaveLength(1)
  })

  test('a source still pending after 3 s is sent as its fallback', async () => {
    const intervals = gate()
    const holidays = gate()
    const symbol = gate()
    await setup({
      'POST /api/v1/intervals': intervals.route,
      'POST /api/v1/market/holidays': holidays.route,
      'POST /api/v1/symbol': symbol.route,
    })
    await open(<ChartScreen initial={TCS} />)
    await load()
    await pass(2_900)
    expect(pushes(CHART_TOPICS.init)).toHaveLength(0)
    await pass(100)
    await settle()
    expect(pushes(CHART_TOPICS.init)).toEqual([
      {
        inst: TCS,
        intervals: [...FALLBACK_INTERVALS],
        calendars: DEFAULT_CALENDARS,
        meta: null,
        ltp: null,
        polling: false,
      },
    ])

    // each one is pushed once it comes, except the intervals: there is no topic for them
    holidays.open(success([CHRISTMAS]))
    await settle()
    const [calendars] = pushes(CHART_TOPICS.calendars) as ChartInit['calendars'][]
    expect(calendars?.NSE?.exceptions).toEqual({ '2026-12-25': [] })
    symbol.open(
      success({ symbol: 'TCS', exchange: 'NSE', name: 'TCS LTD', lotsize: 1, tick_size: 0.1 }),
    )
    await settle()
    expect(pushes(CHART_TOPICS.meta)).toEqual([
      {
        exchange: 'NSE',
        symbol: 'TCS',
        tick: 0.1,
        lotsize: 1,
        lots: false,
        quoteOnly: false,
        freezeQty: 0,
      },
    ])
    intervals.open(success(INTERVALS))
    await settle()
    expect(pushes(CHART_TOPICS.init)).toHaveLength(1)
    expect(delivered.filter((m) => m.kind === 'push' && m.topic.includes('interval'))).toEqual([])
  })
})

describe('books', () => {
  test('orders and positions of the instrument are pushed when the books change', async () => {
    let rows = [
      order(),
      order({ orderid: 'B1', symbol: 'INFY' }),
      order({ orderid: 'C1', order_status: 'complete' }),
    ]
    let held = [position(), position({ symbol: 'INFY' })]
    await setup({
      'POST /api/v1/orderbook': () => book(rows),
      'POST /api/v1/positionbook': () => success(held),
    })
    await open()
    await load()
    expect(pushes(CHART_TOPICS.orders).at(-1)).toEqual([
      { id: 'A1', side: 'BUY', type: 'LIMIT', qty: 1, price: 1390, trigger: null },
    ])
    const reads = requests('positionbook').length

    // a new working order shows at the book's next read (5 s while orders are working)
    rows = [
      ...rows,
      order({ orderid: 'A2', action: 'SELL', price: 1410, pricetype: 'SL', trigger_price: 1405 }),
    ]
    await pass(5_000)
    expect(pushes(CHART_TOPICS.orders).at(-1)).toEqual([
      { id: 'A1', side: 'BUY', type: 'LIMIT', qty: 1, price: 1390, trigger: null },
      { id: 'A2', side: 'SELL', type: 'SL', qty: 1, price: 1410, trigger: 1405 },
    ])
    // no order of the instrument changed status: the positions are not read again
    expect(requests('positionbook')).toHaveLength(reads)

    // A1 fills between two reads: its line goes, and the positions are read again
    rows = rows.map((r) => (r.orderid === 'A1' ? { ...r, order_status: 'complete' } : r))
    held = [position({ quantity: '11' }), position({ symbol: 'INFY' })]
    await pass(5_000)
    await settle()
    expect(pushes(CHART_TOPICS.orders).at(-1)).toEqual([
      { id: 'A2', side: 'SELL', type: 'SL', qty: 1, price: 1410, trigger: 1405 },
    ])
    expect(requests('positionbook')).toHaveLength(reads + 1)
    expect(pushes(CHART_TOPICS.positions).at(-1)).toEqual([
      { product: 'CNC', net: 11, avg: 1398.5 },
    ])
    // another instrument's order changing status reads nothing
    rows = rows.map((r) => (r.orderid === 'B1' ? { ...r, order_status: 'cancelled' } : r))
    await pass(5_000)
    expect(requests('positionbook')).toHaveLength(reads + 1)
  })

  test('steady state, 120 s with order events: at most 4 orderbook reads and positions only after an order change', async () => {
    let rows = [order({ orderid: 'B1', symbol: 'INFY' })]
    await setup(
      {
        'POST /api/v1/orderbook': () => book(rows),
        'POST /api/v1/positionbook': () => success([position()]),
      },
      // Zerodha's orders come as events on a live feed: the book is read every 30 s
      { live: true },
    )
    await open()
    await load()
    await ready()
    await passLive(1_000)
    const orderbook = requests('orderbook').length
    const positionbook = requests('positionbook').length

    await passLive(120_000)
    expect(requests('orderbook').length - orderbook).toBe(4)
    expect(requests('positionbook').length - positionbook).toBe(0)

    // two order events, 500 ms apart, are one burst: one read of each book
    const update = (orderid: string, order_status: string) => ({
      type: 'order_update',
      orderid,
      symbol: 'INFY',
      exchange: 'NSE',
      order_status,
      quantity: '1',
      mode: 'live',
    })
    rows = [order({ orderid: 'B1', symbol: 'INFY', order_status: 'complete' })]
    sockets.last().serverSend(update('B1', 'open'))
    await pass(300)
    sockets.last().serverSend(update('B1', 'complete'))
    await passLive(119_700)
    expect(requests('orderbook').length - orderbook).toBe(4 + 4 + 1)
    expect(requests('positionbook').length - positionbook).toBe(1)
  })
})

describe('loading', () => {
  test('a skeleton until ready; after 20 s, or on an error event, its message with Reload', async () => {
    await setup()
    await open()
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    expect(screen.queryByTestId('chart-ready')).toBeNull()
    await load()
    await pass(CHART_READY_TIMEOUT_MS)
    expect(screen.getByText(TIMEOUT_COPY)).toBeTruthy()
    expect(screen.queryByTestId('chart-dom')).toBeNull()

    await press('chart-reload')
    expect(screen.getByTestId('chart-dom')).toBeTruthy()
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    await load()
    // the library's own words, whatever the server said (preflight conflict 24)
    const message = 'openalgo-charts: history request failed (400)'
    const warned = expectLog('warn', /\[chart\] the chart did not load: /)
    await event({ name: 'error', message, load: true })
    expect(screen.getByText(TIMEOUT_COPY)).toBeTruthy()
    expect(warned).toEqual([expect.stringContaining(message)])

    await press('chart-reload')
    await load()
    const opened = await ready(250)
    expect(screen.queryByTestId('skeleton')).toBeNull()
    expect(screen.getByTestId('chart-ready').props.accessibilityLabel).toBe('bars 250')
    expect(opened).toHaveLength(1)
    // ready stays: the timeout no longer applies, and a later page error is only logged
    const later = expectLog('warn', /\[chart\] page error: ResizeObserver loop$/)
    await event({ name: 'error', message: 'ResizeObserver loop' })
    await pass(CHART_READY_TIMEOUT_MS)
    expect(screen.getByTestId('chart-ready')).toBeTruthy()
    expect(screen.queryByText(TIMEOUT_COPY)).toBeNull()
    expect(later).toHaveLength(1)
  })

  test("a page's own error before ready is only logged: the chart still opens", async () => {
    await setup()
    await open()
    await load()
    // Chromium's harmless warning, and a stray rejection: neither is the first load failing
    const logged = expectLog('warn', /\[chart\] page error: (ResizeObserver loop|lost)/)
    await event({
      name: 'error',
      message: 'ResizeObserver loop completed with undelivered notifications.',
    })
    await pass(10_000)
    await event({ name: 'error', message: 'lost' })
    expect(screen.queryByText(TIMEOUT_COPY)).toBeNull()
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    expect(logged).toHaveLength(2)
    await ready()
    expect(screen.getByTestId('chart-ready')).toBeTruthy()
    expect(mockDom.mounts).toBe(1)
  })

  test('a first load that failed while the chart was hidden loads again once it is in front', async () => {
    await setup()
    await open()
    await load()
    await setFocus(false)
    // the history request waited for the chart, and the library's 30 s deadline came first
    const warned = expectLog('warn', /\[chart\] the chart did not load: /)
    await event({
      name: 'error',
      message: 'openalgo-charts: history request timed out',
      load: true,
    })
    expect(warned).toHaveLength(1)
    expect(screen.queryByText(TIMEOUT_COPY)).toBeNull()
    expect(mockDom.mounts).toBe(1)

    await setFocus(true)
    // a new page, not the message
    expect(mockDom.mounts).toBe(2)
    expect(screen.queryByText(TIMEOUT_COPY)).toBeNull()
    await load()
    expect(pushes(CHART_TOPICS.init)).toHaveLength(1)
    await ready()
    expect(screen.getByTestId('chart-ready')).toBeTruthy()
  })

  test('a killed WebView shows Reload, and Reload mounts a new DOM (RF 3)', async () => {
    await setup()
    await open()
    await load()
    await ready()
    await subscribed(1)
    expect(holds[1]).toBe(1)
    const first = host()

    await gone()
    expect(screen.getByText(GONE_COPY)).toBeTruthy()
    expect(screen.queryByTestId('chart-dom')).toBeNull()
    // the dead page's holds are let go of, and nothing is left for it to be sent
    expect(holds[1]).toBe(0)
    expect(first.outbox.stats().queued).toBe(0)

    await press('chart-reload')
    expect(mockDom.mounts).toBe(2)
    expect(host().n).toBe(2)
    expect(host().outbox).not.toBe(first.outbox)
    await load()
    expect(pushes(CHART_TOPICS.init)).toHaveLength(1)
  })

  test("Reload after the timeout releases every hold, and the new page's sid 0 opens cleanly", async () => {
    await setup()
    await open()
    await load()
    await subscribed(0, [1, 3])
    expect(holds[1]).toBe(1)
    expect(holds[3]).toBe(1)
    await pass(CHART_READY_TIMEOUT_MS)
    expect(screen.getByText(TIMEOUT_COPY)).toBeTruthy()

    await press('chart-reload')
    expect(holds[1]).toBe(0)
    expect(holds[3]).toBe(0)
    await load()
    await sock(0, { op: 'open', url: DOM_WS_URL })
    expect(socketEvents(0)).toEqual([{ kind: 'socket', sid: 0, event: 'open' }])
    await send(0, { action: 'authenticate', api_key: '__native__' })
    expect(JSON.parse((socketEvents(0)[1] as { data: string }).data)).toMatchObject({
      type: 'auth',
      status: 'success',
    })
  })

  test('the chart keeps clear of the status bar and of the navigation bar or home indicator', async () => {
    insets = { top: 24, bottom: 48, left: 0, right: 0 }
    try {
      await setup()
      await open()
      expect(screen.getByTestId('chart-screen')).toHaveStyle({ paddingTop: 24, paddingBottom: 48 })
    } finally {
      insets = { top: 0, bottom: 0, left: 0, right: 0 }
    }
  })

  test('an unknown instrument shows Expired or unknown and mounts no DOM', async () => {
    await setup()
    await open(<ChartScreen initial={GONE} />)
    expect(screen.getByText('Expired or unknown')).toBeTruthy()
    expect(mockDom.mounts).toBe(0)
    expect(holds[2]).toBe(0)
    await press('chart-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })
})

describe('focus', () => {
  test('returning from a dismissed modify sheet redraws the lines (RF 6)', async () => {
    await setup({ 'POST /api/v1/orderbook': book([order()]) })
    await open()
    await load()
    await ready()
    expect(pushes(CHART_TOPICS.redraw)).toEqual([])
    const lines = pushes(CHART_TOPICS.orders).length

    // a dragged line opens the modify sheet, which is dismissed: nothing is modified
    await intent({ inst: RELIANCE, type: 'modify', orderid: 'A1', price: 1395 })
    expect(mockRouter.push).toHaveBeenLastCalledWith('/order/A1/modify?price=1395&source=chart')
    await setFocus(false)
    await setFocus(true)
    expect(pushes(CHART_TOPICS.redraw)).toEqual([null])
    // the book did not change: the line moves only on a new push
    expect(pushes(CHART_TOPICS.orders)).toHaveLength(lines)
  })

  test('hidden behind the ticket: no quotes poll and no history call until focus', async () => {
    await setup({ 'POST /api/v1/multiquotes': quoted(1402.5) }, { feedMode: 'polling' })
    await open()
    await load()
    await subscribed(1)
    await pass(6_000)
    const polled = requests('multiquotes').length
    expect(polled).toBeGreaterThan(0)
    // in session, the polled price forms the bar
    expect(marketData(1)).toContainEqual({ ltp: 1402.5 })

    await setFocus(false)
    const history = request(7, '/api/v1/history', {
      symbol: 'RELIANCE',
      exchange: 'NSE',
      interval: '5m',
      start_date: '2026-11-19',
      end_date: DAY,
      apikey: '__native__',
    })
    await pass(30_000)
    expect(requests('multiquotes')).toHaveLength(polled)
    expect(requests('history')).toHaveLength(0)
    expect(history.reply).toBeNull()

    await setFocus(true)
    expect(requests('history')).toHaveLength(1)
    expect(history.reply).toEqual({ status: 200, body: { status: 'success', data: [CANDLE] } })
    await pass(6_000)
    expect(requests('multiquotes').length).toBeGreaterThan(polled)
  })
})

describe('polling', () => {
  test("a polled quote is framed only in session, by the server's calendar (RF 5)", async () => {
    // today is a holiday for NSE on the server, where the app's fixed hours say open
    const holiday = { ...CHRISTMAS, date: DAY, closed_exchanges: ['NSE'] }
    await setup(
      {
        'POST /api/v1/multiquotes': quoted(1402.5),
        'POST /api/v1/market/holidays': success([holiday]),
      },
      { feedMode: 'polling' },
    )
    await open()
    await load()
    await subscribed(1)
    await pass(12_000)
    expect(requests('multiquotes').length).toBeGreaterThan(0)
    expect(marketData(1)).toEqual([])
  })
})

describe('notices and modes', () => {
  test("a chart cancel's Semi-Auto 403 and a LIVE surprise show on the chart", async () => {
    const REFUSED = 'Cancel order operation is not allowed in Semi-Auto mode.'
    let semiAuto = true
    let mode: 'live' | 'analyze' = 'live'
    await setup({
      'POST /api/v1/analyzer': () => analyzer(mode),
      'POST /api/v1/orderbook': book([order()]),
      'POST /api/v1/cancelorder': () =>
        semiAuto
          ? { status: 403, body: { status: 'error', message: REFUSED } }
          : ok({ status: 'success', orderid: 'A1' }),
    })
    await open()
    await load()
    await ready()
    await intent({ inst: RELIANCE, type: 'cancel', orderid: 'A1' })
    // the book, the mode and the cancel each take one of the client's tokens
    await pass(1_000)
    expect(asked).toEqual(['LIVE · Cancel this order?'])
    expect(text('banner-semi-auto-blocked')).toContain(REFUSED)

    // the badge says ANALYZE, and the server takes the cancel LIVE: its reply has no sandbox tag
    semiAuto = false
    mode = 'analyze'
    const warned = expectLog(
      'warn',
      /\[orders\] cancel: the review showed ANALYZE, but the server answered LIVE$/,
    )
    // the header badge's read (the tabs layout's useAnalyzer) finds the server in ANALYZE
    await act(async () => {
      services?.queryClient.setQueryData(qk.analyzer(PID), { mode: 'analyze', analyze_mode: true })
      useConnection.getState().set({ analyzer: 'analyze' })
    })
    await pass(20)
    expect(text('chart-mode')).toBe('ANALYZE')
    await intent({ inst: RELIANCE, type: 'cancel', orderid: 'A1' })
    await pass(1_000)
    expect(asked.at(-1)).toBe('ANALYZE · Cancel this order?')
    expect(screen.getByTestId('live-surprise')).toHaveTextContent(liveSurpriseText('cancel'), {
      exact: false,
    })
    expect(warned).toHaveLength(1)
  })

  test('polling mode shows the note', async () => {
    await setup({}, { feedMode: 'polling' })
    await open()
    expect(text('chart-polling-note')).toBe(POLLING_NOTE)
    await load()
    const [init] = pushes(CHART_TOPICS.init) as ChartInit[]
    // a polled forming bar is too slow for seconds
    expect(init?.polling).toBe(true)
    expect(init?.intervals).toEqual(['1m', '3m', '1h', 'D'])
  })

  test('the header: mode only when known, One-tap when on, and depth for a tradeable', async () => {
    await setup()
    useConnection.getState().set({ analyzer: 'unknown' })
    await open()
    expect(screen.queryByTestId('chart-mode')).toBeNull()
    expect(screen.queryByTestId('chart-onetap')).toBeNull()
    await act(async () => {
      useConnection.getState().set({ analyzer: 'live' })
      usePrefs.setState({ chartOneTap: true })
    })
    expect(text('chart-mode')).toBe('LIVE')
    // the product a one-tap order goes in here (the exchange's default)
    expect(text('chart-onetap')).toBe('One-tap · CNC')
    await press('chart-depth')
    expect(mockRouter.push).toHaveBeenLastCalledWith('/depth/NSE%3ARELIANCE')
    await press('chart-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })
})

describe('symbol', () => {
  test('a symbol intent switches the instrument without a remount', async () => {
    await setup({
      'POST /api/v1/orderbook': book([
        order(),
        order({ orderid: 'I1', symbol: 'INFY', price: 1500 }),
      ]),
      'POST /api/v1/positionbook': success([
        position(),
        position({ symbol: 'INFY', quantity: '-5', average_price: '1490' }),
      ]),
    })
    await open()
    await load()
    await ready()
    const before = delivered.length

    await intent({ inst: INFY, type: 'symbol' })
    expect(mockRouter.setParams).toHaveBeenCalledWith({ key: 'NSE%3AINFY' })
    expect(mockDom.mounts).toBe(1)
    expect(screen.getByText('INFY')).toBeTruthy()
    const after = delivered.slice(before)
    const topics = after.flatMap((m) => (m.kind === 'push' ? [m.topic] : []))
    expect(topics).toEqual([CHART_TOPICS.meta, CHART_TOPICS.orders, CHART_TOPICS.positions])
    expect(pushes(CHART_TOPICS.meta).at(-1)).toMatchObject({ exchange: 'NSE', symbol: 'INFY' })
    expect(pushes(CHART_TOPICS.orders).at(-1)).toEqual([
      { id: 'I1', side: 'BUY', type: 'LIMIT', qty: 1, price: 1500, trigger: null },
    ])
    expect(pushes(CHART_TOPICS.positions).at(-1)).toEqual([{ product: 'CNC', net: -5, avg: 1490 }])

    // the chart acts on INFY now: an intent still naming RELIANCE opens nothing
    await intent({ inst: RELIANCE, type: 'depth' })
    expect(text('toast')).toBe(WRONG_SYMBOL)
    expect(mockRouter.push).not.toHaveBeenCalled()
    await intent({ inst: INFY, type: 'depth' })
    expect(mockRouter.push).toHaveBeenLastCalledWith('/depth/NSE%3AINFY')

    // an exchange the app does not know is not switched to
    await intent({ inst: { exchange: 'NASDAQ', symbol: 'AAPL' }, type: 'symbol' })
    expect(mockRouter.setParams).toHaveBeenCalledTimes(1)
    expect(screen.getByText('INFY')).toBeTruthy()
  })
})
