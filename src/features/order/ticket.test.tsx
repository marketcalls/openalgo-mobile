import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import NewOrderRoute from '~/app/(app)/order/new'
import type { Capabilities } from '~/core/capabilities/gates'
import { usePrefs } from '~/core/config/prefs'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { ENDPOINTS } from '~/core/http/endpoints'
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
import { ticketHref } from '~/market/links'
import { type Trading, TradingProvider, useTrading } from '~/market/trading'
import type { TicketParams } from '~/market/types'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import margin from '../../../test/fixtures/openalgo-docs/margin.json'
import symbolNse from '../../../test/fixtures/openalgo-docs/symbol-nse.json'
import {
  type Route,
  type ScriptedReply,
  type ScriptedRequest,
  scriptedFetch,
} from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: () => true }))
const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }
let mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}))
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}))
const auth: { authenticateAsync: jest.Mock; getEnrolledLevelAsync: jest.Mock } = jest.requireMock(
  'expo-local-authentication',
)

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

/** No swagger list: whether splitorder and margin exist is unknown, so both are tried. */
const CAPS: Capabilities = {
  host: ORIGIN,
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: null,
  probed: {},
  fields: {},
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: T0,
}

const FUT = 'NIFTY30DEC26FUT'
const RELIANCE: TicketParams = { exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' }
const NIFTY_FUT: TicketParams = { exchange: 'NFO', symbol: FUT, action: 'BUY' }

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const PLACED = ok({ status: 'success', orderid: '250408000989443' })

/** `HH:MM:SS` IST, `sec` seconds from 09:30:00 (T0). */
const istTime = (sec: number) => {
  const at = 9 * 3600 + 30 * 60 + sec
  return [Math.floor(at / 3600), Math.floor(at / 60) % 60, at % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** An orderbook row as the stock server sends it, placed `sec` seconds after 09:30 IST. */
const row = (o: {
  orderid: string
  symbol?: string
  exchange?: string
  quantity: number
  status?: string
  sec?: number
}) => ({
  action: 'BUY',
  symbol: o.symbol ?? 'RELIANCE',
  exchange: o.exchange ?? 'NSE',
  orderid: o.orderid,
  product: o.exchange === 'NFO' ? 'NRML' : 'CNC',
  quantity: String(o.quantity),
  price: 0,
  pricetype: 'MARKET',
  order_status: o.status ?? 'open',
  trigger_price: 0,
  timestamp: `24-Nov-2026 ${istTime(o.sec ?? 0)}`,
})
const book = (rows: unknown[]) => ok({ status: 'success', data: { orders: rows, statistics: {} } })

const symbolReply = (req: ScriptedRequest): ScriptedReply => {
  const { symbol, exchange } = req.body as { symbol: string; exchange: string }
  if (symbol === 'GONE') {
    return {
      status: 404,
      body: { status: 'error', message: `Symbol GONE not found in exchange ${exchange}` },
    }
  }
  if (exchange === 'NFO') {
    return ok({
      status: 'success',
      data: { symbol, exchange, name: 'NIFTY', lotsize: 65, tick_size: 0.1, freeze_qty: 1800 },
    })
  }
  return ok({ ...symbolNse, data: { ...symbolNse.data, symbol, exchange } })
}

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/symbol': symbolReply,
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([]),
  'POST /api/v1/margin': ok(margin),
  'POST /api/v1/placeorder': PLACED,
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
let trading: Trading | undefined
const INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The real container over a scripted server; `live` opens the feed for a zerodha server. */
async function setup(routes: Record<string, Route> = {}, o: { live?: boolean } = {}) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  const sockets = fakeSockets()
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
  })
  await createProfileRepo(kv).save(PROFILE)
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
  const s = createServices(PROFILE, deps)
  services = s
  await s.caps.load()
  await s.lock.unlock()
  await pass(0)
  if (o.live) {
    sockets.last().serverOpen()
    sockets.last().serverSend(AUTH_OK)
    await pass(0)
  }
  return s
}

const Grab = () => {
  trading = useTrading()
  return null
}

