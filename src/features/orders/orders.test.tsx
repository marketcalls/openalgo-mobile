import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert, type AlertButton, Linking } from 'react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import OrdersTab from '~/app/(app)/(tabs)/orders'
import ModifyOrderRoute from '~/app/(app)/order/[id]/modify'
import type { Capabilities } from '~/core/capabilities/gates'
import { usePrefs } from '~/core/config/prefs'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
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
import { BrokerBanner } from '~/market/components/SessionBanners'
import { TradingProvider } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import symbolNse from '../../../test/fixtures/openalgo-docs/symbol-nse.json'
import trades from '../../../test/fixtures/openalgo-docs/tradebook.json'
import {
  type Route,
  type ScriptedReply,
  type ScriptedRequest,
  scriptedFetch,
} from '../../../test/helpers/fakeFetch'
import { fakeSockets } from '../../../test/helpers/fakeSocket'
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

const ORIGIN = 'https://algo.example.com'
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
// A Tuesday, 09:30 IST: NSE and NFO are open.
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const FUT = 'NIFTY30DEC26FUT'

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
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: T0,
}

/** Today's metadata for the future, as the instrument cache stores it: 65 a lot. */
const FUT_META = {
  exchange: 'NFO',
  symbol: FUT,
  name: 'NIFTY',
  lotsize: 65,
  tick: 0.1,
  freezeQty: 1800,
  instrumenttype: 'FUT',
  expiry: '30-DEC-26',
  strike: null,
  quoteOnly: false,
  lots: true,
}

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const BAD_GATEWAY: ScriptedReply = { status: 502, contentType: 'text/html', body: 'Bad Gateway' }

const CANCEL_SEMI_AUTO =
  'Cancel order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.'

/** An orderbook row as the stock server sends it; a key set to undefined is left out. */
const order = (o: Record<string, unknown> = {}) => ({
  action: 'BUY',
  symbol: 'YESBANK',
  exchange: 'NSE',
  orderid: 'A1',
  product: 'MIS',
  quantity: '1',
  price: 16.5,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '24-Nov-2026 09:30:00',
  ...o,
})
const book = (rows: unknown[], statistics: Record<string, unknown> = {}) =>
  ok({ status: 'success', data: { orders: rows, statistics } })

const symbolReply = (req: ScriptedRequest): ScriptedReply => {
  const { symbol, exchange } = req.body as { symbol: string; exchange: string }
  return ok({ ...symbolNse, data: { ...symbolNse.data, symbol, exchange } })
}

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/symbol': symbolReply,
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([order()]),
  'POST /api/v1/tradebook': ok(trades),
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
const INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The real container over a scripted server; the instrument cache already knows the future. */
async function setup(routes: Record<string, Route> = {}) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
    [`oa.${PID}.instruments`]: JSON.stringify({
      day: '2026-11-24',
      items: [FUT_META],
      unknown: [],
    }),
  })
  await createProfileRepo(kv).save(PROFILE)
  const deps: AppDeps = {
    fetch: fetchFake,
    WebSocketImpl: fakeSockets().WebSocketImpl,
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
  // the unlock's own book refresh (a 500 ms debounce) goes before any screen reads a book
  await pass(600)
  return s
}

type Shown = 'orders' | 'modify'

/** The app shell: the Orders tab under the tabs layout's own broker banner (ruling 9). */
const tree = (s: Services, shown: readonly Shown[]) => (
  <SafeAreaInsetsContext.Provider value={INSETS}>
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={s.queryClient}>
          <TickStoreContext.Provider value={s.store}>
            <LiveContext.Provider
              value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
            >
              {shown.includes('orders') ? (
                <>
                  <BrokerBanner />
                  <OrdersTab />
                </>
              ) : null}
              {shown.includes('modify') ? <ModifyOrderRoute /> : null}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  </SafeAreaInsetsContext.Provider>
)

let view: { rerender: (el: React.ReactElement) => Promise<unknown> } | null = null

/** Shows these screens; the providers stay mounted from one call to the next (one session). */
async function show(shown: readonly Shown[]) {
  if (!services) throw new Error('setup first')
  const el = tree(services, shown)
  if (view) await view.rerender(el)
  else view = await render(el)
  await pass(10)
}

