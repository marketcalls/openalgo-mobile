import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert, type AlertButton, Linking } from 'react-native'
import type { Capabilities } from '~/core/capabilities/gates'
import { usePrefs } from '~/core/config/prefs'
import * as haptics from '~/core/platform/haptics'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { ENDPOINTS } from '~/core/http/endpoints'
import { useConnection } from '~/core/services/connection'
import {
  type AppDeps,
  createServices,
  disposeServices,
  type Services,
  ServicesProvider,
} from '~/core/services/services'
import type { ChartIntent, ChartMeta, Inst } from '~/dom/bridge/protocol'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { OutcomeLine } from '~/market/components/OutcomeLine'
import { SemiAutoBanner, SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { CLOSE_OUT } from '~/features/portfolio'
import {
  ALL_POSITIONS,
  holdOrder,
  NEW_ORDER,
  onPosition,
  takeUnseenOutcome,
} from '~/market/orders/pending'
import { PLACED_REJECTED } from '~/market/orders/placedStatus'
import { liveSurpriseText } from '~/market/orders/submit'
import { QUOTE_ONLY_COPY } from '~/market/orders/ticket'
import { type Trading, TradingProvider, useTrading } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { NO_POSITION, NOT_OPEN, useChartIntents, WRONG_SYMBOL } from './hooks/useChartIntents'
import { ABOVE_FREEZE, EARLIER_OUT, MODE_UNKNOWN, ONE_TAP_BUSY } from './hooks/useOneTap'

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useIsFocused: () => true,
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
  features: {},
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: T0,
}

/** Today's metadata, as the instrument cache stores it. */
const RELIANCE_META: InstrumentMeta = {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  name: 'RELIANCE INDUSTRIES',
  lotsize: 1,
  tick: 0.05,
  freezeQty: 0,
  instrumenttype: 'EQ',
  expiry: null,
  strike: null,
  quoteOnly: false,
  lots: false,
}
const FUT_META: InstrumentMeta = {
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
/** An index: a price and nothing to trade. */
const NIFTY_META: InstrumentMeta = {
  exchange: 'NSE_INDEX',
  symbol: 'NIFTY',
  name: 'NIFTY 50',
  lotsize: 1,
  tick: 0.05,
  freezeQty: 0,
  instrumenttype: 'INDEX',
  expiry: null,
  strike: null,
  quoteOnly: true,
  lots: false,
}
/** What the chart screen pushes to the page for an instrument (and passes to the intents). */
const chartMeta = (m: InstrumentMeta): ChartMeta => ({
  exchange: m.exchange,
  symbol: m.symbol,
  tick: m.tick,
  lotsize: m.lotsize,
  lots: m.lots,
  quoteOnly: m.quoteOnly,
  freezeQty: m.freezeQty,
})
const RELIANCE: Inst = { exchange: 'NSE', symbol: 'RELIANCE' }
const NIFTY_FUT: Inst = { exchange: 'NFO', symbol: FUT }
const INFY: Inst = { exchange: 'NSE', symbol: 'INFY' }
const NIFTY: Inst = { exchange: 'NSE_INDEX', symbol: 'NIFTY' }

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const PLACED = ok({ status: 'success', orderid: '250408000989443' })
const NOT_YET =
  'Not in the order book yet. The server may still be sending it, so check the order book before placing it again.'

/** An orderbook row as the stock server sends it; a key set to undefined is left out. */
const order = (o: Record<string, unknown> = {}) => ({
  action: 'BUY',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  orderid: 'A1',
  product: 'CNC',
  quantity: '1',
  price: 1400,
  pricetype: 'LIMIT',
  order_status: 'open',
  trigger_price: 0,
  timestamp: '24-Nov-2026 09:30:00',
  ...o,
})
const book = (rows: unknown[]) => ok({ status: 'success', data: { orders: rows, statistics: {} } })
const position = (o: Record<string, unknown> = {}) => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  product: 'CNC',
  quantity: '10',
  average_price: '1398.5',
  ...o,
})
const positions = (rows: unknown[]) => ok({ status: 'success', data: rows })

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/orderbook': book([]),
  'POST /api/v1/positionbook': positions([]),
  'POST /api/v1/tradebook': ok({ status: 'success', data: [] }),
  'POST /api/v1/placeorder': PLACED,
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
let sockets = fakeSockets()
let trading: Trading | undefined
/** The instrument the chart shows; a symbol intent (T14) changes it at once. */
let current: Inst = RELIANCE
let ltpNow: number | null = 1400
let redraws = 0
let chart: ReturnType<typeof useChartIntents> | null = null
const viewOrderbook = jest.fn()