const tree = (s: Services, n: number) => (
  <SafeAreaInsetsContext.Provider value={INSETS}>
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={s.queryClient}>
          <TickStoreContext.Provider value={s.store}>
            <LiveContext.Provider
              value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
            >
              <Grab />
              {/* one screen per open, as the stack gives each pushed ticket its own */}
              <NewOrderRoute key={n} />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  </SafeAreaInsetsContext.Provider>
)

/** The route params a link carries, as expo-router hands them to the screen. */
const paramsOf = (href: string) => Object.fromEntries(new URLSearchParams(href.split('?')[1]))

let view: { rerender: (el: React.ReactElement) => Promise<unknown> } | null = null
let opened = 0

/**
 * Opens `/order/new` with these route params and waits for the instrument's metadata. The
 * providers stay mounted from one open to the next, as the app shell's do: one session.
 */
async function openRaw(params: Record<string, string>) {
  if (!services) throw new Error('setup first')
  mockParams = params
  const el = tree(services, opened++)
  if (view) await view.rerender(el)
  else view = await render(el)
  await pass(10)
}

/** Opens the ticket a link to `p` opens. */
const open = (p: TicketParams) => openRaw(paramsOf(ticketHref(p)))

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(10)
}
const type = async (id: string, text: string) => {
  await fireEvent.changeText(screen.getByTestId(id), text)
}
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const bodyOf = (id: string, i = 0) => requests(id)[i]?.body as Record<string, unknown>
const selected = (id: string) => screen.getByTestId(id).props.accessibilityState?.selected
const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState?.disabled
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
/** The text an element shows, its descendants' included. */
const text = (id: string) => textOf(screen.getByTestId(id))