/** The modify sheet for `id` over the Orders tab, as the stack shows it. */
async function openModify(id: string, o: { alone?: boolean } = {}) {
  mockParams = { id }
  await show(o.alone ? ['modify'] : ['orders', 'modify'])
  // the reads it makes wait their turn in the read bucket
  await pass(1_000)
}

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
  await fireEvent(screen.getByTestId(id), 'blur')
}
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const bodyOf = (id: string, i = 0) => requests(id)[i]?.body as Record<string, unknown>
const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState?.disabled
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
/** The text an element shows, its descendants' included. */
const text = (id: string) => textOf(screen.getByTestId(id))
/** The order rows on screen, top to bottom. */
const rowIds = () =>
  screen
    .queryAllByTestId(/^order-row-/)
    .map((n) => String(n.props.testID).slice('order-row-'.length))

/** Each native confirm asked: its title and body, answered with `answer`. */
let asked: { title: string; body?: string; ok?: string }[] = []
let answer = true

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  mockParams = {}
  asked = []
  answer = true
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  jest.spyOn(Alert, 'alert').mockImplementation((title, body, buttons?: AlertButton[]) => {
    asked.push({ title: String(title), body: body ?? undefined, ok: buttons?.[1]?.text })
    const b = buttons?.find((x) => (answer ? x.style !== 'cancel' : x.style === 'cancel'))
    b?.onPress?.()
  })
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
  jest.clearAllMocks()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('the books', () => {
  const BOOK = book(
    [
      order({ orderid: 'A1', timestamp: '24-Nov-2026 09:30:00' }),
      order({
        orderid: 'C1',
        order_status: 'complete',
        pricetype: 'MARKET',
        price: 16.6,
        timestamp: '24-Nov-2026 09:31:00',
      }),
      order({
        orderid: 'T1',
        action: 'SELL',
        order_status: 'Trigger Pending',
        pricetype: 'SL',
        price: 16,
        trigger_price: 16.1,
        timestamp: '24-Nov-2026 09:32:00',
      }),
    ],
    {
      total_buy_orders: 2,
      total_sell_orders: 1,
      total_completed_orders: 1,
      total_open_orders: 2,
      total_rejected_orders: 0,
    },
  )

  test('Open lists the working rows, All every row newest first; the header shows the statistics', async () => {
    await setup({ 'POST /api/v1/orderbook': BOOK })
    await show(['orders'])
    expect(screen.getByTestId('orders-seg-open').props.accessibilityState?.selected).toBe(true)
    expect(rowIds()).toEqual(['T1', 'A1'])
    expect(text('orders-stats')).toBe('Open 2 · Completed 1 · Rejected 0 · Buy 2 · Sell 1')

    const a1 = screen.getByTestId('order-row-A1')
    for (const part of ['YESBANK', 'NSE', 'BUY', 'LIMIT', 'MIS']) {
      expect(a1).toHaveTextContent(new RegExp(part))
    }
    expect(text('order-qty-A1')).toBe('1')
    expect(text('order-price-A1')).toBe('16.50')
    expect(text('order-status-A1')).toBe('Open')
    expect(text('order-time-A1')).toBe('09:30:00')
    // the side in its colour, the stop with its trigger
    expect(screen.getByTestId('order-side-A1')).toHaveStyle({ color: '#00a63e' })
    expect(screen.getByTestId('order-side-T1')).toHaveStyle({ color: '#e7000b' })
    expect(text('order-price-T1')).toBe('16.00 / trg 16.10')
    expect(text('order-status-T1')).toBe('Trigger pending')

    await press('orders-seg-all')
    expect(rowIds()).toEqual(['T1', 'C1', 'A1'])
    expect(text('order-status-C1')).toBe('Complete')
  })

  test('Trades lists the tradebook', async () => {
    await setup()
    await show(['orders'])
    expect(requests('tradebook')).toHaveLength(0)
    await press('orders-seg-trades')
    expect(requests('tradebook')).toHaveLength(1)
    const row = screen.getByTestId('trade-row-250408001086129')
    for (const part of ['NHPC', 'SELL', '83.74', 'MIS', '14:28:49']) {
      expect(row).toHaveTextContent(new RegExp(part))
    }
    expect(screen.getByTestId('trade-row-250408000989443')).toHaveTextContent(/RELIANCE/)
  })

  test('a derivative quantity shows in lots when the instrument is known', async () => {
    await setup({
      'POST /api/v1/orderbook': book([
        order({ orderid: 'F1', exchange: 'NFO', symbol: FUT, product: 'NRML', quantity: '130' }),
        order({ orderid: 'F2', exchange: 'NFO', symbol: 'NIFTY30DEC2624000CE', quantity: '130' }),
      ]),
    })
    await show(['orders'])
    expect(text('order-qty-F1')).toBe('2L (130)')
    // not in the cache: units, and no /symbol call for a row
    expect(text('order-qty-F2')).toBe('130')
    expect(requests('symbol')).toHaveLength(0)
  })

  test('the empty states', async () => {
    await setup({
      'POST /api/v1/orderbook': book([]),
      'POST /api/v1/tradebook': ok({ status: 'success', data: [] }),
    })
    await show(['orders'])
    expect(screen.getByText('No open orders')).toBeTruthy()
    await press('orders-seg-all')
    expect(screen.getByText('No orders today')).toBeTruthy()
    await press('orders-seg-trades')
    expect(screen.getByText('No trades today')).toBeTruthy()
  })

  test('(RF 4) a row without an orderid is dropped and counted; a missing price shows --', async () => {
    await setup({
      'POST /api/v1/orderbook': book([
        order({ orderid: undefined }),
        order({ orderid: 'A2', price: undefined, timestamp: '2026-11-24 09:30:00' }),
      ]),
    })
    await show(['orders'])
    expect(text('books-dropped')).toBe('1 row could not be read')
    expect(rowIds()).toEqual(['A2'])
    expect(text('order-price-A2')).toBe('--')
    // a timestamp in another format still gives its time
    expect(text('order-time-A2')).toBe('09:30:00')
  })

  test('a book that cannot be read is an error with a retry', async () => {
    let up = false
    await setup({ 'POST /api/v1/orderbook': () => (up ? book([order()]) : 'throw') })
    await show(['orders'])
    // the read's own two retries
    await pass(10_000)
    expect(
      screen.getByText("Can't reach the server. Check your connection and try again."),
    ).toBeTruthy()
    up = true
    await fireEvent.press(screen.getByText('Try again'))
    await pass(10)
    expect(rowIds()).toEqual(['A1'])
  })
})

