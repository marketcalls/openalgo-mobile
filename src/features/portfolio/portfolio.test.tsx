import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert, type AlertButton, Linking } from 'react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import PortfolioTab from '~/app/(app)/(tabs)/portfolio'
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
import { chartHref, ticketHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import holdings from '../../../test/fixtures/openalgo-docs/holdings.json'
import { keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { type Route, type ScriptedReply, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { fakeSockets } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: () => true }))
const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() }
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}))
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}))

const ORIGIN = 'https://algo.example.com'
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
// A Tuesday, 09:30 IST: NSE is open.
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
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: T0,
}

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })

/** A positionbook row as the stock server sends it (strings, as the docs show). */
const pos = (o: Record<string, unknown> = {}) => ({
  symbol: 'RELIANCE',
  exchange: 'NSE',
  product: 'CNC',
  quantity: '10',
  average_price: '100',
  ltp: '101',
  pnl: '9',
  ...o,
})
const posBook = (rows: unknown[]) => ok({ status: 'success', data: rows })

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('live'),
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/positionbook': posBook([pos()]),
  'POST /api/v1/holdings': ok(holdings),
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
const INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

async function setup(routes: Record<string, Route> = {}) {
  fetchFake = scriptedFetch({ ...BASE_ROUTES, ...routes })
  const kv = memoryKV({
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(CAPS),
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

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

async function show() {
  if (!services) throw new Error('setup first')
  await render(
    <SafeAreaInsetsContext.Provider value={INSETS}>
      <ServicesProvider value={services}>
        <TradingProvider now={Date.now}>
          <QueryClientProvider client={services.queryClient}>
            <TickStoreContext.Provider value={services.store}>
              <LiveContext.Provider
                value={{
                  realtime: services.realtime,
                  polling: services.polling,
                  store: services.store,
                }}
              >
                <PortfolioTab />
                <ToastHost />
              </LiveContext.Provider>
            </TickStoreContext.Provider>
          </QueryClientProvider>
        </TradingProvider>
      </ServicesProvider>
    </SafeAreaInsetsContext.Provider>,
  )
  await pass(10)
}

const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id))
  await pass(10)
}
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const bodyOf = (id: string, i = 0) => requests(id)[i]?.body as Record<string, unknown>
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
const text = (id: string) => textOf(screen.getByTestId(id))
const tick = async (key: string, ltp: number) => {
  services?.store.put(key, { ltp }, 'ws')
  await pass(50)
}

const HARNESS_LOGS = {
  info: / INFO \[(http\] \w+ (\d{3}|failed|timeout) \d+ms|ws\] state \w+)$/,
  warn: / WARN \[ws\] no auth_ok in time$/,
}

let asked: { title: string; body?: string; ok?: string }[] = []

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  asked = []
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  jest.spyOn(Alert, 'alert').mockImplementation((title, body, buttons?: AlertButton[]) => {
    asked.push({ title: String(title), body: body ?? undefined, ok: buttons?.[1]?.text })
    buttons?.find((x) => x.style !== 'cancel')?.onPress?.()
  })
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

describe('positions', () => {
  test('a tick on RELIANCE updates the row and the total with no refetch', async () => {
    await setup({
      'POST /api/v1/positionbook': posBook([
        pos(),
        pos({
          symbol: 'YESBANK',
          product: 'MIS',
          quantity: '-104',
          average_price: '17.2',
          ltp: '17.2',
          pnl: '0',
        }),
      ]),
    })
    await show()
    expect(text('pos-pnl-NSE-RELIANCE-CNC')).toBe('+9.00')
    const reads = requests('positionbook').length
    await tick('NSE:RELIANCE', 105)
    expect(text('pos-pnl-NSE-RELIANCE-CNC')).toBe('+50.00')
    expect(text('pos-ltp-NSE-RELIANCE-CNC')).toBe('105.00')
    expect(text('pf-total-pnl')).toBe('+50.00')
    await tick('NSE:YESBANK', 17.31)
    expect(text('pf-total-pnl')).toBe('+38.56')
    expect(requests('positionbook')).toHaveLength(reads)
  })

  test('a row without a symbol is dropped and counted', async () => {
    await setup({ 'POST /api/v1/positionbook': posBook([pos(), pos({ symbol: undefined })]) })
    await show()
    expect(text('books-dropped')).toBe('1 row could not be read')
    expect(screen.getByTestId('pos-row-NSE-RELIANCE-CNC')).toBeTruthy()
  })

  test('the chart button opens the chart', async () => {
    await setup()
    await show()
    await press('pos-chart-NSE-RELIANCE-CNC')
    expect(mockRouter.push).toHaveBeenCalledWith(chartHref('NSE', 'RELIANCE'))
  })

  test('a closed row has no Close', async () => {
    await setup({ 'POST /api/v1/positionbook': posBook([pos({ quantity: '0' })]) })
    await show()
    expect(screen.queryByTestId('pos-close-NSE-RELIANCE-CNC')).toBeNull()
    expect(screen.getByTestId('pf-close-all')).toBeDisabled()
  })

  test('in polling mode the positions are read every 5 s', async () => {
    await setup()
    await show()
    const reads = requests('positionbook').length
    await pass(5_100)
    expect(requests('positionbook').length).toBeGreaterThan(reads)
  })
})