/** Edit → review, and the mode read and orderbook settle. */
const toReview = () => press('ticket-review')
const confirm = () => press('ticket-confirm')

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  mockParams = {}
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  // the http and order logs; console.error stays live, so a React error still shows
  for (const m of ['debug', 'info', 'warn'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
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

describe('edit', () => {
  test('from depth: the ask presets BUY LIMIT at its price; MARKET hides the price', async () => {
    await setup()
    // the depth screen's ask tap (features/depth levelTicket('ask', 1424.05, …))
    await open({ ...RELIANCE, action: 'BUY', pricetype: 'LIMIT', price: 1424.05 })
    expect(selected('ticket-side-buy')).toBe(true)
    expect(selected('ticket-side-sell')).toBe(false)
    expect(selected('ticket-type-LIMIT')).toBe(true)
    expect(screen.getByTestId('ticket-price').props.value).toBe('1424.05')
    // cash: MIS and CNC, CNC by default
    expect(selected('ticket-product-CNC')).toBe(true)
    expect(screen.queryByTestId('ticket-product-NRML')).toBeNull()

    await press('ticket-type-MARKET')
    expect(selected('ticket-type-MARKET')).toBe(true)
    expect(screen.queryByTestId('ticket-price')).toBeNull()
    expect(screen.queryByTestId('ticket-trigger')).toBeNull()
    expect(disabled('ticket-review')).toBe(false)
  })

  test('prices snap to the tick on blur; a LIMIT without a price cannot go to review', async () => {
    await setup()
    await open({ ...RELIANCE, pricetype: 'LIMIT' })
    expect(screen.getByText('Enter a price above 0.')).toBeTruthy()
    expect(disabled('ticket-review')).toBe(true)

    await type('ticket-price', '1424.03')
    await fireEvent(screen.getByTestId('ticket-price'), 'blur')
    expect(screen.getByTestId('ticket-price').props.value).toBe('1424.05')
    expect(screen.queryByText('Enter a price above 0.')).toBeNull()
    expect(disabled('ticket-review')).toBe(false)

    await press('ticket-type-SL-M')
    expect(screen.queryByTestId('ticket-price')).toBeNull()
    expect(screen.getByTestId('ticket-trigger')).toBeTruthy()
    expect(screen.getByText('Enter a trigger price above 0.')).toBeTruthy()
  })

  test('derivatives take lots and show the units; products are MIS and NRML', async () => {
    await setup()
    await open(NIFTY_FUT)
    expect(selected('ticket-product-NRML')).toBe(true)
    expect(screen.queryByTestId('ticket-product-CNC')).toBeNull()
    await type('ticket-qty', '3')
    expect(text('ticket-qty-units')).toBe('3 × 65 = 195')
  })

  test('an index or an unknown symbol shows only its issue text', async () => {
    await setup()
    await open({ exchange: 'NSE_INDEX', symbol: 'NIFTY', action: 'BUY' })
    expect(
      screen.getByText("Indices can't be traded. Open the futures or options contract instead."),
    ).toBeTruthy()
    expect(screen.queryByTestId('ticket-review')).toBeNull()
    expect(screen.queryByTestId('ticket-qty')).toBeNull()
    expect(requests('symbol')).toHaveLength(0)

    await open({ exchange: 'NFO', symbol: 'GONE', action: 'SELL' })
    expect(
      screen.getByText("This symbol isn't on the server's list (expired or misspelt)."),
    ).toBeTruthy()
    expect(screen.queryByTestId('ticket-review')).toBeNull()
    // neither takes a feed slot nor a quotes poll
    expect(requests('multiquotes')).toHaveLength(0)
  })

  test('metadata that cannot be read is an error with a retry', async () => {
    let up = false
    await setup({ 'POST /api/v1/symbol': (req) => (up ? symbolReply(req) : 'throw') })
    await open(RELIANCE)
    // the read's own two retries
    await pass(10_000)
    expect(
      screen.getByText("Can't reach the server. Check your connection and try again."),
    ).toBeTruthy()
    expect(screen.queryByTestId('ticket-qty')).toBeNull()
    up = true
    await fireEvent.press(screen.getByText('Try again'))
    await pass(10)
    expect(screen.getByTestId('ticket-qty')).toBeTruthy()
  })

  test('params that do not parse show that the link is incomplete', async () => {
    await setup()
    await openRaw({ exchange: 'NSE', action: 'BUY' })
    expect(screen.getByText('This order link is incomplete.')).toBeTruthy()
    expect(requests('symbol')).toHaveLength(0)
  })

  test('while the broker is logged out the banner shows and review is disabled', async () => {
    await setup()
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await open(RELIANCE)
    expect(screen.getByTestId('broker-banner-login')).toBeTruthy()
    expect(disabled('ticket-review')).toBe(true)
  })
})

describe('margin preview', () => {
  test('debounced: three edits within 600 ms make one call, shown as "Margin ≈ ₹x"', async () => {
    await setup()
    await open(RELIANCE)
    await type('ticket-qty', '2')
    await pass(100)
    await type('ticket-qty', '3')
    await pass(100)
    await type('ticket-qty', '4')
    await pass(599)
    expect(requests('margin')).toHaveLength(0)
    await pass(20)
    expect(requests('margin')).toHaveLength(1)
    expect(bodyOf('margin')).toMatchObject({
      positions: [{ symbol: 'RELIANCE', exchange: 'NSE', action: 'BUY', quantity: '4' }],
    })
    expect(text('ticket-margin')).toBe('Margin ≈ ₹91,555.76')
  })

  test('after a 501, no more margin calls that session and no margin line', async () => {
    await setup({
      'POST /api/v1/margin': {
        status: 501,
        body: { status: 'error', message: 'Margin calculation is not supported for this broker' },
      },
    })
    await open(RELIANCE)
    await pass(700)
    expect(requests('margin')).toHaveLength(1)
    expect(screen.queryByTestId('ticket-margin')).toBeNull()

    await type('ticket-qty', '5')
    await pass(700)
    expect(requests('margin')).toHaveLength(1)

    // another ticket in the same session
    await open(NIFTY_FUT)
    await type('ticket-qty', '2')
    await pass(700)
    expect(requests('margin')).toHaveLength(1)
    expect(screen.queryByTestId('ticket-margin')).toBeNull()
  })

  test('another error hides the line quietly, and the next edit asks again', async () => {
    await setup({ 'POST /api/v1/margin': { status: 500, body: { status: 'error', message: 'x' } } })
    await open(RELIANCE)
    await pass(700)
    expect(screen.queryByTestId('ticket-margin')).toBeNull()
    await type('ticket-qty', '2')
    await pass(700)
    expect(requests('margin')).toHaveLength(2)
  })
})

describe('review and send', () => {
  test('the body carries strategy mobile; a placed order shows its id; the badge reads LIVE', async () => {
    await setup()
    await open(RELIANCE)
    await toReview()
    expect(text('review-mode-badge')).toBe('LIVE')
    expect(screen.getByText('BUY MARKET 1 RELIANCE · CNC')).toBeTruthy()
    expect(text('ticket-confirm')).toBe('Place BUY order')
    await confirm()
    expect(requests('placeorder')).toHaveLength(1)
    expect(bodyOf('placeorder')).toEqual({
      apikey: KEY,
      strategy: 'mobile',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'BUY',
      quantity: 1,
      pricetype: 'MARKET',
      product: 'CNC',
      price: 0,
      trigger_price: 0,
      disclosed_quantity: 0,
    })
    expect(screen.getByTestId('order-result')).toBeTruthy()
    expect(screen.getByText('Order placed')).toBeTruthy()
    expect(screen.getByText('Order ID 250408000989443')).toBeTruthy()
    expect(screen.queryByText('Analyzer (sandbox)')).toBeNull()

    await press('ticket-done')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })

  test('an analyze reply shows "Analyzer (sandbox)"; the SELL confirm reads so', async () => {
    await setup({
      'POST /api/v1/analyzer': analyzer('analyze'),
      'POST /api/v1/placeorder': ok({ status: 'success', orderid: 'A1', mode: 'analyze' }),
    })
    await open({ ...RELIANCE, action: 'SELL' })
    await toReview()
    expect(text('review-mode-badge')).toBe('ANALYZE')
    expect(text('ticket-confirm')).toBe('Place SELL order')
    await confirm()
    expect(screen.getByText('Order placed')).toBeTruthy()
    expect(screen.getByText('Analyzer (sandbox)')).toBeTruthy()
  })

  test('back returns to the edit step with the ticket as it was', async () => {
    await setup()
    await open(RELIANCE)
    await type('ticket-qty', '7')
    await toReview()
    await press('ticket-back')
    expect(screen.getByTestId('ticket-qty').props.value).toBe('7')
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('single flight: a double tap on confirm sends one placeorder', async () => {
    let release = () => {}
    await setup({
      'POST /api/v1/placeorder': () =>
        new Promise<ScriptedReply>((resolve) => {
          release = () => resolve(PLACED)
        }),
    })
    await open(RELIANCE)
    await toReview()
    // Two taps before the screen re-renders, in one act (fireEvent's own acts would overlap):
    // Pressability's click handler is the press, as an accessibility tap delivers it.
    const tap = screen.getByTestId('ticket-confirm').props.onClick as (e: object) => void
    await act(async () => {
      tap({})
      tap({})
    })
    await pass(10)
    expect(requests('placeorder')).toHaveLength(1)
    // a tap while it is in flight does nothing either
    expect(disabled('ticket-confirm')).toBe(true)
    await act(async () => release())
    await pass(200)
    expect(screen.getByText('Order placed')).toBeTruthy()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('the mode changed since the review: nothing is sent, and the review shows the new mode', async () => {
    let mode: 'live' | 'analyze' = 'analyze'
    await setup({ 'POST /api/v1/analyzer': () => analyzer(mode) })
    await open(RELIANCE)
    await toReview()
    expect(text('review-mode-badge')).toBe('ANALYZE')
    mode = 'live'
    // the gate's reading is older than 5 s
    await pass(6_000)
    await confirm()
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.getByText('The server is now in LIVE mode. Review again.')).toBeTruthy()
    expect(text('review-mode-badge')).toBe('LIVE')
    // confirm stays disabled through the 120 ms cooldown
    expect(disabled('ticket-confirm')).toBe(true)
    await pass(120)
    expect(disabled('ticket-confirm')).toBe(false)
    await confirm()
    expect(requests('placeorder')).toHaveLength(1)
    expect(screen.getByText('Order placed')).toBeTruthy()
  })

  test('a stop the LTP has crossed since the review goes back to edit, unsent', async () => {
    await setup()
    const ltp = (n: number) =>
      act(async () => {
        services?.store.put('NSE:RELIANCE', { ltp: n }, 'poll')
        await jest.advanceTimersByTimeAsync(20)
      })
    await open({ ...RELIANCE, pricetype: 'SL-M' })
    await ltp(1400)
    expect(text('ticket-ltp')).toBe('LTP 1,400.00')
    await type('ticket-trigger', '1450')
    await toReview()
    await ltp(1460)
    await confirm()
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.getByText('BUY stop must be above LTP 1,460.00.')).toBeTruthy()
    expect(disabled('ticket-review')).toBe(true)
  })

  test('a refusal shows the server message back on the edit step', async () => {
    await setup({
      'POST /api/v1/placeorder': {
        status: 400,
        body: { status: 'error', message: 'Quantity must be a multiple of the lot size' },
      },
    })
    await open(RELIANCE)
    await toReview()
    await confirm()
    expect(screen.getByText('Quantity must be a multiple of the lot size')).toBeTruthy()
    expect(screen.getByTestId('ticket-review')).toBeTruthy()
    expect(screen.queryByTestId('order-result')).toBeNull()
  })
})

describe('biometrics', () => {
  test('live with confirmLiveWrites on asks "Confirm live order"; a failure sends nothing', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(3)
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    await setup()
    await open(RELIANCE)
    await toReview()
    await confirm()
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Confirm live order',
      disableDeviceFallback: false,
    })
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.getByTestId('ticket-confirm')).toBeTruthy()

    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
    await pass(200)
    await confirm()
    expect(requests('placeorder')).toHaveLength(0)
    expect(screen.getByText('Could not confirm with biometrics. Try again.')).toBeTruthy()

    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    await pass(200)
    await confirm()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('in analyzer mode there is no prompt', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    await setup({ 'POST /api/v1/analyzer': analyzer('analyze') })
    await open(RELIANCE)
    await toReview()
    await confirm()
    expect(auth.authenticateAsync).not.toHaveBeenCalled()
    expect(requests('placeorder')).toHaveLength(1)
  })
})

describe('split orders', () => {
  test('28 lots: the split note, the review "1,755 + 65", one splitorder, "1 of 2 placed"', async () => {
    await setup({
      'POST /api/v1/splitorder': ok({
        status: 'success',
        total_quantity: 1820,
        split_size: 1755,
        results: [
          { order_num: 1, quantity: 1755, status: 'success', orderid: 'S1' },
          { order_num: 2, quantity: 65, status: 'error', message: 'Order rejected by the broker' },
        ],
      }),
    })
    await open(NIFTY_FUT)
    await type('ticket-qty', '28')
    expect(text('ticket-qty-units')).toBe('28 × 65 = 1,820')
    expect(screen.getByText('Sent as 2 orders (freeze limit 1,800)')).toBeTruthy()

    await toReview()
    expect(text('review-split')).toContain('1,755 + 65')
    await confirm()
    expect(requests('placeorder')).toHaveLength(0)
    expect(requests('splitorder')).toHaveLength(1)
    expect(bodyOf('splitorder')).toMatchObject({
      strategy: 'mobile',
      exchange: 'NFO',
      symbol: FUT,
      quantity: 1820,
      product: 'NRML',
      splitsize: 1755,
    })
    expect(screen.getByTestId('split-child-1')).toBeTruthy()
    expect(screen.getByTestId('split-child-2')).toBeTruthy()
    expect(screen.getByText('Order rejected by the broker')).toBeTruthy()
    expect(screen.getByText('1 of 2 placed')).toBeTruthy()
    expect(screen.getByTestId('view-orderbook')).toBeTruthy()
    // no way to send the failed child again
    for (const id of ['ticket-confirm', 'ticket-review', 'ticket-back']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    await press('view-orderbook')
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/orders')
  })

  test('a split timeout reconciles: "Found 2 of 2 child orders", never "probably not placed"', async () => {
    let sent = false
    await setup({
      'POST /api/v1/splitorder': () => {
        sent = true
        return new Promise<never>(() => {})
      },
      'POST /api/v1/orderbook': () =>
        book(
          sent
            ? [
                row({ orderid: 'C2', symbol: FUT, exchange: 'NFO', quantity: 65, sec: 2 }),
                row({ orderid: 'C1', symbol: FUT, exchange: 'NFO', quantity: 1755, sec: 1 }),
              ]
            : [],
        ),
    })
    await open(NIFTY_FUT)
    await type('ticket-qty', '28')
    await toReview()
    await confirm()
    await pass(ENDPOINTS.splitorder.timeoutMs)
    expect(screen.getByText('Status unknown: checking order book')).toBeTruthy()
    await pass(2_100)
    expect(screen.getByText('Found 2 of 2 child orders in the order book.')).toBeTruthy()
    expect(screen.queryByText(/probably not placed/)).toBeNull()
    expect(screen.getByTestId('view-orderbook')).toBeTruthy()
    expect(screen.queryByTestId('ticket-confirm')).toBeNull()
    expect(requests('splitorder')).toHaveLength(1)
  })
})

describe('status unknown', () => {
  const NOT_FOUND =
    'Not found in the order book. It was probably not placed. Check the order book before trying again.'

  test.each<[string, ScriptedReply]>([
    ['a 502 page', { status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' }],
    ['a 500 error', { status: 500, body: { status: 'error', message: 'Broker timed out' } }],
    ['a success without an id', ok({ status: 'success' })],
  ])('%s: "Status unknown", then the reconcile finds it open', async (_name, reply) => {
    let sent = false
    await setup({
      'POST /api/v1/placeorder': () => {
        sent = true
        return reply
      },
      'POST /api/v1/orderbook': () =>
        book(sent ? [row({ orderid: 'N1', quantity: 1, status: 'open', sec: 1 })] : []),
    })
    await open(RELIANCE)
    await toReview()
    await confirm()
    expect(screen.getByText('Status unknown: checking order book')).toBeTruthy()
    expect(screen.queryByText(/Found in the order book/)).toBeNull()
    await pass(2_100)
    expect(screen.getByText('Found in the order book: open')).toBeTruthy()
    expect(screen.getByTestId('view-orderbook')).toBeTruthy()
    // never a plain resend (rulings 5)
    for (const id of ['ticket-confirm', 'ticket-review', 'ticket-back']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('an identical order already in the book is not reported as found (ruling 26)', async () => {
    await setup({
      'POST /api/v1/placeorder': { status: 502, contentType: 'text/html', body: 'Bad Gateway' },
      // a strategy's order 30 s before, the same contract, side, product and quantity
      'POST /api/v1/orderbook': book([row({ orderid: 'OLD1', quantity: 1, sec: -30 })]),
    })
    await open(RELIANCE)
    await toReview()
    await confirm()
    await pass(2_100 + 5_000 + 10_000)
    expect(screen.queryByText(/Found in the order book/)).toBeNull()
    expect(screen.getByText(NOT_FOUND)).toBeTruthy()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('a book that cannot be read says so, never "probably not placed"', async () => {
    let sent = false
    await setup({
      'POST /api/v1/placeorder': () => {
        sent = true
        return { status: 502, contentType: 'text/html', body: 'Bad Gateway' }
      },
      'POST /api/v1/orderbook': () => (sent ? 'throw' : book([])),
    })
    await open(RELIANCE)
    await toReview()
    await confirm()
    await pass(2_100 + 5_000 + 10_000)
    expect(
      screen.getByText("Couldn't check the order book. Check it before trying again."),
    ).toBeTruthy()
    expect(screen.queryByText(/probably not placed/)).toBeNull()
  })
})

describe('Semi-Auto', () => {
  test('a queued reply shows the queued copy, the link opens the Action Center', async () => {
    await setup({
      'POST /api/v1/placeorder': ok({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 12,
      }),
    })
    await open(RELIANCE)
    await toReview()
    await confirm()
    expect(screen.getByText('Queued for approval in the web Action Center')).toBeTruthy()
    expect(screen.queryByText('Order placed')).toBeNull()
    expect(useConnection.getState().semiAutoSeen).toBe(true)
    await press('open-action-center')
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/action-center`)
  })
})

describe('order events', () => {
  test('a placed order with zerodha live is handed to eventWatch.expect', async () => {
    await setup({}, { live: true })
    await open(RELIANCE)
    const spy = jest.spyOn((trading as Trading).eventWatch, 'expect')
    await toReview()
    await confirm()
    expect(spy).toHaveBeenCalledWith('250408000989443')
  })

  test('with the feed not live it is not', async () => {
    await setup()
    await open(RELIANCE)
    const spy = jest.spyOn((trading as Trading).eventWatch, 'expect')
    await toReview()
    await confirm()
    expect(screen.getByText('Order placed')).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })
})