describe('row actions', () => {
  test('a trigger pending row in Open has Modify and Cancel; a complete row has neither', async () => {
    await setup({
      'POST /api/v1/orderbook': book([
        order({ orderid: 'T1', order_status: 'Trigger Pending', pricetype: 'SL-M' }),
        order({ orderid: 'C1', order_status: 'complete' }),
      ]),
    })
    await show(['orders'])
    expect(screen.queryByTestId('order-modify')).toBeNull()
    await press('order-row-T1')
    expect(screen.getByTestId('order-modify')).toBeTruthy()
    expect(screen.getByTestId('order-cancel')).toBeTruthy()
    expect(screen.getByTestId('order-depth')).toBeTruthy()
    expect(screen.getByTestId('order-chart')).toBeTruthy()

    await press('orders-seg-all')
    await press('order-row-C1')
    expect(screen.queryByTestId('order-modify')).toBeNull()
    expect(screen.queryByTestId('order-cancel')).toBeNull()
    await press('order-depth')
    expect(mockRouter.push).toHaveBeenLastCalledWith('/depth/NSE%3AYESBANK')
    await press('order-chart')
    expect(mockRouter.push).toHaveBeenLastCalledWith('/chart/NSE%3AYESBANK')
  })

  test('Modify opens the modify sheet for the row', async () => {
    await setup()
    await show(['orders'])
    await press('order-row-A1')
    await press('order-modify')
    expect(mockRouter.push).toHaveBeenCalledWith('/order/A1/modify')
  })
})