describe('close one', () => {
  const placed = ok({ status: 'success', orderid: '250408000989443' })

  test('the confirm names the position; the body follows C3 with the row product', async () => {
    await setup({ 'POST /api/v1/placesmartorder': placed })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    expect(asked).toEqual([
      {
        title: 'LIVE · Close RELIANCE CNC?',
        body: 'This closes the whole net position (10) for RELIANCE CNC at market, including quantity opened by strategies or the web.',
        ok: 'Close position',
      },
    ])
    expect(bodyOf('placesmartorder')).toEqual({
      apikey: KEY,
      strategy: 'mobile',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      product: 'CNC',
      action: 'SELL',
      quantity: '0',
      position_size: '0',
      pricetype: 'MARKET',
      price: '0',
      trigger_price: '0',
      disclosed_quantity: '0',
    })
    expect(text('toast')).toBe('Close order sent')
  })

  test('a flat reply says "Already flat"', async () => {
    await setup({
      'POST /api/v1/placesmartorder': ok({
        status: 'success',
        message: 'Positions Already Matched. No Action needed.',
      }),
    })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    expect(text('toast')).toBe('Already flat')
  })

  test('a queued reply says it is queued', async () => {
    await setup({
      'POST /api/v1/placesmartorder': ok({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 12,
      }),
    })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    expect(text('toast')).toBe('Queued for approval in the web Action Center')
  })

  test('a 500 is checked against the positionbook: closed', async () => {
    let sent = false
    await setup({
      'POST /api/v1/positionbook': () => posBook([pos({ quantity: sent ? '0' : '10' })]),
      'POST /api/v1/placesmartorder': () => {
        sent = true
        return { status: 500, body: { status: 'error', message: 'No OpenPosition Found' } }
      },
    })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    expect(text('toast')).toBe('Close may have gone through: checking positions.')
    await pass(2_100)
    expect(text('toast')).toBe('Position is closed')
    expect(requests('placesmartorder')).toHaveLength(1)
  })

  test('a 502 whose check shows the position open says how much', async () => {
    await setup({
      'POST /api/v1/placesmartorder': {
        status: 502,
        contentType: 'text/html',
        body: 'Bad Gateway',
      },
    })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    await pass(17_500)
    expect(text('toast')).toBe('Still open: 10. You can try Close again.')
    expect(requests('placesmartorder')).toHaveLength(1)
  })

  test('a check that cannot read the book says so', async () => {
    let sent = false
    await setup({
      'POST /api/v1/positionbook': () => (sent ? 'throw' : posBook([pos()])),
      'POST /api/v1/placesmartorder': () => {
        sent = true
        return { status: 500, body: { status: 'error', message: 'boom' } }
      },
    })
    await show()
    await press('pos-close-NSE-RELIANCE-CNC')
    await pass(17_500)
    expect(text('toast')).toBe("Couldn't check. Pull to refresh.")
  })

  test('a double tap sends one call', async () => {
    await setup({ 'POST /api/v1/placesmartorder': placed })
    await show()
    const b = screen.getByTestId('pos-close-NSE-RELIANCE-CNC')
    await fireEvent.press(b)
    await fireEvent.press(b)
    await pass(10)
    expect(requests('placesmartorder')).toHaveLength(1)
  })

  test('declining the confirm sends nothing', async () => {
    await setup()
    await show()
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons?: AlertButton[]) => {
      buttons?.find((x) => x.style === 'cancel')?.onPress?.()
    })
    await press('pos-close-NSE-RELIANCE-CNC')
    expect(requests('placesmartorder')).toHaveLength(0)
  })
})