/** The real container over a scripted server; the instrument cache knows both contracts. */
async function setup(routes: Record<string, Route> = {}, o: { live?: boolean } = {}) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  sockets = fakeSockets()
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
    [`oa.${PID}.instruments`]: JSON.stringify({
      day: '2026-11-24',
      items: [RELIANCE_META, FUT_META, NIFTY_META],
      unknown: [],
    }),
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
  // the unlock's own book refresh (a 500 ms debounce) goes before the chart reads a book
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

const Grab = () => {
  trading = useTrading()
  return null
}

/** The chart screen's use of the intents: its notices as on Orders, and the sheet. */
function Chart({ meta }: { meta: ChartMeta | null }) {
  const c = useChartIntents({
    current: () => current,
    meta,
    ltp: () => ltpNow,
    redraw: () => {
      redraws++
    },
  })
  chart = c
  return (
    <>
      {c.liveSurprise ? (
        <LiveSurpriseNotice text={c.liveSurprise} onDismiss={c.dismissLiveSurprise} />
      ) : null}
      {c.semiBlocked ? <SemiAutoBlockedBanner message={c.semiBlocked} /> : <SemiAutoBanner />}
      {c.outcome ? (
        <OutcomeLine
          outcome={c.outcome}
          onDismiss={c.dismissOutcome}
          onViewOrderbook={viewOrderbook}
        />
      ) : null}
      {c.sheet}
    </>
  )
}

/** `meta` undefined: the chart has gone (Back), the session stays. */
const tree = (s: Services, meta: ChartMeta | null | undefined) => (
  <ServicesProvider value={s}>
    <TradingProvider now={Date.now}>
      <QueryClientProvider client={s.queryClient}>
        <Grab />
        {meta === undefined ? null : <Chart meta={meta} />}
        <ToastHost />
      </QueryClientProvider>
    </TradingProvider>
  </ServicesProvider>
)

let view: { rerender: (el: React.ReactElement) => Promise<unknown> } | null = null

/** The chart on `inst`, with its metadata (`null`: not loaded yet); one session throughout. */
async function show(inst: Inst, meta: ChartMeta | null) {
  if (!services) throw new Error('setup first')
  current = inst
  const el = tree(services, meta)
  if (view) await view.rerender(el)
  else view = await render(el)
  await pass(10)
}

/** What the page posts: one intent over the bridge. */
async function send(intent: ChartIntent) {
  await act(async () => chart?.onIntent({ v: 1, kind: 'intent', intent }))
  await pass(10)
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(10)
}
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const bodyOf = (id: string, i = 0) => requests(id)[i]?.body as Record<string, unknown>
/** The endpoints called, in order. */
const sentOrder = () => fetchFake.calls.map((c) => c.url.split('/api/v1/')[1] ?? c.url)
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
/** The text an element shows, its descendants' included. */
const text = (id: string) => textOf(screen.getByTestId(id))
const toast = () => text('toast')
/** The sheet's native modal, which tells the app once iOS has dismissed it. */
const sheetModal = () => {
  const m = screen.container.queryAll((n) => typeof n.props.onDismiss === 'function')[0]
  if (!m) throw new Error('no sheet')
  return m.props as { onDismiss: () => void }
}

/**
 * The log lines every test here makes over the real services container: the http client's line
 * for each request, and the feed's over the fake socket.
 */
const HARNESS_LOGS = {
  info: / INFO \[(http\] \w+ (\d{3}|failed|timeout) \d+ms|ws\] state \w+)$/,
  warn: / WARN \[ws\] no auth_ok in time$/,
  debug: / DEBUG \[ws\] (→ authenticate|← auth_ok)$/,
}

