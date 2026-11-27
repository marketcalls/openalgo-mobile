import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import {
  AccessibilityInfo,
  Alert,
  type AlertButton,
  BackHandler,
  Dimensions,
  Keyboard,
  Platform,
} from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import ToolsTab from '~/app/(app)/(tabs)/tools'
import ToolRoute from '~/app/(app)/tools/[toolId]'
import type { Capabilities } from '~/core/capabilities/gates'
import { usePrefs } from '~/core/config/prefs'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import * as haptics from '~/core/platform/haptics'
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
import type {
  DomEvent,
  DomReply,
  JSONValue,
  NativeToDom,
  ToolDomProps,
  ToolIntent,
} from '~/dom/bridge/protocol'
import { CANCELLED_COPY } from '~/dom/gateway/heldWrites'
import { MAX_DOM_INFLIGHT } from '~/dom/gateway/requests'
import * as toolRoutes from '~/dom/gateway/toolRoutes'
import { brokerCaps } from '~/market/brokers/seed'
import { CHECKING, NOT_CHECKED } from '~/market/orders/outcome'
import { holdOrder, otherOrderOut } from '~/market/orders/pending'
import { LIVE_SURPRISE } from '~/market/orders/submit'
import { HOLD_COPY } from '~/market/orders/useHoldSheet'
import { TOOLS } from '~/market/tools/registry'
import { type Trading, TradingProvider, useTrading } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import { tokens } from '~/ui/tokens'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { fakeSockets } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { STILL_SENDING, WITHDRAWN } from './components/HeldOrderSheet'
import { istTime, toolSubtitle } from './components/ToolHeader'
import { TOOL_ENTRY } from './entries'
import { TOOL_ENTRY as WEB_TOOL_ENTRY } from './entries.web'
import type { ToolStatus } from './hooks/useToolGateway'
import {
  heldQueueLine,
  readHeldOrder,
  SHARE_FAILED,
  STOP_BACKTEST,
  TOOL_BUILD,
  TOOL_GONE_COPY,
  TOOL_GROUPS,
  TOOL_LINK_INCOMPLETE,
  TOOL_READY_TIMEOUT_MS,
  TOOL_TIMEOUT_COPY,
  tileState,
  UNREADABLE_ORDER,
} from './model'
import { BACK_WAIT_MS, COVER_HOLD_MS, TOOL_WEBVIEW } from './screens/ToolScreen'

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }
let mockParams: Record<string, string> = {}
/** Whether the tool is the screen in front; a ticket or a sheet over it takes the focus. */
const mockFocus = { on: true, subs: new Set<() => void>() }
const mockNavigation = { setOptions: jest.fn() }
/** Each render's `usePreventRemove(prevent, cb)`, as the native stack would see it. */
const mockPreventRemove = jest.fn()
const mockDisablePrevention = jest.fn()
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
    useNavigation: () => mockNavigation,
    useIsFocused,
    // as React Navigation runs it: at each focus, cleaned up at the blur
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const on = useIsFocused()
      useEffect(() => (on ? effect() : undefined), [on, effect])
    },
    usePreventRemove: (prevent: boolean, cb: unknown) => {
      mockPreventRemove(prevent, cb)
      return mockDisablePrevention
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
const auth: { authenticateAsync: jest.Mock; getEnrolledLevelAsync: jest.Mock } = jest.requireMock(
  'expo-local-authentication',
)
jest.mock('expo-file-system', () => {
  const written: { uri: string; content: string; options?: unknown }[] = []
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : 'cache')).join('/')
    }
    create() {}
    async write(content: string, options?: unknown) {
      written.push({ uri: this.uri, content, options })
    }
  }
  return { File, Paths: { cache: 'cache' }, __written: written }
})
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => {}) }))
const files: { __written: { uri: string; content: string; options?: unknown }[] } =
  jest.requireMock('expo-file-system')
const sharing: { shareAsync: jest.Mock } = jest.requireMock('expo-sharing')

/**
 * A DOM host that records what the screen gives it, as the real one would see it: each mount
 * (a new `key`) is a new page with its own number. The page itself is played by the test.
 */
type Host = DomHostProps<ToolDomProps> & { n: number }
const mockDom: { mounts: number; host: Host | null } = { mounts: 0, host: null }
jest.mock('~/dom/bridge/DomHost', () => {
  const { createElement, useEffect, useState } = require('react')
  const { View } = require('react-native')
  return {
    ...jest.requireActual('~/dom/bridge/DomHost'),
    DomHost: (p: DomHostProps<ToolDomProps>) => {
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
// The pages' own code runs in the dom project; here they are never loaded.
jest.mock('~/dom/tools/OptionToolsDom', () => ({ __esModule: true, default: () => null }))
jest.mock('~/dom/tools/PortfolioToolsDom', () => ({ __esModule: true, default: () => null }))
jest.mock('~/dom/tools/SectorRotationDom', () => ({ __esModule: true, default: () => null }))

const ORIGIN = 'https://algo.example.com'
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
// A Tuesday, 09:30 IST: NSE and NFO are open.
const T0 = Date.UTC(2026, 10, 24, 4, 0)

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
/** The first OpenAlgo with an app-info version and none of the tool endpoints. */
const OLD_CAPS: Capabilities = { ...CAPS, version: '2.0.0.0' }

const CE = 'NIFTY30DEC2624000CE'
const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const PLACED = ok({ status: 'success', orderid: '250408000989443' })
const book = (rows: unknown[]) => ok({ status: 'success', data: { orders: rows, statistics: {} } })
/** An orderbook row as the stock server sends it, placed `sec` seconds after 09:30 IST. */
const row = (orderid: string, sec = 0) => ({
  action: 'SELL',
  symbol: CE,
  exchange: 'NFO',
  orderid,
  product: 'NRML',
  quantity: '150',
  price: 120.5,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: `24-Nov-2026 09:30:${String(sec).padStart(2, '0')}`,
})

/** The order a tool page sends, as the web's PlaceOrderDialog shapes it. */
const ORDER = {
  apikey: '__native__',
  strategy: 'Max Pain',
  exchange: 'NFO',
  symbol: CE,
  action: 'SELL',
  quantity: 150,
  pricetype: 'LIMIT',
  product: 'NRML',
  price: 120.5,
}

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([]),
  'POST /api/v1/positionbook': ok({ status: 'success', data: [] }),
  'POST /api/v1/tradebook': ok({ status: 'success', data: [] }),
  'POST /api/v1/symbol': (req) => {
    const { symbol, exchange } = req.body as { symbol: string; exchange: string }
    return ok({
      status: 'success',
      data: { symbol, exchange, name: 'NIFTY', lotsize: 75, tick_size: 0.05, freeze_qty: 1800 },
    })
  },
  'POST /api/v1/expiry': ok({ status: 'success', data: ['02-DEC-26', '30-DEC-26'] }),
  'POST /api/v1/placeorder': PLACED,
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
/** Each fetch's abort signal, by its path. */
let signals: { path: string; signal: AbortSignal | undefined }[] = []
let trading: Trading | undefined
let view: { rerender: (el: ReactElement) => Promise<unknown>; unmount: () => unknown } | null = null
/** What the page was sent, in order, since it loaded. */
let delivered: NativeToDom[] = []
let insets = { top: 0, bottom: 0, left: 0, right: 0 }

/** The real container over a scripted server; `caps` replaces the stored capabilities. */
async function setup(
  routes: Record<string, Route> = {},
  o: { caps?: Capabilities; appLock?: boolean } = {},
) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  signals = []
  const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => {
    signals.push({ path: String(input).replace(ORIGIN, ''), signal: init?.signal ?? undefined })
    return fetchFake(input, init)
  }) as typeof fetch
  const sockets = fakeSockets()
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(o.caps ?? CAPS),
  })
  await createProfileRepo(kv).save(PROFILE)
  const deps: AppDeps = {
    fetch: fetchSpy,
    WebSocketImpl: sockets.WebSocketImpl,
    secureKV: memoryKV({ [`oa.${PID}.apikey`]: KEY }),
    kv,
    now: () => Date.now(),
    uuid: () => 'u',
    allowDevHosts: false,
    lock: {
      // with appLock, every return from the background locks
      settings: () => ({ enabled: o.appLock ?? false, lockAfterMs: o.appLock ? 0 : 60_000 }),
      authenticate: async () => true,
      available: async () => true,
      confirm: async () => 'ok',
    },
  }
  const s = createServices(PROFILE, deps)
  services = s
  await s.caps.load()
  await s.lock.unlock()
  // the unlock's own book refresh (a 500 ms debounce) goes before the tool opens
  await pass(600)
  // the header's badge, which the tabs layout's useAnalyzer writes once it has read the mode
  useConnection.getState().set({ analyzer: 'live' })
  return s
}