describe('cancel', () => {
  test('confirm "LIVE · Cancel this order?" with the row; it sends {orderid, strategy:"mobile"}', async () => {
    await setup({ 'POST /api/v1/cancelorder': ok({ status: 'success', orderid: 'A1' }) })
    await show(['orders'])
    await press('order-row-A1')

    answer = false
    await press('order-cancel')
    expect(asked).toEqual([
      {
        title: 'LIVE · Cancel this order?',
        body: 'BUY LIMIT 1 YESBANK @ 16.50 · MIS',
        ok: 'Cancel order',
      },
    ])
    expect(requests('cancelorder')).toHaveLength(0)

    answer = true
    await pass(200)
    await press('order-cancel')
    expect(requests('cancelorder')).toHaveLength(1)
    expect(bodyOf('cancelorder')).toEqual({ apikey: KEY, orderid: 'A1', strategy: 'mobile' })
    expect(text('toast')).toBe('Order cancelled')
  })

  test('in analyzer mode the confirm title starts with ANALYZE', async () => {
    await setup({
      'POST /api/v1/analyzer': analyzer('analyze'),
      'POST /api/v1/cancelorder': ok({ status: 'success', orderid: 'A1', mode: 'analyze' }),
    })
    await show(['orders'])
    await press('order-row-A1')
    await press('order-cancel')
    expect(asked[0]?.title).toMatch(/^ANALYZE/)
    expect(requests('cancelorder')).toHaveLength(1)
  })

  test('a 502: the order book is checked, and the row shows its new status', async () => {
    let cancelled = false
    await setup({
      'POST /api/v1/orderbook': () =>
        book([order({ order_status: cancelled ? 'cancelled' : 'open' })]),
      'POST /api/v1/cancelorder': () => {
        cancelled = true
        return BAD_GATEWAY
      },
    })
    await show(['orders'])
    await press('order-row-A1')
    await press('order-cancel')
    expect(text('toast')).toBe('Status unknown: checking order book')
    const before = requests('orderbook').length
    await pass(2_100)
    expect(requests('orderbook').length).toBeGreaterThan(before)
    expect(text('toast')).toBe('Order status: cancelled')
    expect(requests('cancelorder')).toHaveLength(1)
    // gone from Open; All shows its status
    expect(rowIds()).toEqual([])
    await press('orders-seg-all')
    expect(text('order-status-A1')).toBe('Cancelled')
  })

  test('a Semi-Auto 403 shows the server reason and the Action Center link', async () => {
    await setup({
      'POST /api/v1/cancelorder': {
        status: 403,
        body: { status: 'error', message: CANCEL_SEMI_AUTO },
      },
    })
    await show(['orders'])
    await press('order-row-A1')
    await press('order-cancel')
    expect(screen.getByTestId('banner-semi-auto-blocked')).toHaveTextContent(CANCEL_SEMI_AUTO, {
      exact: false,
    })
    expect(useConnection.getState().semiAutoSeen).toBe(true)
    // the standing Semi-Auto note hides while it shows (ruling 21)
    expect(screen.queryByTestId('banner-semi-auto')).toBeNull()
    expect(screen.queryByTestId('open-action-center')).toBeNull()
    await press('blocked-open-action-center')
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/action-center`)
  })

  test('once Semi-Auto has been seen, the standing banner shows', async () => {
    useConnection.getState().set({ semiAutoSeen: true })
    await setup()
    await show(['orders'])
    expect(screen.getByTestId('banner-semi-auto')).toHaveTextContent(
      /Orders need approval in the web Action Center/,
    )
  })
})

describe('cancel all', () => {
  const twoOpen = () =>
    book([
      order({ orderid: 'A1' }),
      order({ orderid: 'A2', symbol: 'ITC' }),
      order({ orderid: 'C1', order_status: 'complete' }),
    ])

  test('with 2 open orders the confirm names 2; the reply shows "Cancelled 2. Failed 0."', async () => {
    await setup({
      'POST /api/v1/orderbook': twoOpen(),
      'POST /api/v1/cancelallorder': ok({
        status: 'success',
        message: 'Canceled 2 orders. Failed to cancel 0 orders.',
        canceled_orders: ['A1', 'A2'],
        failed_cancellations: [],
      }),
    })
    await show(['orders'])
    expect(text('orders-cancel-all')).toBe('Cancel all (2)')
    await press('orders-cancel-all')
    expect(asked).toEqual([
      {
        title: 'LIVE · Cancel all 2 open orders?',
        body: 'This cancels every open order in the account, including ones placed by strategies or the web.',
        ok: 'Cancel all',
      },
    ])
    expect(bodyOf('cancelallorder')).toEqual({ apikey: KEY, strategy: 'mobile' })
    expect(text('toast')).toBe('Cancelled 2. Failed 0.')
  })

  test('a 502 refetches the order book: "Status unknown. 2 orders still open."', async () => {
    await setup({
      'POST /api/v1/orderbook': twoOpen(),
      'POST /api/v1/cancelallorder': BAD_GATEWAY,
    })
    await show(['orders'])
    await press('orders-cancel-all')
    expect(text('toast')).toBe('Status unknown: checking order book')
    await pass(2_100)
    expect(text('toast')).toBe('Status unknown. 2 orders still open.')
    expect(requests('cancelallorder')).toHaveLength(1)
  })

  test('disabled with no open orders', async () => {
    await setup({ 'POST /api/v1/orderbook': book([order({ order_status: 'complete' })]) })
    await show(['orders'])
    expect(text('orders-cancel-all')).toBe('Cancel all (0)')
    expect(disabled('orders-cancel-all')).toBe(true)
  })
})

describe('modify', () => {
  test("the body is the row's 12 C3 fields with only the price changed; done toasts and closes", async () => {
    await setup({ 'POST /api/v1/modifyorder': ok({ status: 'success', orderid: 'A1' }) })
    await show(['orders'])
    await openModify('A1')
    // the row came from the cache
    expect(requests('orderbook')).toHaveLength(1)
    expect(text('modify-mode-badge')).toBe('LIVE')
    expect(screen.getByTestId('modify-price').props.value).toBe('16.5')
    await type('modify-price', '17')
    await press('modify-confirm')
    expect(requests('modifyorder')).toHaveLength(1)
    const sent = bodyOf('modifyorder')
    expect(sent).toEqual({
      apikey: KEY,
      orderid: 'A1',
      strategy: 'mobile',
      symbol: 'YESBANK',
      action: 'BUY',
      exchange: 'NSE',
      pricetype: 'LIMIT',
      product: 'MIS',
      quantity: 1,
      price: 17,
      trigger_price: 0,
      disclosed_quantity: 0,
    })
    expect(Object.keys(sent)).toHaveLength(12)
    expect(text('toast')).toBe('Order modified')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })

  test('a 400 keeps the sheet open with the message', async () => {
    await setup({
      'POST /api/v1/modifyorder': {
        status: 400,
        body: { status: 'error', message: 'Price is outside the circuit limits' },
      },
    })
    await show(['orders'])
    await openModify('A1')
    await type('modify-price', '17')
    await press('modify-confirm')
    expect(text('modify-error')).toBe('Price is outside the circuit limits')
    expect(screen.getByTestId('modify-confirm')).toBeTruthy()
    expect(mockRouter.back).not.toHaveBeenCalled()
  })

  test('a derivative takes lots; the mode reads ANALYZE in analyzer mode', async () => {
    await setup({
      'POST /api/v1/analyzer': analyzer('analyze'),
      'POST /api/v1/orderbook': book([
        order({
          orderid: 'F1',
          exchange: 'NFO',
          symbol: FUT,
          product: 'NRML',
          quantity: '130',
          price: 24100,
        }),
      ]),
      'POST /api/v1/modifyorder': ok({ status: 'success', orderid: 'F1', mode: 'analyze' }),
    })
    await show(['orders'])
    await openModify('F1')
    expect(text('modify-mode-badge')).toBe('ANALYZE')
    expect(screen.getByTestId('modify-qty').props.value).toBe('2')
    expect(text('modify-qty-units')).toBe('2 × 65 = 130')
    await type('modify-qty', '3')
    await press('modify-confirm')
    expect(bodyOf('modifyorder')).toMatchObject({ quantity: 195, price: 24100, product: 'NRML' })
  })

  test('a LIMIT row whose price could not be read cannot be sent until a price is given', async () => {
    await setup({ 'POST /api/v1/orderbook': book([order({ price: undefined })]) })
    await show(['orders'])
    await openModify('A1')
    expect(screen.getByText('Enter a price above 0.')).toBeTruthy()
    expect(disabled('modify-confirm')).toBe(true)
    await type('modify-price', '16.55')
    expect(disabled('modify-confirm')).toBe(false)
  })

  test('the row is read once when the cache lacks it; still missing says so', async () => {
    await setup({ 'POST /api/v1/orderbook': book([order({ orderid: 'A1' })]) })
    await openModify('A1', { alone: true })
    expect(requests('orderbook')).toHaveLength(1)
    expect(screen.getByTestId('modify-confirm')).toBeTruthy()
    await cleanup()
    view = null

    await openModify('GONE', { alone: true })
    expect(requests('orderbook')).toHaveLength(2)
    expect(screen.getByText('This order is no longer open.')).toBeTruthy()
    expect(screen.queryByTestId('modify-confirm')).toBeNull()
  })

  test('a 502: the sheet checks the order book and shows the status, never sending again', async () => {
    let modified = false
    await setup({
      'POST /api/v1/orderbook': () => book([order({ price: modified ? 17 : 16.5 })]),
      'POST /api/v1/modifyorder': () => {
        modified = true
        return BAD_GATEWAY
      },
    })
    await show(['orders'])
    await openModify('A1')
    await type('modify-price', '17')
    await press('modify-confirm')
    expect(text('modify-check')).toBe('Status unknown: checking order book')
    await pass(2_100)
    expect(text('modify-check')).toBe('Order status: open')
    expect(screen.queryByTestId('modify-confirm')).toBeNull()
    expect(requests('modifyorder')).toHaveLength(1)
    await press('modify-done')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })

  test('a Semi-Auto 403 on modify shows the reason and the Action Center link', async () => {
    const text403 =
      'Modify order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to modify orders.'
    await setup({
      'POST /api/v1/modifyorder': { status: 403, body: { status: 'error', message: text403 } },
    })
    await openModify('A1', { alone: true })
    await type('modify-price', '17')
    await press('modify-confirm')
    expect(screen.getByTestId('banner-semi-auto-blocked')).toHaveTextContent(text403, {
      exact: false,
    })
    expect(screen.getByTestId('blocked-open-action-center')).toBeTruthy()
    expect(screen.getByTestId('modify-confirm')).toBeTruthy()
  })
})

describe('logged out', () => {
  test('the banner shows, the rows are dimmed, StaleNote shows, and no orderbook call in 60 s', async () => {
    await setup()
    await show(['orders'])
    expect(requests('orderbook')).toHaveLength(1)
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await pass(10)
    // one banner: the tabs layout's (ruling 9)
    expect(screen.getAllByTestId('banner-broker')).toHaveLength(1)
    expect(screen.getByTestId('broker-banner-login')).toBeTruthy()
    expect(screen.getByTestId('orders-list')).toHaveStyle({ opacity: 0.5 })
    expect(text('stale-note')).toBe('Last updated 09:30:00')
    expect(rowIds()).toEqual(['A1'])
    expect(disabled('orders-cancel-all')).toBe(true)
    await press('order-row-A1')
    expect(disabled('order-cancel')).toBe(true)
    expect(disabled('order-modify')).toBe(true)
    await pass(60_000)
    expect(requests('orderbook')).toHaveLength(1)
  })

  test('a refetch that fails keeps the rows, dimmed, with StaleNote', async () => {
    let up = true
    await setup({ 'POST /api/v1/orderbook': () => (up ? book([order()]) : 'throw') })
    await show(['orders'])
    expect(screen.queryByTestId('stale-note')).toBeNull()
    up = false
    await act(async () => services?.books.poke())
    // the debounce, then the read and its two retries
    await pass(10_000)
    expect(rowIds()).toEqual(['A1'])
    expect(screen.getByTestId('stale-note')).toBeTruthy()
    expect(screen.getByTestId('orders-list')).toHaveStyle({ opacity: 0.5 })
  })
})

describe('order events', () => {
  test('a bus order_update refetches the orderbook once, after 500 ms', async () => {
    await setup()
    await show(['orders'])
    expect(requests('orderbook')).toHaveLength(1)
    await act(async () =>
      services?.orderEvents.emit({
        t: 'order_update',
        user_id: 'u1',
        mode: 'live',
        broker: 'zerodha',
        orderid: 'A1',
        symbol: 'YESBANK',
        exchange: 'NSE',
        action: 'BUY',
        quantity: 1,
        price: 16.5,
        trigger_price: 0,
        pricetype: 'LIMIT',
        product: 'MIS',
        order_status: 'complete',
        filled_quantity: 1,
        pending_quantity: 0,
        average_price: 16.5,
        rejection_reason: '',
      }),
    )
    await pass(480)
    expect(requests('orderbook')).toHaveLength(1)
    await pass(30)
    expect(requests('orderbook')).toHaveLength(2)
    await pass(1_000)
    expect(requests('orderbook')).toHaveLength(2)
  })
})