describe('close all', () => {
  const two = posBook([pos(), pos({ symbol: 'ITC', quantity: '-5', product: 'MIS' })])

  test('the confirm names the count; the reply message shows', async () => {
    await setup({
      'POST /api/v1/positionbook': two,
      'POST /api/v1/closeposition': ok({
        status: 'success',
        message: 'All Open Positions Squared Off',
      }),
    })
    await show()
    expect(text('pf-close-all')).toBe('Close all (2)')
    await press('pf-close-all')
    expect(asked).toEqual([
      {
        title: 'LIVE · Close all 2 open positions?',
        body: 'This closes every open position in the account at market, across all strategies and the web.',
        ok: 'Close all',
      },
    ])
    expect(bodyOf('closeposition')).toEqual({ apikey: KEY, strategy: 'mobile' })
    expect(text('toast')).toBe('All Open Positions Squared Off')
  })

  test('a Semi-Auto 403 shows the banner', async () => {
    const reason =
      'Close position operation is not allowed in Semi-Auto mode. Please switch to Auto mode to close positions.'
    await setup({
      'POST /api/v1/positionbook': two,
      'POST /api/v1/closeposition': { status: 403, body: { status: 'error', message: reason } },
    })
    await show()
    await press('pf-close-all')
    expect(screen.getByTestId('banner-semi-auto-blocked')).toHaveTextContent(reason, {
      exact: false,
    })
    expect(screen.queryByTestId('banner-semi-auto')).toBeNull()
  })

  test('a 502 refetches the positionbook and counts what is still open', async () => {
    await setup({
      'POST /api/v1/positionbook': two,
      'POST /api/v1/closeposition': { status: 502, contentType: 'text/html', body: 'Bad Gateway' },
    })
    await show()
    await press('pf-close-all')
    expect(text('toast')).toBe('Status unknown: checking order book')
    await pass(17_500)
    expect(text('toast')).toBe('Status unknown. 2 positions still open.')
    expect(requests('closeposition')).toHaveLength(1)
  })
})

describe('holdings', () => {
  test('the statistics, the rows and Sell', async () => {
    await setup()
    await show()
    await press('pf-seg-holdings')
    expect(text('hold-stat-value')).toBe('1,768.00')
    expect(text('hold-stat-invested')).toBe('2,001.00')
    expect(text('hold-stat-pnl')).toBe('-233.15')
    expect(text('hold-stat-pct')).toBe('-11.65%')
    expect(text('hold-pnl-NSE-RELIANCE')).toBe('-149.00')
    expect(screen.queryByTestId('hold-avg-NSE-RELIANCE')).toBeNull()
    await press('hold-sell-NSE-CANBK')
    expect(mockRouter.push).toHaveBeenCalledWith(
      ticketHref({
        exchange: 'NSE',
        symbol: 'CANBK',
        action: 'SELL',
        product: 'CNC',
        pricetype: 'MARKET',
        quantity: 5,
      }),
    )
    await press('hold-chart-NSE-RELIANCE')
    expect(mockRouter.push).toHaveBeenCalledWith(chartHref('NSE', 'RELIANCE'))
  })

  test('a live tick recomputes a holding that has its average price', async () => {
    const withAvg = {
      ...holdings,
      data: {
        ...holdings.data,
        holdings: [
          {
            symbol: 'RELIANCE',
            exchange: 'NSE',
            product: 'CNC',
            quantity: 10,
            average_price: 100,
            pnl: 0,
            pnlpercent: 0,
          },
        ],
      },
    }
    await setup({ 'POST /api/v1/holdings': ok(withAvg) })
    await show()
    await press('pf-seg-holdings')
    expect(text('hold-avg-NSE-RELIANCE')).toBe('100.00')
    await tick('NSE:RELIANCE', 110)
    expect(text('hold-pnl-NSE-RELIANCE')).toBe('+100.00')
    expect(text('hold-pct-NSE-RELIANCE')).toBe('+10.00%')
    expect(text('hold-stat-pnl')).toBe('+100.00')
  })

  test('a row without a symbol is dropped and counted', async () => {
    const bad = {
      ...holdings,
      data: {
        ...holdings.data,
        holdings: [...holdings.data.holdings, { exchange: 'NSE', quantity: 1 }],
      },
    }
    await setup({ 'POST /api/v1/holdings': ok(bad) })
    await show()
    await press('pf-seg-holdings')
    expect(text('books-dropped')).toBe('1 row could not be read')
  })
})

describe('funds', () => {
  test('the labels map from the docs fixture', async () => {
    await setup()
    await show()
    await press('pf-seg-funds')
    expect(screen.getByTestId('funds-view')).toBeTruthy()
    for (const label of [
      'Available cash',
      'Collateral',
      'Unrealised M2M',
      'Realised M2M',
      'Used margin',
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(text('funds-cash')).toBe('320.66')
    expect(text('funds-collateral')).toBe('0.00')
    expect(text('funds-m2m-unrealised')).toBe('-7.88')
    expect(text('funds-m2m-realised')).toBe('3.27')
    expect(text('funds-margin-used')).toBe('679.34')
  })

  test('funds are refetched every 60 s while visible', async () => {
    await setup()
    await show()
    await press('pf-seg-funds')
    const reads = requests('funds').length
    await pass(61_000)
    expect(requests('funds').length).toBeGreaterThan(reads)
  })
})