const Grab = () => {
  trading = useTrading()
  return null
}

const tree = (s: Services, node: ReactElement | null) => (
  <SafeAreaInsetsContext.Provider value={insets}>
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={s.queryClient}>
          <TickStoreContext.Provider value={s.store}>
            <LiveContext.Provider
              value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
            >
              <Grab />
              {node}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  </SafeAreaInsetsContext.Provider>
)

/** The app's shell first, then `node` pushed over it. */
async function show(node: ReactElement) {
  if (!services) throw new Error('setup first')
  view = await render(tree(services, null))
  await pass(10)
  await view.rerender(tree(services, node))
  await pass(10)
}
/** Opens `/tools/<toolId>`. */
const openTool = (toolId: string) => {
  mockParams = { toolId }
  return show(<ToolRoute />)
}
/** The tool screen goes (back, or another tab); the shell and its toast stay. */
async function leave() {
  if (!services || !view) throw new Error('open first')
  await view.rerender(tree(services, null))
  await pass(10)
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

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
/** The page has drawn after its init: the screen logs the open time. */
async function ready(page = 'maxpain', info: { csp?: boolean; webgl?: boolean } = {}) {
  const opened = expectLog(
    'info',
    new RegExp(`\\[tool\\] open ${page} \\d+ ms, csp (on|off), webgl (yes|no)$`),
  )
  await event({
    name: 'toolReady',
    info: { page, csp: info.csp ?? true, webgl: info.webgl ?? true },
  } as EventBody)
  return opened
}
/** Opens the tool, and its page loads and is ready. */
async function openReady(toolId = 'maxpain') {
  await openTool(toolId)
  await load()
  await ready(toolId)
}

let rids = 0
/** A page request, answered or not yet; `abort` is the page giving up on it. */
function request(
  method: 'GET' | 'POST',
  path: string,
  o: { body?: JSONValue; query?: Record<string, string> } = {},
) {
  const out: { reply: DomReply | null; error: unknown; abort: () => void } = {
    reply: null,
    error: null,
    abort: () => {},
  }
  const ctl = new AbortController()
  out.abort = () => ctl.abort()
  void host()
    .handlers.request?.(
      { v: 1, kind: 'request', rid: ++rids, method, path, query: o.query, body: o.body },
      ctl.signal,
    )
    .then(
      (r) => {
        out.reply = r
      },
      (e: unknown) => {
        out.error = e
      },
    )
  return out
}
/** The page's held placeorder, with `body` (the web's ORDER by default). */
async function placeorder(body: JSONValue = ORDER) {
  const r = request('POST', '/api/v1/placeorder', { body })
  await pass(20)
  return r
}

const pushes = (topic: string) =>
  delivered.flatMap((m) => (m.kind === 'push' && m.topic === topic ? [m.payload] : []))
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(20)
}
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
const text = (id: string) => textOf(screen.getByTestId(id))
const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState?.disabled
const label = (id: string) => screen.getByTestId(id).props.accessibilityLabel
async function setFocus(on: boolean) {
  await act(async () => {
    mockFocus.on = on
    for (const fn of Array.from(mockFocus.subs)) fn()
  })
  await pass(20)
}
/** A route the test settles: still out until then. */
function gate() {
  let open: (r: ScriptedReply) => void = () => {}
  const promise = new Promise<ScriptedReply>((resolve) => {
    open = resolve
  })
  return { route: () => promise, open }
}
/** The last ToolScreen `usePreventRemove` call: whether it prevents, and its callback. */
const prevention = () => {
  const call = mockPreventRemove.mock.calls.at(-1) as
    | [boolean, (o: { data: { action: object }; repeat: () => void }) => void]
    | undefined
  if (!call) throw new Error('usePreventRemove was not called')
  return { prevent: call[0], blocked: call[1] }
}
/** Android's back, as BackHandler calls its listeners: the last added first, until one takes it. */
async function hardwareBack() {
  const listeners = (BackHandler.addEventListener as jest.Mock).mock.results
    .map((r, i) => ({
      sub: r.value as { remove: () => void },
      fn: (BackHandler.addEventListener as jest.Mock).mock.calls[i][1] as () => boolean,
    }))
    .filter((l) => !removed.has(l.sub))
  let taken = false
  await act(async () => {
    for (const l of listeners.reverse()) {
      if (l.fn()) {
        taken = true
        break
      }
    }
  })
  await pass(20)
  return taken
}
const removed = new Set<unknown>()

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
/** What the next native confirm answers: its ok button, or its dismiss. */
let confirmAnswer: 'ok' | 'cancel' = 'ok'

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  mockFocus.on = true
  mockParams = {}
  mockDom.mounts = 0
  mockDom.host = null
  delivered = []
  insets = { top: 0, bottom: 0, left: 0, right: 0 }
  files.__written.length = 0
  removed.clear()
  asked = []
  confirmAnswer = 'ok'
  const add = BackHandler.addEventListener.bind(BackHandler)
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((name, fn) => {
    const sub = add(name, fn)
    const wrapped = {
      remove: () => {
        removed.add(wrapped)
        sub.remove()
      },
    }
    return wrapped
  })
  jest.spyOn(Alert, 'alert').mockImplementation((title, _body, buttons?: AlertButton[]) => {
    asked.push(String(title))
    const pick = buttons?.find((b) =>
      confirmAnswer === 'ok' ? b.style !== 'cancel' : b.style === 'cancel',
    )
    pick?.onPress?.()
  })
  keepExpectedLogs(HARNESS_LOGS)
})
afterEach(async () => {
  await cleanup()
  if (services) disposeServices(services)
  services = null
  view = null
  trading = undefined
  jest.clearAllMocks()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the Tools tab', () => {
  test('every tool is in exactly one group, Option Chain first; a 2.0.0.0 server shows Portfolio Backtester as needs 2.0.1.8', async () => {
    const ids = TOOL_GROUPS.flatMap((g) => g.ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(TOOLS.map((t) => t.id).sort())
    expect(Object.keys(TOOL_BUILD).sort()).toEqual([...ids].sort())

    await setup({}, { caps: OLD_CAPS })
    await show(<ToolsTab />)
    const tiles = screen.getAllByTestId(/^tool-tile-(?!note-)/).map((n) => n.props.testID)
    expect(tiles).toEqual(ids.map((id) => `tool-tile-${id.toUpperCase()}`))
    expect(tiles[0]).toBe('tool-tile-OPTIONCHAIN')
    expect(text('tool-tile-note-PORTFOLIO-BACKTESTER')).toBe('Needs OpenAlgo 2.0.1.8')
    expect(text('tool-tile-note-SIP-BACKTESTER')).toBe('Needs OpenAlgo 2.0.1.8')
    expect(text('tool-tile-note-SECTOR-ROTATION')).toBe('Needs OpenAlgo 2.0.3.0')
    // the open ones show their description, the title and initials in the web colour
    expect(screen.queryByTestId('tool-tile-note-MAXPAIN')).toBeNull()
    const maxpain = within(screen.getByTestId('tool-tile-MAXPAIN'))
    expect(maxpain.getByText('Max Pain')).toBeTruthy()
    expect(maxpain.getByText(TOOLS.find((t) => t.id === 'maxpain')?.description ?? '')).toBeTruthy()
    expect(maxpain.getByText('MP')).toBeTruthy()
  })

  test('tileState: open, needs with the version and why, later; no caps yet is needs', () => {
    expect(tileState('maxpain', CAPS)).toEqual({ kind: 'open' })
    expect(tileState('optionchain', null)).toEqual({ kind: 'open' })
    expect(tileState('portfolio-backtester', CAPS)).toEqual({ kind: 'open' })
    expect(tileState('portfolio-backtester', OLD_CAPS)).toEqual({
      kind: 'needs',
      version: '2.0.1.8',
      reason: 'needs 2.0.1.8; the server is 2.0.0.0',
    })
    expect(tileState('sector-rotation', null)).toEqual({
      kind: 'needs',
      version: '2.0.3.0',
      reason: 'server version unknown',
    })
    expect(tileState('volsurface', CAPS)).toEqual({ kind: 'later' })
    expect(tileState('not-a-tool', CAPS)).toEqual({ kind: 'later' })
  })

  test('Vol Surface is later and does not open; Max Pain opens /tools/maxpain', async () => {
    await setup({}, { caps: OLD_CAPS })
    await show(<ToolsTab />)
    expect(text('tool-tile-note-VOLSURFACE')).toBe('Not in this build yet')
    await press('tool-tile-VOLSURFACE')
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(text('toast')).toBe('Not in this build yet. It arrives in the next update.')
    // a gated row is never a dead tap: both versions, and nothing opens
    await press('tool-tile-PORTFOLIO-BACKTESTER')
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(text('toast')).toBe('Needs OpenAlgo 2.0.1.8. This server is 2.0.0.0.')
    expect(label('tool-tile-PORTFOLIO-BACKTESTER')).toBe(
      'Portfolio Backtester, Needs OpenAlgo 2.0.1.8',
    )

    await press('tool-tile-MAXPAIN')
    expect(mockRouter.push).toHaveBeenCalledWith('/tools/maxpain')
    await press('tool-tile-OPTIONCHAIN')
    expect(mockRouter.push).toHaveBeenLastCalledWith('/tools/optionchain')
  })

  test('a server new enough but missing the endpoint says why', async () => {
    await setup({}, { caps: { ...CAPS, endpoints: ['portfolio/backtest', 'sip/backtest'] } })
    await show(<ToolsTab />)
    await press('tool-tile-SECTOR-ROTATION')
    expect(text('toast')).toBe(
      'Needs OpenAlgo 2.0.3.0. This server is 2.0.3.5, but swagger.json does not list sectorrotation.',
    )
  })
})

describe('the tool route', () => {
  // Option Chain's native screen opens from this route too: features/optionchain's suite.
  test('a later tool says it is coming; an unknown id is an incomplete link', async () => {
    await setup()
    await openTool('volsurface')
    expect(screen.getByText("Tools aren't in this build yet.")).toBeTruthy()
    expect(mockDom.mounts).toBe(0)
    await press('tool-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)

    mockParams = { toolId: 'nope' }
    await view?.rerender(tree(services as Services, <ToolRoute />))
    expect(screen.getByText(TOOL_LINK_INCOMPLETE)).toBeTruthy()
    expect(mockDom.mounts).toBe(0)
  })

  test('each page id opens its family entry; the web preview maps the same pages', () => {
    expect(Object.keys(WEB_TOOL_ENTRY).sort()).toEqual(Object.keys(TOOL_ENTRY).sort())
    expect(Object.keys(TOOL_ENTRY).sort()).toEqual(
      Object.entries(TOOL_BUILD)
        .filter(([, b]) => b.build === 'dom')
        .map(([id]) => id)
        .sort(),
    )
    expect(TOOL_ENTRY.maxpain).toBe(TOOL_ENTRY.gex)
    expect(TOOL_ENTRY['portfolio-analyzer']).toBe(TOOL_ENTRY['sip-backtester'])
    expect(TOOL_ENTRY['sector-rotation']).not.toBe(TOOL_ENTRY.maxpain)
  })
})

describe('the tool screen', () => {
  test('the tool screen pushes init with the seeded broker caps after loaded', async () => {
    await setup()
    await openTool('maxpain')
    expect(host().Dom).toBe(TOOL_ENTRY.maxpain)
    expect(host().props).toEqual({ scheme: 'dark', page: 'maxpain', reduceMotion: false })
    expect(pushes('tool.init')).toEqual([])
    await load()
    const caps = brokerCaps('zerodha', '2.0.3.5')
    expect(caps.supported_exchanges).toContain('NFO')
    expect(pushes('tool.init')).toEqual([
      { page: 'maxpain', seed: { broker: 'zerodha', capabilities: caps } },
    ])
    // a page that loads again on its host gets its init again
    await load()
    expect(pushes('tool.init')).toHaveLength(1)
  })

  test('a skeleton until toolReady, then tool-ready; after 20 s Reload; a gone WebView shows Reload', async () => {
    await setup()
    await openTool('maxpain')
    expect(screen.getByTestId('tool-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('tool-ready')).toBeNull()
    await load()
    const opened = await ready()
    expect(opened).toHaveLength(1)
    expect(label('tool-ready')).toBe('page maxpain')
    expect(label('tool-csp')).toBe('violations 0')
    // an option tool keeps its cover for its first figures, or 3 s
    expect(screen.getByTestId('tool-skeleton')).toBeTruthy()
    await pass(COVER_HOLD_MS)
    // then it fades over 150 ms
    expect(screen.getByTestId('tool-skeleton')).toBeTruthy()
    await pass(200)
    expect(screen.queryByTestId('tool-skeleton')).toBeNull()

    // a page that never gets ready
    await event({ name: 'loaded' })
    expect(screen.queryByTestId('tool-ready')).toBeNull()
    await pass(TOOL_READY_TIMEOUT_MS)
    expect(screen.getByText(TOOL_TIMEOUT_COPY)).toBeTruthy()
    expect(screen.queryByTestId('tool-dom')).toBeNull()
    await press('tool-reload')
    expect(host().n).toBe(2)
    expect(screen.getByTestId('tool-skeleton')).toBeTruthy()

    // the OS killed the WebView
    await load()
    await act(async () => host().onGone())
    await pass(20)
    expect(screen.getByText(TOOL_GONE_COPY)).toBeTruthy()
    await press('tool-reload')
    expect(host().n).toBe(3)
  })

  test('a release page that reports no CSP in force is not shown; a dev build shows it', async () => {
    const g = globalThis as unknown as { __DEV__: boolean }
    const dev = g.__DEV__
    await setup()
    await openTool('maxpain')
    await load()
    // (a release build's log prints nothing to the console: logger.ts)
    g.__DEV__ = false
    try {
      await ready('maxpain', { csp: false })
    } finally {
      g.__DEV__ = dev
    }
    expect(screen.queryByTestId('tool-ready')).toBeNull()
    expect(screen.getByText(TOOL_TIMEOUT_COPY)).toBeTruthy()
    // a dev build runs the dev policy; its probe is only logged
    g.__DEV__ = true
    try {
      await press('tool-reload')
      await load()
      await ready('maxpain', { csp: false })
    } finally {
      g.__DEV__ = dev
    }
    expect(label('tool-ready')).toBe('page maxpain')
  })

  test('a refused init fails the first load; an error after ready is only logged', async () => {
    await setup()
    await openTool('maxpain')
    await load()
    const lines = expectLog('warn', /\[tool\] maxpain did not load: bad init$/)
    await event({ name: 'error', message: 'bad init', load: true })
    expect(lines).toHaveLength(1)
    expect(screen.getByText(TOOL_TIMEOUT_COPY)).toBeTruthy()
    await press('tool-reload')
    await load()
    await ready()
    const own = expectLog('warn', /\[tool\] maxpain page error: ResizeObserver loop$/)
    await event({ name: 'error', message: 'ResizeObserver loop' })
    await event({ name: 'pageError', message: 'ResizeObserver loop' })
    expect(own).toHaveLength(1)
    expect(screen.getByTestId('tool-ready')).toBeTruthy()
  })

  test('the page cover holds for the first figures, then fades; under reduced motion at once', async () => {
    const figures = gate()
    await setup({ 'POST /api/v1/optionchain': figures.route })
    await openReady()
    // the page asks for its figures: the cover waits for them
    const r = request('POST', '/oitracker/api/maxpain', {
      body: { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '02DEC26' },
    })
    await pass(1_000)
    expect(screen.getByTestId('tool-skeleton')).toBeTruthy()
    await act(async () => figures.open({ status: 500, body: { status: 'error', message: 'x' } }))
    await pass(50)
    expect(r.reply).not.toBeNull()
    // two frames after the reply, the fade
    await pass(50)
    await pass(200)
    expect(screen.queryByTestId('tool-skeleton')).toBeNull()

    // reduced motion: the cover goes at once, with no fade
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    await press('tool-back')
    await leave()
    await openReady()
    await pass(COVER_HOLD_MS)
    expect(screen.queryByTestId('tool-skeleton')).toBeNull()
    expect(host().props.reduceMotion).toBe(true)
  })

  test('the WebView and the cover sit on the theme background; the page scrolls itself', async () => {
    await setup()
    await openTool('maxpain')
    expect(host().webview).toBe(TOOL_WEBVIEW.dark)
    expect(TOOL_WEBVIEW.dark).toEqual({
      style: { flex: 1, backgroundColor: tokens.dark.background },
      containerStyle: { flex: 1, backgroundColor: tokens.dark.background },
      scrollEnabled: true,
    })
    expect(TOOL_WEBVIEW.light.style.backgroundColor).toBe(tokens.light.background)
  })

  test('one LIVE badge on the screen, in the header; the true badges sit in the subtitle line', async () => {
    await setup()
    useConnection.getState().set({ feed: 'polling', transport: 'http' })
    await openReady()
    expect(screen.getAllByText('LIVE')).toHaveLength(1)
    expect(text('tool-mode')).toBe('LIVE')
    expect(screen.queryByTestId('mode-badge')).toBeNull()
    const line = within(screen.getByTestId('tool-subtitle'))
    expect(line.getByTestId('badge-polling')).toBeTruthy()
    expect(line.getByTestId('badge-http')).toBeTruthy()
    expect(text('tool-title')).toBe('Max Pain')
    // a title tap scrolls the page to its top
    await press('tool-title')
    expect(pushes('tool.top')).toEqual([null])
  })

  test('the subtitle: updating, then updated at the server time; a failure says why and how to retry', async () => {
    const chain = gate()
    await setup({ 'POST /api/v1/optionchain': chain.route })
    await openReady()
    expect(text('tool-subtitle-text')).toBe('')
    const body = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '02DEC26' }
    request('POST', '/oitracker/api/maxpain', { body })
    await pass(20)
    expect(text('tool-subtitle-text')).toBe('Updating…')
    await act(async () =>
      chain.open({ status: 400, body: { status: 'error', message: 'Invalid expiry date' } }),
    )
    await pass(200)
    expect(text('tool-subtitle-text')).toMatch(
      /^Couldn't update · 09:30:\d\d · .+\. Tap Refresh to retry\.$/,
    )
    // and a DomHost that never changed for any of it
    expect(mockDom.mounts).toBe(1)
  })

  test('toolSubtitle states, first that applies', () => {
    const at = T0 + 5_000
    const st = (o: Partial<ToolStatus>): ToolStatus => ({
      updating: 0,
      last: null,
      longSince: null,
      progress: null,
      ...o,
    })
    expect(istTime(at)).toBe('09:30:05')
    expect(toolSubtitle(st({}), T0).text).toBe('')
    expect(toolSubtitle(st({ last: { ok: true, at } }), T0).text).toBe('Updated 09:30:05')
    expect(toolSubtitle(st({ updating: 1, last: { ok: true, at } }), T0).text).toBe('Updating…')
    expect(toolSubtitle(st({ updating: 1, longSince: T0 - 500 }), T0).text).toBe('Updating…')
    expect(toolSubtitle(st({ updating: 1, longSince: T0 - 65_000 }), T0).text).toBe('Working… 1:05')
    const failed = toolSubtitle(
      st({ updating: 1, longSince: T0 - 65_000, last: { ok: false, at, message: 'No data' } }),
      T0,
    )
    expect(failed).toEqual({
      text: "Couldn't update · 09:30:05 · No data. Tap Refresh to retry.",
      tone: 'warning',
    })
    // a sentence that ends itself is not closed twice; no message, the time then the way on
    const told = (message: string) =>
      toolSubtitle(st({ last: { ok: false, at, message } }), T0).text
    expect(told('Too many requests at once. Try again.')).toBe(
      "Couldn't update · 09:30:05 · Too many requests at once. Try again. Tap Refresh to retry.",
    )
    expect(told('')).toBe("Couldn't update · 09:30:05. Tap Refresh to retry.")
    expect(
      toolSubtitle(
        st({ last: failed as never, progress: { label: 'History', done: 3, total: 12 } }),
        T0,
      ),
    ).toEqual({ text: 'History: 3 of 12', tone: 'muted', progress: 0.25 })
  })

  test('a CSP violation and the layout probe show in their probes, and the overflow is logged', async () => {
    await setup()
    await openReady()
    await event({ name: 'violation', directive: 'connect-src' })
    expect(label('tool-csp')).toBe('violations 1')
    expect(screen.queryByTestId('tool-layout')).toBeNull()
    const logged = expectLog('info', /\[tool\] maxpain overflow \d+px$/)
    await event({ name: 'layout', overflow: 0 })
    expect(label('tool-layout')).toBe('overflow 0')
    await event({ name: 'layout', overflow: 12 })
    await event({ name: 'layout', overflow: 3 })
    expect(label('tool-layout')).toBe('overflow 12')
    expect(logged).toHaveLength(3)
  })

  test('the keyboard pads the page only when the window did not shrink for it', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    insets = { top: 24, bottom: 20, left: 0, right: 0 }
    const listeners = new Map<string, (e: { endCoordinates: { height: number } }) => void>()
    const addListener = Keyboard.addListener.bind(Keyboard)
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, fn) => {
      listeners.set(name, fn as never)
      return addListener(name, fn)
    })
    const window = { width: 360, height: 780, scale: 3, fontScale: 1 }
    jest.spyOn(Dimensions, 'get').mockImplementation(() => window)
    await setup()
    await openReady()
    const pad = () => screen.getByTestId('tool-body').props.style
    const keyboard = (name: string) =>
      act(async () => listeners.get(name)?.({ endCoordinates: { height: 300 } }))

    // edge to edge: the window stays 780 high, so the page is padded above the keyboard
    await keyboard('keyboardDidShow')
    expect(pad()).toEqual(expect.arrayContaining([{ paddingBottom: 280 }]))
    await keyboard('keyboardDidHide')
    expect(pad()).toEqual(expect.arrayContaining([{ paddingBottom: 0 }]))
    // the window resized for it: no padding
    window.height = 480
    await keyboard('keyboardDidShow')
    expect(pad()).toEqual(expect.arrayContaining([{ paddingBottom: 0 }]))
  })
})