/** Each native confirm asked; `answer` true confirms, false dismisses, null leaves it up. */
let asked: { title: string; body?: string; ok?: string }[] = []
let answer: boolean | null = true

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false, chartOneTap: false })
  current = RELIANCE
  ltpNow = 1400
  redraws = 0
  chart = null
  asked = []
  answer = true
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  jest.spyOn(Alert, 'alert').mockImplementation((title, body, buttons?: AlertButton[]) => {
    asked.push({ title: String(title), body: body ?? undefined, ok: buttons?.[1]?.text })
    if (answer === null) return
    const b = buttons?.find((x) => (answer ? x.style !== 'cancel' : x.style === 'cancel'))
    b?.onPress?.()
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

describe('intents', () => {
  test('BUY opens the ticket at market with lots in units and source chart', async () => {
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await send({ inst: RELIANCE, type: 'trade', side: 'BUY', lots: 3 })
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      '/order/new?exchange=NSE&symbol=RELIANCE&action=BUY&pricetype=MARKET&quantity=3&source=chart',
    )
    // a derivative's lots go as units: 2 lots of 65
    await show(NIFTY_FUT, chartMeta(FUT_META))
    await send({ inst: NIFTY_FUT, type: 'trade', side: 'SELL', lots: 2 })
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      `/order/new?exchange=NFO&symbol=${FUT}&action=SELL&pricetype=MARKET&quantity=130&source=chart`,
    )
    // the depth button opens the depth screen
    await send({ inst: NIFTY_FUT, type: 'depth' })
    expect(mockRouter.push).toHaveBeenLastCalledWith(`/depth/NFO%3A${FUT}`)
    // one-tap is off: nothing was placed
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('an intent for another instrument is refused with a toast and opens nothing (RF 1)', async () => {
    await setup({ 'POST /api/v1/orderbook': book([order({ symbol: 'INFY' })]) })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const reads = requests('orderbook').length
    const stale: ChartIntent[] = [
      { inst: INFY, type: 'trade', side: 'BUY', lots: 1 },
      { inst: INFY, type: 'priceMenu', price: 1500 },
      { inst: INFY, type: 'modify', orderid: 'A1', price: 1500 },
      { inst: INFY, type: 'cancel', orderid: 'A1' },
      { inst: INFY, type: 'close', product: 'CNC' },
      { inst: INFY, type: 'depth' },
    ]
    for (const intent of stale) {
      await send(intent)
      expect(toast()).toBe(WRONG_SYMBOL)
    }
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(asked).toHaveLength(0)
    expect(requests('orderbook')).toHaveLength(reads)
    expect(requests('positionbook')).toHaveLength(0)
    expect(screen.queryByTestId('chart-price-buy-limit')).toBeNull()

    // the metadata on hand is still the last instrument's: nothing is sized from it
    await show(RELIANCE, chartMeta(FUT_META))
    await send({ inst: RELIANCE, type: 'trade', side: 'BUY', lots: 1 })
    expect(toast()).toBe(WRONG_SYMBOL)
    expect(mockRouter.push).not.toHaveBeenCalled()
  })

  test('the chart changing symbol while the book is read: the intent is refused (RF 1)', async () => {
    await setup({
      'POST /api/v1/orderbook': () => {
        // the user searched another symbol while this read was out
        current = INFY
        return book([order()])
      },
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await send({ inst: RELIANCE, type: 'cancel', orderid: 'A1' })
    expect(toast()).toBe(WRONG_SYMBOL)
    expect(asked).toHaveLength(0)
    expect(requests('cancelorder')).toHaveLength(0)
  })

  test('modify on an order no longer open says so and redraws; an open one opens modify with the preset (RF 2)', async () => {
    await setup({
      'POST /api/v1/orderbook': book([
        order({ orderid: 'A1' }),
        order({
          orderid: 'S1',
          action: 'SELL',
          pricetype: 'SL',
          price: 1380,
          trigger_price: 1385,
          order_status: 'trigger pending',
        }),
        order({ orderid: 'C1', order_status: 'complete' }),
        order({ orderid: 'O1', symbol: 'INFY' }),
      ]),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const reads = requests('orderbook').length

    // filled, gone from the book, and another instrument's: each is no longer open here
    for (const orderid of ['C1', 'Z9', 'O1']) {
      await send({ inst: RELIANCE, type: 'modify', orderid, price: 1401 })
      expect(toast()).toBe(NOT_OPEN)
    }
    expect(redraws).toBe(3)
    expect(mockRouter.push).not.toHaveBeenCalled()
    // each one read the book afresh
    expect(requests('orderbook')).toHaveLength(reads + 3)

    // a LIMIT line is its price, snapped to the tick again here (preflight conflict 26)
    await send({ inst: RELIANCE, type: 'modify', orderid: 'A1', price: 1401.03 })
    expect(mockRouter.push).toHaveBeenLastCalledWith('/order/A1/modify?price=1401.05&source=chart')
    // a stop's line is its trigger
    await send({ inst: RELIANCE, type: 'modify', orderid: 'S1', price: 1386 })
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      '/order/S1/modify?trigger_price=1386&source=chart',
    )
    expect(redraws).toBe(3)
    expect(requests('modifyorder')).toHaveLength(0)
  })

  test("X opens an order's cancel confirm (its orderSummary) or a position's close confirm, sent with mobile-chart", async () => {
    let closed = false
    await setup({
      'POST /api/v1/orderbook': book([
        order({
          orderid: 'F1',
          symbol: FUT,
          exchange: 'NFO',
          product: 'NRML',
          quantity: '130',
          price: 24117.3,
        }),
        order({ orderid: 'F2', symbol: FUT, exchange: 'NFO', order_status: 'cancelled' }),
      ]),
      'POST /api/v1/positionbook': () =>
        positions(
          closed
            ? []
            : [
                position({ symbol: FUT, exchange: 'NFO', product: 'NRML', quantity: '130' }),
                position({ symbol: FUT, exchange: 'NFO', product: 'MIS', quantity: '0' }),
              ],
        ),
      'POST /api/v1/cancelorder': ok({ status: 'success', orderid: 'F1' }),
      'POST /api/v1/placesmartorder': () => {
        closed = true
        return ok({ status: 'success', orderid: 'P1' })
      },
    })
    await show(NIFTY_FUT, chartMeta(FUT_META))

    await send({ inst: NIFTY_FUT, type: 'cancel', orderid: 'F1' })
    // the confirm names the order as the Orders tab does, in lots from the native metadata
    expect(asked.at(-1)).toEqual({
      title: 'LIVE · Cancel this order?',
      body: `BUY LIMIT 2L (130) ${FUT} @ 24,117.30 · NRML`,
      ok: 'Cancel order',
    })
    expect(bodyOf('cancelorder')).toMatchObject({ orderid: 'F1', strategy: 'mobile-chart' })
    expect(toast()).toBe('Order cancelled')
    expect(text('write-outcome-text')).toBe('Order cancelled')

    // a cancelled order has no X to act on any more
    await send({ inst: NIFTY_FUT, type: 'cancel', orderid: 'F2' })
    expect(toast()).toBe(NOT_OPEN)
    expect(redraws).toBe(1)
    expect(requests('cancelorder')).toHaveLength(1)

    // a flat product has no position to close
    await send({ inst: NIFTY_FUT, type: 'close', product: 'MIS' })
    expect(toast()).toBe(NO_POSITION)
    expect(redraws).toBe(2)

    await send({ inst: NIFTY_FUT, type: 'close', product: 'NRML' })
    expect(asked.at(-1)).toMatchObject({
      title: `LIVE · Close ${FUT} NRML?`,
      ok: 'Close position',
    })
    expect(bodyOf('placesmartorder')).toMatchObject({
      symbol: FUT,
      exchange: 'NFO',
      product: 'NRML',
      strategy: 'mobile-chart',
    })
    // the notices are the last write's: the close's line now
    expect(text('write-outcome-text')).toBe('Close order sent')
    await pass(2_100)
    expect(text('write-outcome-text')).toBe('Position is closed')
    expect(requests('placeorder')).toHaveLength(0)
  })

  // The duplicate close that reverses a position (rulings 5): the Positions tab's Close waits for
  // the session's hold, and so does the chart's, which no button state guards.
  test("a chart close while another screen's close of the position, or close all, is out sends nothing", async () => {
    await setup({
      'POST /api/v1/positionbook': positions([position()]),
      'POST /api/v1/placesmartorder': ok({ status: 'success', orderid: 'P1' }),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const tab = {}
    const scope = onPosition({ exchange: 'NSE', symbol: 'RELIANCE', product: 'CNC' })
    for (const held of [scope, ALL_POSITIONS]) {
      const release = holdOrder(trading as Trading, tab, held)
      await send({ inst: RELIANCE, type: 'close', product: 'CNC' })
      await pass(300)
      expect(toast()).toBe(CLOSE_OUT)
      release()
    }
    expect(asked).toHaveLength(0)

    // the tab's close goes while the chart's confirm is up: the chart's still sends nothing
    let release = () => {}
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons?: AlertButton[]) => {
      release = holdOrder(trading as Trading, tab, scope)
      buttons?.find((x) => x.style !== 'cancel')?.onPress?.()
    })
    await send({ inst: RELIANCE, type: 'close', product: 'CNC' })
    await pass(300)
    expect(toast()).toBe(CLOSE_OUT)
    expect(requests('placesmartorder')).toHaveLength(0)
    release()
  })

  test('an intent sent twice while the book is read acts once: one modify, one confirm', async () => {
    answer = null
    await setup({ 'POST /api/v1/orderbook': book([order()]) })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const twice = (intent: ChartIntent) =>
      act(async () => {
        chart?.onIntent({ v: 1, kind: 'intent', intent })
        chart?.onIntent({ v: 1, kind: 'intent', intent })
      })
    await twice({ inst: RELIANCE, type: 'modify', orderid: 'A1', price: 1401 })
    await pass(1_000)
    expect(mockRouter.push).toHaveBeenCalledTimes(1)
    await twice({ inst: RELIANCE, type: 'cancel', orderid: 'A1' })
    await pass(1_000)
    expect(asked).toHaveLength(1)
  })

  test('a long press shows the price actions and a pick opens the preset ticket', async () => {
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    // above the LTP: a SELL limit or a BUY stop, at the price snapped to the tick
    await send({ inst: RELIANCE, type: 'priceMenu', price: 1410.02 })
    expect(text('chart-price-title')).toBe('RELIANCE @ 1,410.00')
    expect(screen.getByTestId('chart-price-sell-limit')).toBeTruthy()
    expect(screen.getByTestId('chart-price-buy-stop')).toBeTruthy()
    expect(screen.queryByTestId('chart-price-buy-limit')).toBeNull()
    expect(screen.queryByTestId('chart-price-sell-stop')).toBeNull()

    // iOS shows the ticket once the sheet has gone: it cannot present over a closing sheet
    const sheet = sheetModal()
    await press('chart-price-buy-stop')
    expect(screen.queryByTestId('chart-price-buy-stop')).toBeNull()
    expect(mockRouter.push).not.toHaveBeenCalled()
    await act(async () => sheet.onDismiss())
    expect(mockRouter.push).toHaveBeenCalledTimes(1)
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      '/order/new?exchange=NSE&symbol=RELIANCE&action=BUY&pricetype=SL&price=1410&quantity=1&trigger=1410&source=chart',
    )

    // without an LTP the two limits; a derivative's ticket opens at one lot, in units
    ltpNow = null
    await show(NIFTY_FUT, chartMeta(FUT_META))
    await send({ inst: NIFTY_FUT, type: 'priceMenu', price: 24100.04 })
    expect(screen.getByTestId('chart-price-buy-limit')).toBeTruthy()
    expect(screen.getByTestId('chart-price-sell-limit')).toBeTruthy()
    const second = sheetModal()
    await press('chart-price-buy-limit')
    await act(async () => second.onDismiss())
    expect(mockRouter.push).toHaveBeenLastCalledWith(
      `/order/new?exchange=NFO&symbol=${FUT}&action=BUY&pricetype=LIMIT&price=24100&quantity=65&source=chart`,
    )

    // dismissed without a pick: nothing opens
    await send({ inst: NIFTY_FUT, type: 'priceMenu', price: 24100 })
    await press('chart-price-cancel')
    const calls = mockRouter.push.mock.calls.length
    expect(screen.queryByTestId('chart-price-buy-limit')).toBeNull()
    expect(mockRouter.push).toHaveBeenCalledTimes(calls)
    expect(requests('placeorder')).toHaveLength(0)
  })
})

describe('one-tap', () => {
  beforeEach(() => {
    usePrefs.setState({ chartOneTap: true })
  })

  /** A tap on BUY or SELL; the mode read before the send waits its turn in the read bucket. */
  const tap = async (inst: Inst, side: 'BUY' | 'SELL', lots: number) => {
    await send({ inst, type: 'trade', side, lots })
    await pass(1_000)
  }

  test('one-tap: one tap places one MARKET order with mobile-chart after the mode read; a tap during the send is ignored', async () => {
    let reply: (r: ScriptedReply) => void = () => {}
    await setup({
      'POST /api/v1/placeorder': () =>
        new Promise<ScriptedReply>((resolve) => {
          reply = resolve
        }),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    // the analyzer reading is older than its 5 s: the send reads the mode again first
    await pass(6_000)
    const modeReads = requests('analyzer').length
    await tap(RELIANCE, 'BUY', 2)
    expect(requests('analyzer')).toHaveLength(modeReads + 1)
    expect(sentOrder().lastIndexOf('analyzer')).toBeLessThan(sentOrder().indexOf('placeorder'))
    expect(requests('placeorder')).toHaveLength(1)
    expect(bodyOf('placeorder')).toMatchObject({
      strategy: 'mobile-chart',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'BUY',
      quantity: 2,
      pricetype: 'MARKET',
      product: 'CNC',
      price: 0,
      trigger_price: 0,
    })
    // a second tap while the first is on its way sends nothing, and says so with a haptic
    const warned = jest.spyOn(haptics, 'notifyWarning')
    await tap(RELIANCE, 'SELL', 2)
    expect(requests('placeorder')).toHaveLength(1)
    expect(toast()).toBe(ONE_TAP_BUSY)
    expect(warned).toHaveBeenCalledTimes(1)

    await act(async () => reply(PLACED))
    await pass(10)
    expect(text('write-outcome-text')).toBe('BUY 2 RELIANCE CNC: Order placed: 250408000989443')
    expect(mockRouter.push).not.toHaveBeenCalled()
    expect(asked).toHaveLength(0)
  })

  test('one-tap sends the default product: CNC on NSE, NRML on NFO', async () => {
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'SELL', 1)
    await pass(200)
    await show(NIFTY_FUT, chartMeta(FUT_META))
    await tap(NIFTY_FUT, 'BUY', 3)
    expect(requests('placeorder')).toHaveLength(2)
    expect(bodyOf('placeorder', 0)).toMatchObject({
      symbol: 'RELIANCE',
      action: 'SELL',
      product: 'CNC',
      quantity: 1,
    })
    expect(bodyOf('placeorder', 1)).toMatchObject({
      symbol: FUT,
      action: 'BUY',
      product: 'NRML',
      quantity: 195,
    })
  })

  test('one-tap above the freeze quantity places nothing', async () => {
    await setup()
    await show(NIFTY_FUT, chartMeta(FUT_META))
    // 28 lots are 1,820, over the freeze limit of 1,800: the ticket would split it
    await tap(NIFTY_FUT, 'BUY', 28)
    expect(toast()).toBe(ABOVE_FREEZE(1800))
    expect(ABOVE_FREEZE(1800)).toBe('Above the freeze quantity of 1800: use the ticket.')
    expect(requests('placeorder')).toHaveLength(0)
    expect(requests('splitorder')).toHaveLength(0)
    // 27 lots are 1,755: within it
    await pass(200)
    await tap(NIFTY_FUT, 'BUY', 27)
    expect(bodyOf('placeorder')).toMatchObject({ quantity: 1755 })
    // a freeze limit of 1 splits nothing, so it refuses nothing (preflight conflict 29)
    await pass(200)
    await show(NIFTY_FUT, { ...chartMeta(FUT_META), freezeQty: 1 })
    await tap(NIFTY_FUT, 'BUY', 2)
    expect(requests('placeorder')).toHaveLength(2)
  })

  test('one-tap on a quote-only (index) instrument sends nothing and says what the ticket says', async () => {
    await setup()
    await show(NIFTY, chartMeta(NIFTY_META))
    const modeReads = requests('analyzer').length
    // the page hides BUY and SELL on an index, but the bridge is not trusted, and the server's
    // VALID_EXCHANGES lists NSE_INDEX: nothing goes, as from the ticket
    await tap(NIFTY, 'BUY', 1)
    expect(toast()).toBe(QUOTE_ONLY_COPY)
    expect(QUOTE_ONLY_COPY).toBe(
      "Indices can't be traded. Open the futures or options contract instead.",
    )
    expect(requests('placeorder')).toHaveLength(0)
    expect(requests('analyzer')).toHaveLength(modeReads)
    expect(screen.queryByTestId('write-outcome')).toBeNull()
    expect(mockRouter.push).not.toHaveBeenCalled()
    // either says it: the exchange, as the ticket's own check, or the metadata's flag
    await pass(200)
    await show(NIFTY, { ...chartMeta(NIFTY_META), quoteOnly: false })
    await tap(NIFTY, 'SELL', 1)
    await pass(200)
    await show(RELIANCE, { ...chartMeta(RELIANCE_META), quoteOnly: true })
    await tap(RELIANCE, 'BUY', 1)
    expect(toast()).toBe(QUOTE_ONLY_COPY)
    expect(requests('placeorder')).toHaveLength(0)
    // a tradeable instrument still goes at once
    await pass(200)
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test("one-tap while another sheet's order is out places nothing and says EARLIER_OUT", async () => {
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const release = holdOrder(trading as Trading, {}, NEW_ORDER)
    await tap(RELIANCE, 'BUY', 1)
    expect(toast()).toBe(EARLIER_OUT)
    expect(requests('placeorder')).toHaveLength(0)
    await act(async () => release())
    await pass(1_000)
    await tap(RELIANCE, 'BUY', 1)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('one-tap queued shows the queued copy and Open Action Center', async () => {
    await setup({
      'POST /api/v1/placeorder': ok({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 12,
      }),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    expect(screen.queryByTestId('banner-semi-auto')).toBeNull()
    await tap(RELIANCE, 'BUY', 1)
    expect(text('write-outcome-text')).toBe(
      'BUY 1 RELIANCE CNC: Queued for approval in the web Action Center',
    )
    expect(screen.queryByText(/Order placed/)).toBeNull()
    // the connection marked Semi-Auto from the reply: its banner links to the Action Center
    expect(useConnection.getState().semiAutoSeen).toBe(true)
    await press('open-action-center')
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/action-center`)
  })

  test('one-tap answered LIVE after an ANALYZE badge sets the live notice', async () => {
    const warned = expectLog(
      'warn',
      /\[orders\] place: the review showed ANALYZE, but the server answered LIVE$/,
    )
    await setup({ 'POST /api/v1/analyzer': analyzer('analyze') })
    useConnection.getState().set({ analyzer: 'analyze' })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    // the reply carries no sandbox tag: it went to the broker
    await tap(RELIANCE, 'BUY', 1)
    expect(screen.getByTestId('live-surprise')).toHaveTextContent(liveSurpriseText('place'), {
      exact: false,
    })
    expect(text('write-outcome-text')).toBe(
      'BUY 1 RELIANCE CNC: LIVE order placed: 250408000989443. The server switched to LIVE after your review.',
    )
    expect(warned).toHaveLength(1)
    await press('live-surprise-dismiss')
    expect(screen.queryByTestId('live-surprise')).toBeNull()
  })

  test('one-tap refused by Semi-Auto sets semiBlocked', async () => {
    const REFUSED = 'Place order operation is not allowed in Semi-Auto mode.'
    await setup({
      'POST /api/v1/placeorder': { status: 403, body: { status: 'error', message: REFUSED } },
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    expect(text('banner-semi-auto-blocked')).toContain(REFUSED)
    expect(screen.queryByTestId('banner-semi-auto')).toBeNull()
    expect(screen.queryByTestId('write-outcome')).toBeNull()
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('one-tap timeout: Status unknown, a reconcile, never a re-send', async () => {
    await setup({ 'POST /api/v1/placeorder': () => new Promise<never>(() => {}) })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    await pass(ENDPOINTS.placeorder.timeoutMs)
    expect(text('write-outcome-text')).toBe(
      'BUY 1 RELIANCE CNC: Status unknown: checking order book',
    )
    expect(screen.getByTestId('write-outcome-orderbook')).toBeTruthy()
    const reads = requests('orderbook').length
    // a tap meanwhile sends nothing, and says so: the first order's outcome is not known yet
    await tap(RELIANCE, 'BUY', 1)
    expect(toast()).toBe(ONE_TAP_BUSY)
    // the check reads past the server's 120 s broker timeout, then says what the book showed
    await pass(127_100)
    expect(requests('orderbook').length).toBeGreaterThan(reads)
    expect(text('write-outcome-text')).toBe(`BUY 1 RELIANCE CNC: ${NOT_YET}`)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test("two one-taps, the second timing out: the first order is not reported as the second's", async () => {
    let placed = 0
    await setup({
      'POST /api/v1/placeorder': () => {
        placed++
        return placed === 1 ? PLACED : new Promise<never>(() => {})
      },
      // the book lists the first order once it went: the same contract, side and quantity
      'POST /api/v1/orderbook': () =>
        book(
          placed > 0
            ? [
                order({
                  orderid: '250408000989443',
                  pricetype: 'MARKET',
                  price: 0,
                  timestamp: '24-Nov-2026 09:30:01',
                }),
              ]
            : [],
        ),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    expect(text('write-outcome-text')).toBe('BUY 1 RELIANCE CNC: Order placed: 250408000989443')
    // the book is read again after it, so the next one-tap knows that order
    await pass(1_000)
    await tap(RELIANCE, 'BUY', 1)
    await pass(ENDPOINTS.placeorder.timeoutMs + 127_100)
    expect(text('write-outcome-text')).toBe(`BUY 1 RELIANCE CNC: ${NOT_YET}`)
    expect(requests('placeorder')).toHaveLength(2)
  })

  test('one-tap live with confirm on asks biometrics; a flip to LIVE sends nothing', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(3)
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Confirm live order',
      disableDeviceFallback: false,
    })
    expect(requests('placeorder')).toHaveLength(0)
    expect(text('write-outcome-text')).toBe('BUY 1 RELIANCE CNC: The order was not sent.')

    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    await pass(200)
    await tap(RELIANCE, 'BUY', 1)
    expect(requests('placeorder')).toHaveLength(1)

    // the badge says ANALYZE, the server is now LIVE: nothing goes, and no prompt is asked
    await pass(6_000)
    useConnection.getState().set({ analyzer: 'analyze' })
    const prompts = auth.authenticateAsync.mock.calls.length
    await tap(RELIANCE, 'BUY', 1)
    expect(text('write-outcome-text')).toBe(
      'BUY 1 RELIANCE CNC: The server is now in LIVE mode. Nothing was sent.',
    )
    expect(auth.authenticateAsync).toHaveBeenCalledTimes(prompts)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('one-tap with the mode unknown reads it and sends nothing; a tap after the read sends once', async () => {
    await setup()
    useConnection.getState().set({ analyzer: 'unknown' })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await pass(6_000)
    const modeReads = requests('analyzer').length
    await tap(RELIANCE, 'BUY', 1)
    expect(toast()).toBe(MODE_UNKNOWN)
    expect(requests('analyzer')).toHaveLength(modeReads + 1)
    expect(requests('placeorder')).toHaveLength(0)
    // the read landed; the tabs layout's useAnalyzer shows it on the badge
    expect((trading as Trading).analyzer.peek()).toBe('live')
    useConnection.getState().set({ analyzer: 'live' })
    await pass(200)
    await tap(RELIANCE, 'BUY', 1)
    expect(requests('placeorder')).toHaveLength(1)
  })

  test('one-tap while the broker is logged out sends nothing and says why', async () => {
    await setup()
    await show(RELIANCE, chartMeta(RELIANCE_META))
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const modeReads = requests('analyzer').length
    await tap(RELIANCE, 'BUY', 1)
    expect(toast()).toBe(
      'Your broker session has ended. Log in to your broker on the OpenAlgo web.',
    )
    expect(requests('analyzer')).toHaveLength(modeReads)
    expect(requests('placeorder')).toHaveLength(0)
  })

  test('a placed one-tap order the broker then rejects is said in danger, never left as placed', async () => {
    let placed = false
    await setup({
      'POST /api/v1/placeorder': () => {
        placed = true
        return PLACED
      },
      'POST /api/v1/orderbook': () =>
        book(
          placed
            ? [order({ orderid: '250408000989443', pricetype: 'MARKET', order_status: 'rejected' })]
            : [],
        ),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const error = jest.spyOn(haptics, 'notifyError')
    await tap(RELIANCE, 'BUY', 1)
    expect(text('write-outcome-text')).toBe('BUY 1 RELIANCE CNC: Order placed: 250408000989443')
    // the order book, read after it, shows the broker's RMS rejected it
    await pass(2_000)
    expect(text('write-outcome-text')).toBe(`BUY 1 RELIANCE CNC: ${PLACED_REJECTED}`)
    expect(toast()).toBe(`BUY 1 RELIANCE CNC: ${PLACED_REJECTED}`)
    expect(screen.getByTestId('write-outcome-orderbook')).toBeTruthy()
    expect(error).toHaveBeenCalledTimes(1)
    // a final status: the book is read no more for it
    const reads = requests('orderbook').length
    await pass(20_000)
    expect(requests('orderbook')).toHaveLength(reads)
  })

  test("a one-tap order's status shows on its line once the book has it", async () => {
    let placed = false
    await setup({
      'POST /api/v1/placeorder': () => {
        placed = true
        return PLACED
      },
      'POST /api/v1/orderbook': () =>
        book(
          placed
            ? [order({ orderid: '250408000989443', pricetype: 'MARKET', order_status: 'complete' })]
            : [],
        ),
    })
    await show(NIFTY_FUT, chartMeta(FUT_META))
    await tap(NIFTY_FUT, 'SELL', 2)
    await pass(2_000)
    expect(text('write-outcome-text')).toBe(
      `SELL 2L (130) ${FUT} NRML: Order placed: 250408000989443 · complete`,
    )
  })

  test("Back while a one-tap is out: its outcome waits for the next ticket's review", async () => {
    let reply: (r: ScriptedReply) => void = () => {}
    await setup({
      'POST /api/v1/placeorder': () =>
        new Promise<ScriptedReply>((resolve) => {
          reply = resolve
        }),
    })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    await tap(RELIANCE, 'BUY', 1)
    expect(requests('placeorder')).toHaveLength(1)
    // the trader goes Back; the order is still on its way
    await view?.rerender(tree(services as Services, undefined))
    await act(async () => reply(PLACED))
    await pass(10)
    // the toast said it, and on iOS a presented sheet hides the toast: the next review shows it
    expect(takeUnseenOutcome(trading as Trading, NEW_ORDER)).toBe(
      'BUY 1 RELIANCE CNC: Order placed: 250408000989443',
    )
  })

  test("a sandbox one-tap order says so, and an evented broker's order is expected on the feed", async () => {
    await setup(
      {
        'POST /api/v1/analyzer': analyzer('analyze'),
        'POST /api/v1/placeorder': ok({ status: 'success', orderid: 'SB1', mode: 'analyze' }),
      },
      { live: true },
    )
    useConnection.getState().set({ analyzer: 'analyze' })
    await show(RELIANCE, chartMeta(RELIANCE_META))
    const expected = jest.spyOn((trading as Trading).eventWatch, 'expect')
    await tap(RELIANCE, 'BUY', 1)
    expect(text('write-outcome-text')).toBe('BUY 1 RELIANCE CNC: Sandbox order placed: SB1')
    expect(expected).toHaveBeenCalledWith('SB1')
  })
})
