import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
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
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { type BasketLeg, type BasketSpec, LEGGING_RISK } from '~/market/orders/basket'
import { CHECKING } from '~/market/orders/outcome'
import { liveSurpriseText } from '~/market/orders/submit'
import { TradingProvider } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import { tokens } from '~/ui/tokens'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import margin from '../../../test/fixtures/openalgo-docs/margin.json'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import {
  type Route,
  type ScriptedReply,
  type ScriptedRequest,
  scriptedFetch,
} from '../../../test/helpers/fakeFetch'
import { fakeSockets } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { BasketReview, legLabel } from './components/BasketReview'
import type { BasketOutcome } from './hooks/useBasketSubmit'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: () => true }))
const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePreventRemove: () => {},
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
// A Tuesday, 09:30 IST: NFO is open.
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

const CE = 'NIFTY01DEC2624500CE'
const PE = 'NIFTY01DEC2624500PE'
const leg = (o: Partial<BasketLeg> = {}): BasketLeg => ({
  symbol: CE,
  exchange: 'NFO',
  action: 'SELL',
  quantity: 75,
  pricetype: 'LIMIT',
  product: 'NRML',
  price: 120.5,
  trigger_price: 0,
  disclosed_quantity: 0,
  ...o,
})
/** A short straddle, as Strategy Builder holds it. */
const STRADDLE: BasketSpec = {
  endpoint: 'basketorder',
  strategy: 'Short Straddle',
  legs: [leg(), leg({ symbol: PE, price: 98.25 })],
}

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const book = (rows: unknown[]) => ok({ status: 'success', data: { orders: rows, statistics: {} } })
/** An orderbook row as the stock server sends it, placed `sec` seconds after 09:30 IST. */
const row = (orderid: string, symbol: string, sec = 0) => ({
  action: 'SELL',
  symbol,
  exchange: 'NFO',
  orderid,
  product: 'NRML',
  quantity: '75',
  price: 120.5,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: `24-Nov-2026 09:3${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`,
})
/** The sandbox's reply: SELL legs in completion order, each tagged. */
const sandboxReply = (results: unknown[]) => ok({ status: 'success', mode: 'analyze', results })
const placedLeg = (symbol: string, orderid: string) => ({
  symbol,
  exchange: 'NFO',
  product: 'NRML',
  status: 'success',
  orderid,
})
const symbolReply = (req: ScriptedRequest): ScriptedReply => {
  const { symbol, exchange } = req.body as { symbol: string; exchange: string }
  if (symbol.startsWith('GONE')) {
    return {
      status: 404,
      body: { status: 'error', message: `Symbol ${symbol} not found in exchange ${exchange}` },
    }
  }
  return ok({
    status: 'success',
    data: { symbol, exchange, name: 'NIFTY', lotsize: 75, tick_size: 0.05, freeze_qty: 1800 },
  })
}

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('analyze'),
  'POST /api/v1/symbol': symbolReply,
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([]),
  'POST /api/v1/margin': ok(margin),
  'POST /api/v1/basketorder': sandboxReply([placedLeg(PE, '1002'), placedLeg(CE, '1001')]),
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
const INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }
const outcomes: BasketOutcome[] = []
const onClose = jest.fn()

async function setup(routes: Record<string, Route> = {}) {
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
  // the unlock's own book refresh (a 500 ms debounce) goes before the review opens
  await pass(600)
  return s
}

/** The review as a host shows it: the outcomes it hears are kept, in order. */
async function review(spec: BasketSpec = STRADDLE) {
  if (!services) throw new Error('setup first')
  const s = services
  await render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ServicesProvider value={s}>
        <TradingProvider now={Date.now}>
          <QueryClientProvider client={s.queryClient}>
            <TickStoreContext.Provider value={s.store}>
              <LiveContext.Provider
                value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
              >
                <BasketReview
                  spec={spec}
                  title={spec.strategy}
                  onOutcome={(o) => outcomes.push(o)}
                  onClose={onClose}
                />
                <ToastHost />
              </LiveContext.Provider>
            </TickStoreContext.Provider>
          </QueryClientProvider>
        </TradingProvider>
      </ServicesProvider>
    </SafeAreaInsetsContext.Provider>,
  )
  // the mode read and the review's book read land
  await pass(200)
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(20)
}
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState?.disabled
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
const text = (id: string) => textOf(screen.getByTestId(id))
/** A route the test settles: still out until then. */
function gate() {
  let open: (r: ScriptedReply) => void = () => {}
  const promise = new Promise<ScriptedReply>((resolve) => {
    open = resolve
  })
  return { route: () => promise, open }
}