describe('back', () => {
  test('back asks the page first: handled stays, unanswered leaves after 150 ms, not handled leaves', async () => {
    await setup()
    await openReady()
    await press('tool-back')
    expect(pushes('tool.back')).toHaveLength(1)
    await event({ name: 'back', handled: true })
    await pass(BACK_WAIT_MS)
    expect(mockRouter.back).not.toHaveBeenCalled()

    // Android's back, unanswered
    expect(await hardwareBack()).toBe(true)
    expect(pushes('tool.back')).toHaveLength(2)
    await pass(BACK_WAIT_MS)
    expect(mockDisablePrevention).toHaveBeenCalled()
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })

  test('on a report route back goes to its builder and the swipe is off; the main view swipes', async () => {
    await setup()
    await openReady('portfolio-backtester')
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({ gestureEnabled: true })
    await event({ name: 'route', path: '/portfolio-backtester/results' })
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({ gestureEnabled: false })
    await press('tool-back')
    await event({ name: 'back', handled: true })
    await event({ name: 'route', path: '/portfolio-backtester' })
    await pass(BACK_WAIT_MS)
    expect(mockRouter.back).not.toHaveBeenCalled()
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({ gestureEnabled: true })

    // the swipe on the main view: the stack's pop waits for the page, then goes on
    const { prevent, blocked } = prevention()
    expect(prevent).toBe(true)
    const repeat = jest.fn()
    await act(async () =>
      blocked({ data: { action: { type: 'POP', payload: { count: 1 } } }, repeat }),
    )
    await pass(20)
    expect(pushes('tool.back')).toHaveLength(2)
    await event({ name: 'back', handled: false })
    expect(repeat).toHaveBeenCalledTimes(1)
    expect(mockRouter.back).not.toHaveBeenCalled()
    // somewhere else (the order book) goes at once, asking nothing
    const away = jest.fn()
    await act(async () =>
      prevention().blocked({ data: { action: { type: 'POP_TO' } }, repeat: away }),
    )
    expect(away).toHaveBeenCalledTimes(1)
    expect(pushes('tool.back')).toHaveLength(2)
  })

  test('before the page is ready, back leaves at once', async () => {
    await setup()
    await openTool('maxpain')
    expect(prevention().prevent).toBe(false)
    await press('tool-back')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
    expect(pushes('tool.back')).toEqual([])
  })

  test('leaving with a pass still running asks first: Stay keeps it, Leave stops it', async () => {
    const backtest = gate()
    await setup({ 'POST /api/v1/portfolio/backtest': backtest.route })
    await openReady('portfolio-backtester')
    const r = request('POST', '/api/v1/portfolio/backtest', {
      body: {
        apikey: '__native__',
        holdings: [],
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
    })
    await pass(2_000)
    expect(text('tool-subtitle-text')).toBe('Working… 0:02')
    confirmAnswer = 'cancel'
    await press('tool-back')
    await pass(BACK_WAIT_MS)
    expect(asked).toEqual([STOP_BACKTEST])
    expect(mockRouter.back).not.toHaveBeenCalled()
    const sent = signals.find((x) => x.path === '/api/v1/portfolio/backtest')
    expect(sent?.signal?.aborted).toBe(false)

    confirmAnswer = 'ok'
    await press('tool-back')
    await pass(BACK_WAIT_MS)
    expect(asked).toEqual([STOP_BACKTEST, STOP_BACKTEST])
    expect(sent?.signal?.aborted).toBe(true)
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
    expect(r.reply).not.toBeNull()
  })
})

describe('the gateway', () => {
  test('the startup calls are answered on the phone; an error report is counted, never read or sent', async () => {
    await setup()
    await openReady()
    const before = fetchFake.calls.length
    const caps = request('GET', '/api/broker/capabilities')
    const mode = request('GET', '/auth/analyzer-mode')
    const key = request('GET', '/api/websocket/apikey')
    const csrf = request('GET', '/auth/csrf-token')
    const counted = expectLog('info', /\[tool\] maxpain error reports \d+$/)
    const reports = [1, 2].map(() =>
      request('POST', '/admin/api/errors/client', { body: { message: 'boom', url: 'x' } }),
    )
    const logout = request('POST', '/auth/logout')
    await pass(100)
    expect(caps.reply).toEqual({
      status: 200,
      body: { status: 'success', data: brokerCaps('zerodha', '2.0.3.5') },
    })
    expect(mode.reply?.body).toEqual({
      status: 'success',
      data: { mode: 'live', analyze_mode: false },
    })
    expect(key.reply?.body).toEqual({ status: 'success', api_key: '__native__' })
    expect(csrf.reply?.body).toEqual({ csrf_token: 'native' })
    expect(reports.map((r) => r.reply?.status)).toEqual([204, 204])
    // once per 10 s, the count only
    expect(counted).toEqual([expect.stringMatching(/error reports 1$/)])
    expect(logout.reply?.status).toBe(403)
    // only the mode read may reach the server
    for (const c of fetchFake.calls.slice(before)) expect(c.url).toBe(`${ORIGIN}/api/v1/analyzer`)
  })

  test("under polling the page's socket closes as it opens (no tool here reads it)", async () => {
    await setup()
    useConnection.getState().set({ feed: 'polling' })
    await openReady()
    await act(async () =>
      host().handlers.socket?.({
        v: 1,
        kind: 'socket',
        sid: 1,
        op: 'open',
        url: 'wss://native.invalid/ws',
      }),
    )
    await pass(20)
    expect(delivered).toContainEqual({ kind: 'socket', sid: 1, event: 'close' })
  })

  test('hidden behind another screen: no request reaches Api; on focus, three identical ones become one call (RF 5)', async () => {
    await setup()
    await openReady()
    const expiries = jest.spyOn((trading as Trading).options, 'expiries')
    await setFocus(false)
    const query = { exchange: 'NFO', underlying: 'NIFTY', instrumenttype: 'options' }
    const three = [1, 2, 3].map(() => request('GET', '/search/api/expiries', { query }))
    await pass(1_000)
    expect(requests('expiry')).toHaveLength(0)
    expect(expiries).not.toHaveBeenCalled()
    expect(three.every((r) => r.reply === null)).toBe(true)

    await setFocus(true)
    await pass(100)
    expect(expiries).toHaveBeenCalledTimes(1)
    expect(requests('expiry')).toHaveLength(1)
    for (const r of three) {
      expect(r.reply).toEqual({
        status: 200,
        body: { status: 'success', expiries: ['02-DEC-26', '30-DEC-26'] },
      })
    }
  })

  test('hidden for many Auto ticks: identical waiting requests share one slot, so none is refused and the newest gets the reply', async () => {
    // IV Smile on Auto every 30 s, behind another screen for over 4 minutes: more identical
    // requests than MAX_DOM_INFLIGHT wait, and the page keeps only its newest one's answer
    await setup()
    await openReady()
    await setFocus(false)
    const query = { exchange: 'NFO', underlying: 'NIFTY', instrumenttype: 'options' }
    const ticks = Array.from({ length: MAX_DOM_INFLIGHT + 4 }, () =>
      request('GET', '/search/api/expiries', { query }),
    )
    await pass(1_000)
    expect(ticks.every((r) => r.reply === null)).toBe(true)
    // distinct requests still count one slot each: the cap holds
    const others = Array.from({ length: MAX_DOM_INFLIGHT - 1 }, (_, i) =>
      request('GET', '/search/api/expiries', { query: { ...query, underlying: `U${i}` } }),
    )
    const over = request('GET', '/search/api/expiries', { query: { ...query, underlying: 'U9' } })
    await pass(20)
    expect(others.every((r) => r.reply === null)).toBe(true)
    expect(over.reply?.status).toBe(429)

    await setFocus(true)
    await pass(2_000)
    // the ticks as one call, and each other underlying's own
    expect(requests('expiry').length).toBe(MAX_DOM_INFLIGHT)
    for (const r of ticks) {
      expect(r.reply).toEqual({
        status: 200,
        body: { status: 'success', expiries: ['02-DEC-26', '30-DEC-26'] },
      })
    }
  })

  test('two identical held orders that wait through one hidden period are two reviews, never one', async () => {
    await setup()
    await openReady()
    await setFocus(false)
    const a = await placeorder()
    const b = await placeorder()
    await pass(1_000)
    await setFocus(true)
    await pass(100)
    // the first is on show, the second waits its turn: each is its own order
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    expect(text('tool-held-queue')).toBe(heldQueueLine(1))
    await press('tool-held-cancel')
    expect(a.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(b.reply).toBeNull()
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    await press('tool-held-cancel')
    expect(b.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('a waiting request the page gives up on leaves its group; the others still get the reply', async () => {
    await setup()
    await openReady()
    await setFocus(false)
    const query = { exchange: 'NFO', underlying: 'NIFTY' }
    const a = request('GET', '/search/api/expiries', { query })
    const b = request('GET', '/search/api/expiries', { query })
    a.abort()
    await pass(20)
    await setFocus(true)
    await pass(100)
    expect(b.reply?.status).toBe(200)
    expect(requests('expiry')).toHaveLength(1)
  })

  test('background, the lock or the share sheet never abort a request in flight', async () => {
    const backtest = gate()
    await setup({ 'POST /api/v1/portfolio/backtest': backtest.route })
    await openReady('portfolio-backtester')
    const r = request('POST', '/api/v1/portfolio/backtest', {
      body: {
        apikey: '__native__',
        holdings: [],
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
    })
    await pass(20)
    await setFocus(false)
    await pass(1_000)
    await setFocus(true)
    const sent = signals.find((x) => x.path === '/api/v1/portfolio/backtest')
    expect(sent?.signal?.aborted).toBe(false)
    await act(async () => backtest.open(ok({ status: 'success', metrics: {} })))
    await pass(20)
    expect(r.reply).toEqual({ status: 200, body: { status: 'success', metrics: {} } })
    // the page's key placeholder never travels; the client adds the real key
    expect(requests('portfolio/backtest')[0]?.body).toMatchObject({ apikey: KEY })
  })

  test('leaving with a backtest in flight aborts it; an unconfirmed held order is answered cancelled, never sent (RF 5)', async () => {
    const backtest = gate()
    await setup({ 'POST /api/v1/portfolio/backtest': backtest.route })
    await openReady('portfolio-backtester')
    const run = request('POST', '/api/v1/portfolio/backtest', {
      body: {
        apikey: '__native__',
        holdings: [],
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
    })
    const order = await placeorder()
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    // and one more waiting behind it
    const next = await placeorder({ ...ORDER, quantity: 75 })
    await leave()
    const sent = signals.find((x) => x.path === '/api/v1/portfolio/backtest')
    expect(sent?.signal?.aborted).toBe(true)
    expect(order.reply).toEqual({
      status: 400,
      body: { status: 'error', message: CANCELLED_COPY },
    })
    expect(next.reply).toEqual(order.reply)
    expect(run.reply).not.toBeNull()
    await pass(60_000)
    expect(requests('placeorder')).toHaveLength(0)
  })

  test("the device routes get the Greeks gate, the screen's focus, its progress line, one intervals read and a lifetime each load ends", async () => {
    const made = jest.spyOn(toolRoutes, 'createToolRoutes')
    await setup({
      'POST /api/v1/intervals': ok({ status: 'success', data: { minutes: ['1m', '5m'] } }),
    })
    await openReady()
    const deps = made.mock.calls.at(-1)?.[1].deps
    if (!deps) throw new Error('no tool routes were made')
    expect(deps.greeksOnServer()).toBe(true)

    expect(await deps.intervals()).toEqual({ minutes: ['1m', '5m'] })
    expect(await deps.intervals()).toEqual({ minutes: ['1m', '5m'] })
    expect(requests('intervals')).toHaveLength(1)

    await act(async () => deps.progress({ label: 'Previous-day OI', done: 23, total: 82 }))
    expect(text('tool-subtitle-text')).toBe('Previous-day OI: 23 of 82')
    expect(screen.getByTestId('tool-progress')).toBeTruthy()

    // hidden: a wait ends on focus, or at once when its own signal aborts
    expect(deps.active()).toBe(true)
    await setFocus(false)
    expect(deps.active()).toBe(false)
    let shown = false
    void deps.untilActive(new AbortController().signal).then(() => {
      shown = true
    })
    const given = new AbortController()
    const dropped = deps.untilActive(given.signal)
    given.abort()
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' })
    await pass(1_000)
    expect(shown).toBe(false)
    await setFocus(true)
    expect(shown).toBe(true)
    expect(deps.active()).toBe(true)

    // the page loads again: the first load's lifetime ends, the next has its own; leaving ends it
    const first = deps.lifetime
    await load()
    expect(first.aborted).toBe(true)
    const second = deps.lifetime
    expect(second.aborted).toBe(false)
    await leave()
    expect(second.aborted).toBe(true)
  })

  test('a save intent writes the file and opens the share sheet; a chart intent is refused', async () => {
    await setup()
    await openReady('sector-rotation')
    const intent: ToolIntent = {
      type: 'save',
      name: 'sector-rotation.png',
      mime: 'image/png',
      base64: 'iVBORw0KGgo=',
    }
    await act(async () => host().handlers.intent?.({ v: 1, kind: 'intent', intent }))
    await pass(20)
    expect(files.__written).toEqual([
      {
        uri: 'cache/sector-rotation.png',
        content: 'iVBORw0KGgo=',
        options: { encoding: 'base64' },
      },
    ])
    expect(sharing.shareAsync).toHaveBeenCalledWith('cache/sector-rotation.png', {
      mimeType: 'image/png',
      dialogTitle: 'Save file',
    })

    // a share sheet that cannot open says so
    sharing.shareAsync.mockRejectedValueOnce(new Error('no activity'))
    const failed = expectLog('warn', /\[tool\] could not share a file/)
    await act(async () => host().handlers.intent?.({ v: 1, kind: 'intent', intent }))
    await pass(20)
    expect(failed).toHaveLength(1)
    expect(text('toast')).toBe(SHARE_FAILED)

    const refused = expectLog('warn', /\[tool\] refused a trade intent from sector-rotation$/)
    await act(async () =>
      host().handlers.intent?.({
        v: 1,
        kind: 'intent',
        intent: { type: 'trade', inst: { exchange: 'NSE', symbol: 'INFY' }, side: 'BUY', lots: 1 },
      }),
    )
    expect(refused).toHaveLength(1)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('the tearsheet is saved and shared once, as HTML named by its period; the page gets its in-app answer', async () => {
    await setup({
      'POST /api/v1/portfolio/tearsheet': {
        status: 200,
        contentType: 'text/html',
        body: '<html>tearsheet</html>',
      },
    })
    await openReady('portfolio-backtester')
    const r = request('POST', '/api/v1/portfolio/tearsheet', {
      body: {
        apikey: '__native__',
        holdings: [],
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
    })
    await pass(50)
    expect(r.reply?.status).toBe(200)
    expect(files.__written).toEqual([
      {
        uri: 'cache/OpenAlgo-tearsheet-2024-01-01-to-2024-12-31.html',
        content: '<html>tearsheet</html>',
        options: undefined,
      },
    ])
    expect(sharing.shareAsync).toHaveBeenCalledTimes(1)
  })
})

describe('held order review', () => {
  test('a body with apikey __native__ parses; an unreadable one is answered without a send', async () => {
    expect(readHeldOrder(ORDER)).toEqual({
      strategy: 'Max Pain',
      exchange: 'NFO',
      symbol: CE,
      action: 'SELL',
      quantity: 150,
      pricetype: 'LIMIT',
      product: 'NRML',
      price: 120.5,
      trigger_price: 0,
      disclosed_quantity: 0,
    })
    const bad: Record<string, unknown>[] = [
      { ...ORDER, extra: 1 },
      { ...ORDER, quantity: 1.5 },
      { ...ORDER, quantity: 0 },
      { ...ORDER, quantity: '150' },
      { ...ORDER, exchange: 'NASDAQ' },
      { ...ORDER, exchange: 'NSE_INDEX', symbol: 'NIFTY' },
      { ...ORDER, action: 'buy' },
      { ...ORDER, price: -1 },
      { ...ORDER, pricetype: undefined },
      { ...ORDER, product: 'BO' },
      { ...ORDER, symbol: 'X'.repeat(65) },
      { ...ORDER, strategy: 'S'.repeat(65) },
    ]
    for (const b of bad) expect(readHeldOrder(JSON.parse(JSON.stringify(b)))).toBeNull()

    await setup()
    await openReady()
    const r = await placeorder({ ...ORDER, quantity: 1.5 })
    expect(r.reply).toEqual({ status: 400, body: { status: 'error', message: UNREADABLE_ORDER } })
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('an unreadable order never blocks the next: a readable one after it is reviewed, and so is one after two unreadable', async () => {
    await setup()
    await openReady()
    const unreadable = { status: 400, body: { status: 'error', message: UNREADABLE_ORDER } }
    const a = await placeorder({ ...ORDER, quantity: 1.5 })
    expect(a.reply).toEqual(unreadable)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    // the readable one right after it gets its review, and its confirm sends it
    const b = await placeorder()
    await pass(200)
    expect(text('tool-held-summary')).toBe('LIMIT 2L (150) @ 120.50')
    await press('tool-held-confirm')
    await pass(50)
    expect(b.reply).toEqual({
      status: 200,
      body: { status: 'success', orderid: '250408000989443' },
    })
    expect(requests('placeorder')).toHaveLength(1)
    // two unreadable in a row are each answered; the next readable one is reviewed
    const c = await placeorder({ ...ORDER, quantity: 0 })
    expect(c.reply).toEqual(unreadable)
    const d = await placeorder({ ...ORDER, action: 'buy' })
    expect(d.reply).toEqual(unreadable)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    const e = await placeorder()
    await pass(200)
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    await press('tool-held-cancel')
    expect(e.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('the review shows the order as it goes: side, symbol, where from, and its terms in lots', async () => {
    await setup()
    await openReady()
    await placeorder()
    await pass(200)
    const head = within(screen.getByTestId('tool-held-head'))
    expect(head.getByText('SELL')).toBeTruthy()
    expect(textOf(screen.getByTestId('tool-held-head'))).toContain(`SELL ${CE}`)
    expect(head.getByText('NFO · NRML · from Max Pain')).toBeTruthy()
    expect(text('tool-held-summary')).toBe('LIMIT 2L (150) @ 120.50')
    expect(text('tool-held-mode')).toBe('LIVE')
    expect(text('tool-held-confirm')).toBe('Place SELL order')
    // the buttons sit in the fixed footer, outside the scroll; none of the ticket's ids
    const scroll = within(screen.getByTestId('tool-held-scroll'))
    expect(scroll.queryByTestId('tool-held-confirm')).toBeNull()
    expect(
      within(screen.getByTestId('tool-held-footer')).getByTestId('tool-held-confirm'),
    ).toBeTruthy()
    expect(screen.queryByTestId('ticket-confirm')).toBeNull()
    expect(screen.queryByTestId('review-mode-badge')).toBeNull()
  })

  test('held placeorder: confirm sends once with the mode re-read; a tap or back press during the send is ignored', async () => {
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    const success = jest.spyOn(haptics, 'notifySuccess')
    await openReady()
    const r = await placeorder()
    await pass(200)
    // the review's reading is 5 s old by the confirm: the mode is read again before the send
    await pass(6_000)
    const reads = requests('analyzer').length
    await press('tool-held-confirm')
    expect(requests('analyzer')).toHaveLength(reads + 1)
    expect(requests('placeorder')).toHaveLength(1)
    expect(requests('placeorder')[0]?.body).toEqual({
      strategy: 'Max Pain',
      exchange: 'NFO',
      symbol: CE,
      action: 'SELL',
      quantity: 150,
      pricetype: 'LIMIT',
      product: 'NRML',
      price: 120.5,
      trigger_price: 0,
      disclosed_quantity: 0,
      apikey: KEY,
    })
    // while it is on its way: a second tap sends nothing, Cancel and back do nothing
    await press('tool-held-confirm')
    expect(requests('placeorder')).toHaveLength(1)
    expect(disabled('tool-held-cancel')).toBe(true)
    expect(await hardwareBack()).toBe(true)
    expect(text('toast')).toBe(HOLD_COPY)
    expect(pushes('tool.back')).toEqual([])
    expect(r.reply).toBeNull()

    await act(async () => place.open(PLACED))
    await pass(50)
    expect(r.reply).toEqual({
      status: 200,
      body: { status: 'success', orderid: '250408000989443' },
    })
    expect(success).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    await pass(10_000)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('Cancel, the backdrop and Android back cancel a review; the page hears cancelled', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await setup()
    await openReady()
    const a = await placeorder()
    await press('tool-held-cancel')
    expect(a.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    const b = await placeorder()
    await press('sheet-backdrop')
    expect(b.reply?.status).toBe(400)
    const c = await placeorder()
    // the sheet takes Android's back first: the page is not asked, the stack does not pop
    expect(await hardwareBack()).toBe(true)
    expect(c.reply?.status).toBe(400)
    expect(pushes('tool.back')).toEqual([])
    expect(mockRouter.back).not.toHaveBeenCalled()
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('while sending the backdrop does nothing either (Android)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await press('sheet-backdrop')
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    expect(r.reply).toBeNull()
    await act(async () => place.open(PLACED))
    await pass(50)
    expect(r.reply?.status).toBe(200)
  })

  test('on Android the review hides while the app is locked and comes back as it was; a back on the cover cancels nothing', async () => {
    // an Android Modal is a window above the lock cover: its Place button would sit over "locked"
    jest.replaceProperty(Platform, 'OS', 'android')
    const s = await setup({}, { appLock: true })
    await openReady()
    const r = await placeorder()
    await pass(200)
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    await act(async () => {
      s.lock.handleAppState('background')
      s.lock.handleAppState('active')
    })
    await pass(20)
    expect(s.lock.isLocked()).toBe(true)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(screen.queryByTestId('tool-held-confirm')).toBeNull()
    expect(await hardwareBack()).toBe(true)
    expect(r.reply).toBeNull()
    await act(async () => {
      await s.lock.unlock()
    })
    await pass(200)
    expect(screen.getByTestId('tool-held-sheet')).toBeTruthy()
    expect(r.reply).toBeNull()
    await press('tool-held-confirm')
    await pass(50)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('held placeorder in LIVE with confirmLiveWrites asks biometrics; declined answers cancelled', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(3)
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    await setup()
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Confirm live order',
      disableDeviceFallback: false,
    })
    expect(r.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()

    // a check that fails, rather than the trader: the review stays, to try again
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
    const again = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(text('tool-held-notice')).toBe('Could not confirm with biometrics. Try again.')
    expect(again.reply).toBeNull()
    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(requests('placeorder')).toHaveLength(1)
    expect(again.reply?.status).toBe(200)
  })

  test('the page gives up during the live confirm: it hears cancelled, and the yes sends nothing', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(3)
    let yes: (r: { success: boolean }) => void = () => {}
    auth.authenticateAsync.mockReturnValueOnce(
      new Promise((resolve) => {
        yes = resolve
      }),
    )
    await setup()
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(1)
    r.abort()
    await pass(20)
    expect(r.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    await act(async () => yes({ success: true }))
    await pass(50)
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(text('toast')).toBe(WITHDRAWN)
  })

  test('held placeorder waits while a ticket order is out, and holds NEW_ORDER while it sends', async () => {
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    await openReady()
    const t = trading as Trading
    const ticket = {}
    const release = holdOrder(t, ticket)
    await placeorder()
    await pass(200)
    expect(text('tool-held-wait')).toMatch(/outcome isn't known yet/)
    expect(disabled('tool-held-confirm')).toBe(true)
    await act(async () => release())
    await pass(200)
    expect(screen.queryByTestId('tool-held-wait')).toBeNull()
    expect(disabled('tool-held-confirm')).toBe(false)

    await press('tool-held-confirm')
    expect(otherOrderOut(t, ticket)).toBe(true)
    await act(async () => place.open(PLACED))
    await pass(50)
    expect(otherOrderOut(t, ticket)).toBe(false)
  })

  test('held placeorder timeout: 502 CHECKING, a reconcile with the review snapshot knownIds, never a resend', async () => {
    await setup({
      'POST /api/v1/placeorder': () => new Promise<ScriptedReply>(() => {}),
      // an identical order placed at 09:30:00, before the review, is in the book and stays the
      // only one
      'POST /api/v1/orderbook': () => book([row('OLD1')]),
    })
    const warning = jest.spyOn(haptics, 'notifyWarning')
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    // the client gives up on the order after its 15 s
    await pass(15_100)
    expect(r.reply).toEqual({ status: 502, body: { status: 'error', message: CHECKING } })
    expect(warning).toHaveBeenCalledTimes(1)
    expect(text('tool-held-result')).toBe(CHECKING)
    expect(screen.getByTestId('tool-held-orderbook')).toBeTruthy()
    // the check reads past the server's 120 s broker timeout; the old order is not this one
    await pass(128_000)
    expect(text('tool-held-result')).toBe(
      'Not in the order book yet. The server may still be sending it, so check the order book before placing it again.',
    )
    expect(requests('placeorder')).toHaveLength(1)
    expect(screen.queryByTestId('tool-held-confirm')).toBeNull()
    await press('tool-held-orderbook')
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/orders?segment=all')
  })

  test('a throw while a sent order is handled still answers the page and frees the sheet; nothing is sent again', async () => {
    await setup({
      'POST /api/v1/placeorder': () => new Promise<ScriptedReply>(() => {}),
      'POST /api/v1/orderbook': () => book([]),
    })
    // a bug on the unknown-outcome path, after the send began and before the page was answered
    jest.spyOn(haptics, 'notifyWarning').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const warned = expectLog('warn', /\[tool\] held order: boom$/)
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(15_100)
    expect(warned).toHaveLength(1)
    // it may have gone: the page hears so, and the sheet says to check the order book
    expect(r.reply).toEqual({ status: 502, body: { status: 'error', message: CHECKING } })
    expect(text('tool-held-result')).toBe(NOT_CHECKED)
    expect(screen.getByTestId('tool-held-orderbook')).toBeTruthy()
    await press('tool-held-done')
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    await pass(130_000)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('a throw after the page was answered frees the sheet and never answers twice', async () => {
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    jest.spyOn(haptics, 'notifySuccess').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const warned = expectLog('warn', /\[tool\] held order: boom$/)
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await act(async () => place.open(PLACED))
    await pass(50)
    expect(warned).toHaveLength(1)
    expect(r.reply).toEqual({
      status: 200,
      body: { status: 'success', orderid: '250408000989443' },
    })
    expect(disabled('tool-held-done')).toBe(false)
    await press('tool-held-done')
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('liveSurprise shows LIVE_SURPRISE; semi_auto_blocked answers 403 with its message', async () => {
    const SEMI =
      'Place order operation is not allowed in Semi-Auto mode. Please use the Action Center.'
    let reply: ScriptedReply = ok({ status: 'success', orderid: 'L1' })
    await setup({
      'POST /api/v1/analyzer': analyzer('analyze'),
      'POST /api/v1/placeorder': () => reply,
    })
    useConnection.getState().set({ analyzer: 'analyze' })
    const error = jest.spyOn(haptics, 'notifyError')
    await openReady()
    const r = await placeorder()
    await pass(200)
    expect(text('tool-held-mode')).toBe('ANALYZE')
    await press('tool-held-confirm')
    await pass(50)
    expect(r.reply).toEqual({ status: 200, body: { status: 'success', orderid: 'L1' } })
    expect(text('live-surprise')).toBe(LIVE_SURPRISE)
    expect(error).toHaveBeenCalledTimes(1)
    await press('tool-held-done')
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()

    reply = { status: 403, body: { status: 'error', message: SEMI } }
    const blocked = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(blocked.reply).toEqual({ status: 403, body: { status: 'error', message: SEMI } })
    expect(error).toHaveBeenCalledTimes(2)
  })

  test('a queued order answers semi_auto with its pending id; a refusal answers its status', async () => {
    let reply: ScriptedReply = ok({
      status: 'success',
      message: 'Order queued for approval in Action Center',
      mode: 'semi_auto',
      pending_order_id: 42,
    })
    await setup({ 'POST /api/v1/placeorder': () => reply })
    await openReady()
    const q = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(q.reply).toEqual({
      status: 200,
      body: {
        status: 'success',
        mode: 'semi_auto',
        pending_order_id: '42',
        message: 'Queued for approval in the web Action Center',
      },
    })

    reply = { status: 400, body: { status: 'error', message: 'Invalid symbol' } }
    const refused = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    await pass(50)
    expect(refused.reply).toEqual({
      status: 400,
      body: { status: 'error', message: 'Invalid symbol' },
    })
  })

  test('the mode changed at confirm: nothing is sent, and the review shows again in the new mode', async () => {
    const changed = expectLog(
      'info',
      /\[orders\] place: the server is now in analyze mode, not sent$/,
    )
    let mode: 'live' | 'analyze' = 'live'
    await setup({ 'POST /api/v1/analyzer': () => analyzer(mode) })
    await openReady()
    const r = await placeorder()
    await pass(200)
    mode = 'analyze'
    await pass(6_000)
    await press('tool-held-confirm')
    await pass(50)
    expect(changed).toHaveLength(1)
    expect(requests('placeorder')).toHaveLength(0)
    expect(text('tool-held-notice')).toBe('The server is now in ANALYZE mode. Nothing was sent.')
    expect(text('tool-held-mode')).toBe('ANALYZE')
    expect(r.reply).toBeNull()
  })

  test('leaving during a confirmed send: never answered cancelled; the outcome is a toast', async () => {
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    await openReady()
    const r = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    expect(requests('placeorder')).toHaveLength(1)
    await leave()
    expect(text('toast')).toBe(STILL_SENDING)
    expect(r.reply).toBeNull()
    const t = trading as Trading
    // the pending scope holds until the outcome is known
    expect(otherOrderOut(t, {})).toBe(true)
    await act(async () => place.open(PLACED))
    await pass(50)
    expect(r.reply).toEqual({
      status: 200,
      body: { status: 'success', orderid: '250408000989443' },
    })
    expect(text('toast')).toBe('Order placed: 250408000989443')
    expect(otherOrderOut(t, {})).toBe(false)
  })

  test('held orders queue first in, first out; tool-held-queue counts the ones behind the shown one', async () => {
    const place = gate()
    await setup({ 'POST /api/v1/placeorder': place.route })
    await openReady()
    const a = await placeorder()
    await pass(200)
    expect(screen.queryByTestId('tool-held-queue')).toBeNull()
    const b = await placeorder({ ...ORDER, quantity: 75 })
    const c = await placeorder({ ...ORDER, quantity: 225, action: 'BUY' })
    // the first stays on the sheet; the others wait, unanswered and unsent
    expect(text('tool-held-summary')).toBe('LIMIT 2L (150) @ 120.50')
    expect(text('tool-held-queue')).toBe(heldQueueLine(2))
    expect(heldQueueLine(2)).toBe('2 more orders from this tool are waiting')
    expect(b.reply).toBeNull()
    expect(c.reply).toBeNull()

    // the first is cancelled: the second is shown, and one is still behind it
    await press('tool-held-cancel')
    await pass(200)
    expect(a.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(text('tool-held-summary')).toBe('LIMIT 1L (75) @ 120.50')
    expect(text('tool-held-queue')).toBe('1 more order from this tool is waiting')
    expect(heldQueueLine(1)).toBe('1 more order from this tool is waiting')

    // the second goes; while its outcome is out the third still waits behind it
    await press('tool-held-confirm')
    expect(requests('placeorder')).toHaveLength(1)
    expect(requests('placeorder')[0]?.body).toMatchObject({ quantity: 75, action: 'SELL' })
    expect(text('tool-held-queue')).toBe('1 more order from this tool is waiting')
    expect(c.reply).toBeNull()
    await act(async () => place.open(PLACED))
    await pass(200)
    expect(b.reply?.status).toBe(200)

    // the third has its own review, its own confirm: nothing sent for it yet
    expect(text('tool-held-summary')).toBe('LIMIT 3L (225) @ 120.50')
    expect(text('tool-held-confirm')).toBe('Place BUY order')
    expect(screen.queryByTestId('tool-held-queue')).toBeNull()
    expect(requests('placeorder')).toHaveLength(1)
    await press('tool-held-cancel')
    expect(c.reply?.status).toBe(400)
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('the outcome on show counts the next order, already first in the gateway, as waiting', async () => {
    await setup({ 'POST /api/v1/placeorder': () => new Promise<ScriptedReply>(() => {}) })
    await openReady()
    const a = await placeorder()
    await pass(200)
    await press('tool-held-confirm')
    const b = await placeorder({ ...ORDER, quantity: 75 })
    expect(text('tool-held-queue')).toBe('1 more order from this tool is waiting')
    // the client gives up after its 15 s: the check stays on the sheet, the next order waits
    await pass(15_100)
    expect(a.reply).toEqual({ status: 502, body: { status: 'error', message: CHECKING } })
    expect(screen.getByTestId('tool-held-result')).toBeTruthy()
    expect(text('tool-held-queue')).toBe('1 more order from this tool is waiting')
    expect(b.reply).toBeNull()
    await press('tool-held-done')
    await pass(200)
    expect(text('tool-held-summary')).toBe('LIMIT 1L (75) @ 120.50')
    expect(screen.queryByTestId('tool-held-queue')).toBeNull()
    await press('tool-held-cancel')
    expect(b.reply?.status).toBe(400)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('the page gives up before the send begins: it hears cancelled and nothing goes', async () => {
    await setup()
    await openReady()
    const r = await placeorder()
    await pass(200)
    r.abort()
    await pass(50)
    expect(r.reply).toEqual({ status: 400, body: { status: 'error', message: CANCELLED_COPY } })
    expect(screen.queryByTestId('tool-held-sheet')).toBeNull()
    expect(requests('placeorder')).toHaveLength(0)
  })
})