const HARNESS_LOGS = {
  info: / INFO \[(http\] \w+ (\d{3}|failed|timeout) \d+ms|ws\] state \w+)$/,
  warn: / WARN \[ws\] no auth_ok in time$/,
  debug: / DEBUG \[ws\] (→ \w+|← \w+)$/,
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  outcomes.length = 0
  keepExpectedLogs(HARNESS_LOGS)
})
afterEach(async () => {
  await cleanup()
  if (services) disposeServices(services)
  services = null
  jest.clearAllMocks()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

test('the review shows each leg in its side colour, the net credit, the ANALYZE badge and the legging warning', async () => {
  await setup()
  await review()
  // the head: the strategy, its one mode badge, and what the legs share
  expect(text('basket-title')).toBe('Short Straddle')
  expect(text('basket-mode-badge')).toBe('ANALYZE')
  expect(screen.getAllByText('ANALYZE')).toHaveLength(1)
  expect(text('basket-meta')).toBe('NFO · NRML · LIMIT')
  // Kite leg rows: the side in its colour, the readable contract, lots, the price with its type
  expect(text('basket-leg-side-1')).toBe('SELL')
  expect(screen.getByTestId('basket-leg-side-1')).toHaveStyle({ color: tokens.trade.dark.sell })
  const first = text('basket-leg-1')
  for (const part of ['NIFTY 01 DEC 24500 CE', 'NFO', '75 · 1 lot', 'LMT 120.50']) {
    expect(first).toContain(part)
  }
  expect(screen.getByLabelText('Sell 75 NIFTY 01 DEC 24500 CE, limit 120.50')).toBeTruthy()
  expect(text('basket-leg-2')).toContain('24500 PE')
  // the net is neutral text: a credit here, (120.50 + 98.25) × 75
  expect(text('basket-net')).toBe('Net credit ₹16,406.25')
  expect(screen.getByTestId('basket-net')).toHaveStyle({ color: tokens.dark.foreground })
  // one margin call with every leg
  expect(requests('margin')).toHaveLength(1)
  expect(requests('margin')[0]?.body).toMatchObject({
    positions: [
      { symbol: CE, action: 'SELL', quantity: '75', price: '120.5' },
      { symbol: PE, action: 'SELL', quantity: '75', price: '98.25' },
    ],
  })
  expect(text('basket-margin')).toBe('Margin ≈ ₹91,555.76')
  expect(text('basket-legging')).toContain(LEGGING_RISK)
  // confirm is neutral and counts what it sends; it sits in the footer, never in the legs' scroll
  expect(text('basket-confirm')).toBe('Place 2 orders')
  expect(screen.getByTestId('basket-confirm')).toHaveStyle({ backgroundColor: tokens.dark.primary })
  expect(disabled('basket-confirm')).toBe(false)
  expect(within(screen.getByTestId('basket-legs')).queryByTestId('basket-confirm')).toBeNull()
  expect(within(screen.getByTestId('basket-footer')).getByTestId('basket-confirm')).toBeTruthy()
  expect(requests('basketorder')).toHaveLength(0)
})

test('one leg: no legging warning, "Place 1 order"; a MARKET leg with no LTP yet leaves the net at market', async () => {
  await setup()
  await review({ ...STRADDLE, legs: [leg({ pricetype: 'MARKET', price: 0, action: 'BUY' })] })
  expect(screen.queryByTestId('basket-legging')).toBeNull()
  expect(text('basket-confirm')).toBe('Place 1 order')
  expect(text('basket-leg-1')).toContain('MKT')
  expect(text('basket-net')).toBe('Net premium at market (1 leg at market)')
  expect(screen.getByTestId('basket-leg-side-1')).toHaveStyle({ color: tokens.trade.dark.buy })
})

test('twelve legs: confirm stays in the footer, outside the scrolling legs', async () => {
  await setup()
  const legs = Array.from({ length: 12 }, (_, i) =>
    leg({ symbol: `NIFTY01DEC26${24000 + i * 50}CE`, action: i % 2 ? 'BUY' : 'SELL' }),
  )
  await review({ ...STRADDLE, legs })
  const scroll = within(screen.getByTestId('basket-legs'))
  expect(scroll.getByTestId('basket-leg-12')).toBeTruthy()
  expect(scroll.queryByTestId('basket-confirm')).toBeNull()
  expect(text('basket-meta')).toBe('NFO · NRML · LIMIT')
  expect(text('basket-confirm')).toBe('Place 12 orders')
  // each leg's metadata read is paced by the read lane: they all land before the test ends
  await pass(10_000)
  expect(requests('symbol')).toHaveLength(12)
  expect(text('basket-leg-12')).toContain('75 · 1 lot')
})

test('confirm sends basketorder once after a mode read; a second tap or Back while sending does nothing', async () => {
  const basket = gate()
  await setup({ 'POST /api/v1/basketorder': basket.route })
  const success = jest.spyOn(haptics, 'notifySuccess')
  await review()
  // the review's reading is 5 s old by the confirm: the mode is read again before the send
  await pass(6_000)
  const reads = requests('analyzer').length
  await press('basket-confirm')
  expect(requests('analyzer')).toHaveLength(reads + 1)
  expect(requests('basketorder')).toHaveLength(1)
  expect(requests('basketorder')[0]?.body).toEqual({
    strategy: 'Short Straddle',
    orders: [
      {
        symbol: CE,
        exchange: 'NFO',
        action: 'SELL',
        quantity: 75,
        pricetype: 'LIMIT',
        product: 'NRML',
        price: 120.5,
        trigger_price: 0,
        disclosed_quantity: 0,
      },
      {
        symbol: PE,
        exchange: 'NFO',
        action: 'SELL',
        quantity: 75,
        pricetype: 'LIMIT',
        product: 'NRML',
        price: 98.25,
        trigger_price: 0,
        disclosed_quantity: 0,
      },
    ],
    apikey: KEY,
  })
  // while it is on its way: confirm says so, a second tap sends nothing, Back does nothing
  expect(text('basket-confirm')).toBe('Placing…')
  await press('basket-confirm')
  expect(disabled('basket-back')).toBe(true)
  await press('basket-back')
  expect(onClose).not.toHaveBeenCalled()
  expect(requests('basketorder')).toHaveLength(1)
  expect(outcomes).toEqual([])

  await act(async () => basket.open(sandboxReply([placedLeg(PE, '1002'), placedLeg(CE, '1001')])))
  await pass(50)
  expect(text('basket-result-text')).toBe('Sandbox · 2 of 2 legs placed')
  expect(text('basket-result-leg-1')).toBe('Placed · #1001')
  expect(text('basket-result-leg-2')).toBe('Placed · #1002')
  expect(success).toHaveBeenCalledTimes(1)
  expect(outcomes).toEqual([
    {
      kind: 'placed',
      legs: [
        { leg: 0, state: 'placed', orderid: '1001' },
        { leg: 1, state: 'placed', orderid: '1002' },
      ],
      analyze: true,
      raw: {
        status: 'success',
        mode: 'analyze',
        results: [placedLeg(PE, '1002'), placedLeg(CE, '1001')],
      },
    },
  ])
  // nothing offers a resend; Done closes
  expect(screen.queryByTestId('basket-confirm')).toBeNull()
  await press('basket-done')
  expect(onClose).toHaveBeenCalledTimes(1)
  await pass(10_000)
  expect(requests('basketorder')).toHaveLength(1)
})

test('LIVE with confirmLiveWrites asks biometrics; declined → cancelled and nothing sent', async () => {
  usePrefs.setState({ confirmLiveWrites: true })
  auth.getEnrolledLevelAsync.mockResolvedValue(3)
  auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
  await setup({ 'POST /api/v1/analyzer': analyzer('live') })
  await review()
  expect(text('basket-mode-badge')).toBe('LIVE')
  await press('basket-confirm')
  await pass(50)
  expect(auth.authenticateAsync).toHaveBeenCalledWith({
    promptMessage: 'Confirm live order',
    disableDeviceFallback: false,
  })
  expect(outcomes).toEqual([{ kind: 'cancelled' }])
  expect(requests('basketorder')).toHaveLength(0)
  // the review shows again, to confirm or go back, once the guard's cooldown is over
  await pass(200)
  expect(disabled('basket-confirm')).toBe(false)

  // a check that fails, rather than the trader, says why
  auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
  await press('basket-confirm')
  await pass(50)
  expect(text('basket-notice')).toBe('Could not confirm with biometrics. Try again.')
  expect(requests('basketorder')).toHaveLength(0)
})

test('partial success lists placed and failed legs and offers View in order book, never a resend (RF 1)', async () => {
  await setup({
    'POST /api/v1/basketorder': sandboxReply([
      { symbol: PE, status: 'error', message: 'Insufficient funds' },
      placedLeg(CE, '1001'),
    ]),
  })
  const warning = jest.spyOn(haptics, 'notifyWarning')
  await review()
  await press('basket-confirm')
  await pass(50)
  expect(text('basket-result-text')).toBe('Sandbox · 1 of 2 legs placed')
  expect(text('basket-result-leg-1')).toBe('Placed · #1001')
  expect(text('basket-result-leg-2')).toBe('Failed · Insufficient funds')
  expect(warning).toHaveBeenCalledTimes(1)
  // the order book is the way on, first; nothing sends the failed leg again
  const buttons = within(screen.getByTestId('basket-footer')).getAllByRole('button')
  expect(buttons[0]?.props.testID).toBe('basket-view-orders')
  expect(screen.queryByText(/retry|resend|again/i)).toBeNull()
  expect(screen.queryByTestId('basket-confirm')).toBeNull()
  await press('basket-view-orders')
  expect(mockRouter.dismissTo).toHaveBeenCalledWith('/orders?segment=all')
  expect(requests('basketorder')).toHaveLength(1)
})

test('timeout: CHECKING, reconcileBasket with the review knownIds, found legs shown, no resend (RF 1)', async () => {
  let sent = false
  await setup({
    'POST /api/v1/basketorder': () => {
      sent = true
      return new Promise<ScriptedReply>(() => {})
    },
    // an identical CE order placed before the review is in the book; after the send the CE leg
    // shows up, the PE leg never does
    'POST /api/v1/orderbook': () =>
      book(sent ? [row('N1', CE, 40), row('OLD1', CE)] : [row('OLD1', CE)]),
  })
  const warning = jest.spyOn(haptics, 'notifyWarning')
  await review()
  await press('basket-confirm')
  // the client gives up on the basket after its 30 s
  await pass(30_100)
  expect(text('basket-result-text')).toBe(CHECKING)
  expect(text('basket-result-leg-1')).toBe('Unclear · check the order book')
  expect(text('basket-wait')).toMatch(/reads the order book for up to 2 minutes/)
  expect(warning).toHaveBeenCalledTimes(1)
  expect(outcomes).toEqual([
    { kind: 'checking', found: null, checked: false, earlier: false, waitSec: 127 },
  ])
  // the check reads past the server's 120 s broker timeout; the old order is not this one
  await pass(128_000)
  expect(text('basket-result-leg-1')).toBe('Placed · #N1')
  expect(text('basket-result-leg-2')).toBe('Missing · check the order book')
  expect(text('basket-result-text')).toBe(
    'Found 1 of 2 legs in the order book. The server may still be sending the rest, so check the order book before placing any again.',
  )
  expect(outcomes).toHaveLength(2)
  expect(outcomes[1]).toMatchObject({ kind: 'checking', checked: true, earlier: false })
  expect(screen.getByTestId('basket-view-orders')).toBeTruthy()
  expect(screen.queryByTestId('basket-confirm')).toBeNull()
  expect(requests('basketorder')).toHaveLength(1)
})

test('mode changed after the review: nothing sent, the review shows again', async () => {
  const changed = expectLog(
    'info',
    /\[orders\] basket: the server is now in analyze mode, not sent$/,
  )
  let mode: 'live' | 'analyze' = 'live'
  await setup({ 'POST /api/v1/analyzer': () => analyzer(mode) })
  await review()
  expect(text('basket-mode-badge')).toBe('LIVE')
  mode = 'analyze'
  await pass(6_000)
  await press('basket-confirm')
  await pass(50)
  expect(changed).toHaveLength(1)
  expect(requests('basketorder')).toHaveLength(0)
  expect(outcomes).toEqual([{ kind: 'mode_changed', now: 'analyze' }])
  expect(text('basket-notice')).toBe('The server is now in ANALYZE mode. Nothing was sent.')
  expect(text('basket-mode-badge')).toBe('ANALYZE')
  // it reads the new mode's book before confirm can send again
  await pass(200)
  expect(disabled('basket-confirm')).toBe(false)
})

test('an ANALYZE review with an untagged reply shows the LIVE notice', async () => {
  await setup({
    'POST /api/v1/basketorder': ok({
      status: 'success',
      results: [placedLeg(PE, 'L2'), placedLeg(CE, 'L1')],
    }),
  })
  const error = jest.spyOn(haptics, 'notifyError')
  const warned = expectLog(
    'warn',
    /\[orders\] basket: the review showed ANALYZE, but the server answered LIVE$/,
  )
  await review()
  expect(text('basket-mode-badge')).toBe('ANALYZE')
  await press('basket-confirm')
  await pass(50)
  expect(warned).toHaveLength(1)
  expect(text('live-surprise')).toBe(liveSurpriseText('basket'))
  expect(liveSurpriseText('basket')).toBe(
    'This basket was placed in LIVE mode. The server switched to LIVE after your review.',
  )
  // a LIVE result has no sandbox mark
  expect(text('basket-result-text')).toBe('2 of 2 legs placed')
  expect(error).toHaveBeenCalledTimes(1)
  expect(outcomes[0]).toMatchObject({ kind: 'placed', analyze: false, liveSurprise: true })
})

test('a queued basket shows the Action Center; a Semi-Auto refusal shows its message and the same link', async () => {
  const SEMI =
    'Basket order operation is not allowed in Semi-Auto mode. Please use the Action Center.'
  let reply: ScriptedReply = ok({
    status: 'success',
    mode: 'semi_auto',
    pending_order_id: 7,
    message: 'Order queued for approval in Action Center',
  })
  await setup({ 'POST /api/v1/basketorder': () => reply })
  const warning = jest.spyOn(haptics, 'notifyWarning')
  await review()
  await press('basket-confirm')
  await pass(50)
  expect(text('basket-result-text')).toBe(QUEUED_COPY)
  expect(screen.getByTestId('basket-action-center')).toBeTruthy()
  expect(screen.queryByTestId('basket-result-leg-1')).toBeNull()
  expect(warning).toHaveBeenCalledTimes(1)
  expect(outcomes).toEqual([{ kind: 'queued', pendingId: '7', message: QUEUED_COPY }])
  await cleanup()

  reply = { status: 403, body: { status: 'error', message: SEMI } }
  outcomes.length = 0
  await review()
  await press('basket-confirm')
  await pass(50)
  expect(text('basket-result-text')).toBe(SEMI)
  expect(screen.getByTestId('basket-action-center')).toBeTruthy()
  expect(outcomes).toEqual([{ kind: 'semi_auto_blocked', message: SEMI, status: 403 }])
})

test('legLabel reads an option and a future as a trader does, and keeps anything else as sent', () => {
  expect(legLabel(CE)).toBe('NIFTY 01 DEC 24500 CE')
  expect(legLabel('BANKNIFTY30DEC2652500.5PE')).toBe('BANKNIFTY 30 DEC 52500.5 PE')
  expect(legLabel('CRUDEOIL19DEC26FUT')).toBe('CRUDEOIL 19 DEC FUT')
  expect(legLabel('M&M30DEC26FUT')).toBe('M&M 30 DEC FUT')
  expect(legLabel('RELIANCE')).toBe('RELIANCE')
  expect(legLabel('NIFTY01XYZ26FUT')).toBe('NIFTY01XYZ26FUT')
})

test('a leg this server does not know holds confirm, and the review says why', async () => {
  await setup()
  await review({ ...STRADDLE, legs: [leg(), leg({ symbol: 'GONE01DEC2624500PE' })] })
  await pass(1_000)
  expect(text('basket-leg-2')).toContain('NFO · Expired or unknown')
  expect(disabled('basket-confirm')).toBe(true)
  expect(text('basket-reason')).toBe(
    'A leg is expired or unknown here, so the basket cannot be sent.',
  )
  await press('basket-confirm')
  expect(requests('basketorder')).toHaveLength(0)
})
