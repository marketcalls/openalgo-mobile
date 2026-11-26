import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import ModifyGttRoute from '~/app/(app)/gtt/[id]/modify'
import NewGttRoute from '~/app/(app)/gtt/new'
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
import { useGttBook } from '~/market/gtt/queries'
import { type GttParams, gttHref } from '~/market/links'
import { CHECKING } from '~/market/orders/outcome'
import { CONFIRM_FAILED, liveSurpriseText } from '~/market/orders/submit'
import { TradingProvider } from '~/market/trading'
import { ToastHost } from '~/ui/Toast'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import symbolNse from '../../../test/fixtures/openalgo-docs/symbol-nse.json'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
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

const SELL_RELIANCE: GttParams = { exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL' }

const ok = (body: unknown): ScriptedReply => ({ status: 200, body })
const analyzer = (mode: 'live' | 'analyze') =>
  ok({ status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } })
const BAD_GATEWAY: ScriptedReply = { status: 502, contentType: 'text/html', body: 'Bad Gateway' }
const PLACED = ok({ status: 'success', trigger_id: '1001', mode: 'analyze' })

/** A G4 row as the sandbox lists it: SELL 1 RELIANCE, trigger 1500 → LIMIT 1499. */
const ROW = {
  trigger_id: '1001',
  trigger_type: 'single',
  status: 'active',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  trigger_prices: [1500],
  last_price: 1800,
  legs: [{ action: 'SELL', quantity: 1, price: 1499, pricetype: 'LIMIT', product: 'CNC' }],
  created_at: '2026-11-24T04:00:00.000Z',
  updated_at: '2026-11-24T04:00:00.000Z',
  expires_at: '2027-11-24T04:00:00.000Z',
}
const gttBook = (rows: unknown[], o: { analyze?: boolean } = { analyze: true }) =>
  ok({ status: 'success', data: rows, ...(o.analyze ? { mode: 'analyze' } : {}) })

const symbolReply = (req: ScriptedRequest): ScriptedReply => {
  const { symbol, exchange } = req.body as { symbol: string; exchange: string }
  if (symbol === 'GONE') {
    return {
      status: 404,
      body: { status: 'error', message: `Symbol GONE not found in exchange ${exchange}` },
    }
  }
  return ok({ ...symbolNse, data: { ...symbolNse.data, symbol, exchange } })
}

const BASE_ROUTES: Record<string, Route> = {
  'POST /api/v1/funds': ok(funds),
  'POST /api/v1/analyzer': analyzer('analyze'),
  'POST /api/v1/symbol': symbolReply,
  'POST /api/v1/multiquotes': ok({ status: 'success', results: [] }),
  'POST /api/v1/gttorderbook': gttBook([]),
  'POST /api/v1/placegttorder': PLACED,
}

let services: Services | null = null
let fetchFake = scriptedFetch({})
const INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The real container over a scripted server. */
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
  await pass(0)
  return s
}

/** The GTT list on the Orders tab beneath the sheet: it reads the book through its query. */
function ListBehind() {
  useGttBook()
  return null
}

/** The app shell around one GTT sheet; `behind` mounts the GTT list beneath it. */
const tree = (s: Services, sheet: React.ReactElement, behind: boolean) => (
  <SafeAreaInsetsContext.Provider value={INSETS}>
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={s.queryClient}>
          <TickStoreContext.Provider value={s.store}>
            <LiveContext.Provider
              value={{ realtime: s.realtime, polling: s.polling, store: s.store }}
            >
              {behind ? <ListBehind /> : null}
              {sheet}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  </SafeAreaInsetsContext.Provider>
)

const paramsOf = (href: string) => Object.fromEntries(new URLSearchParams(href.split('?')[1]))

let view: { rerender: (el: React.ReactElement) => Promise<unknown> } | null = null
let opened = 0

/** Opens a sheet with these route params, and waits for the instrument's metadata. */
async function show(params: Record<string, string>, sheet: React.ReactElement, behind = false) {
  if (!services) throw new Error('setup first')
  mockParams = params
  const el = tree(services, sheet, behind)
  if (view) await view.rerender(el)
  else view = await render(el)
  await pass(10)
}

const open = (p: GttParams) => show(paramsOf(gttHref(p)), <NewGttRoute key={opened++} />)
const openModify = (id: string, o: { behind?: boolean } = {}) =>
  show({ id }, <ModifyGttRoute key={opened++} />, o.behind)

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
/** The RELIANCE price the feed or the poll last gave. */
const ltp = (n: number) =>
  act(async () => {
    services?.store.put('NSE:RELIANCE', { ltp: n }, 'poll')
    await jest.advanceTimersByTimeAsync(20)
  })
const requests = (id: string) => fetchFake.calls.filter((c) => c.url.endsWith(`/api/v1/${id}`))
const bodyOf = (id: string, i = 0) => requests(id)[i]?.body as Record<string, unknown>
const selected = (id: string) => screen.getByTestId(id).props.accessibilityState?.selected
const disabled = (id: string) => screen.getByTestId(id).props.accessibilityState?.disabled
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
const text = (id: string) => textOf(screen.getByTestId(id))

/** SELL 1 RELIANCE, trigger 1500 → LIMIT 1499 at an LTP of 1800, up to its review. */
async function reviewSell() {
  await open(SELL_RELIANCE)
  await ltp(1800)
  await type('gtt-trigger', '1500')
  await type('gtt-price', '1499')
  await press('gtt-review')
}

const HARNESS_LOGS = {
  info: / INFO \[(http\] \w+ (\d{3}|failed|timeout) \d+ms|ws\] state \w+)$/,
  warn: / WARN \[ws\] no auth_ok in time$/,
  debug: / DEBUG \[ws\] (→ authenticate|← auth_ok)$/,
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  mockParams = {}
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
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

describe('edit', () => {
  test('SINGLE BUY of 1 by default; the side and type choices; the LTP', async () => {
    await setup()
    await open({ exchange: 'NSE', symbol: 'RELIANCE' })
    expect(screen.getByTestId('gtt-screen')).toBeTruthy()
    expect(selected('gtt-type-SINGLE')).toBe(true)
    expect(selected('gtt-side-buy')).toBe(true)
    expect(screen.getByTestId('gtt-qty').props.value).toBe('1')
    expect(text('gtt-ltp')).toBe('LTP --')
    await ltp(1800)
    expect(text('gtt-ltp')).toBe('LTP 1,800.00')

    await press('gtt-side-sell')
    expect(selected('gtt-side-sell')).toBe(true)
    await press('gtt-type-OCO')
    expect(screen.queryByTestId('gtt-trigger')).toBeNull()
    for (const id of ['gtt-sl-trigger', 'gtt-sl-price', 'gtt-tg-trigger', 'gtt-tg-price']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
  })

  test('what stops the review shows by its issue; prices snap to the tick on blur', async () => {
    await setup()
    await open(SELL_RELIANCE)
    expect(text('gtt-issue-TRIGGER_MISSING')).toBe('Enter a trigger price.')
    expect(text('gtt-issue-PRICE_MISSING')).toBe('Enter a limit price.')
    expect(text('gtt-issue-LTP_UNKNOWN')).toBe('Waiting for the last price.')
    expect(disabled('gtt-review')).toBe(true)

    await type('gtt-trigger', '1500.03')
    await fireEvent(screen.getByTestId('gtt-trigger'), 'blur')
    expect(screen.getByTestId('gtt-trigger').props.value).toBe('1500.05')
    await type('gtt-price', '1499')
    await ltp(1800)
    expect(screen.queryByTestId('gtt-issue-LTP_UNKNOWN')).toBeNull()
    expect(disabled('gtt-review')).toBe(false)

    await press('gtt-type-OCO')
    expect(text('gtt-issue-OCO_MISSING')).toBe('Enter both triggers and both limit prices.')
    expect(disabled('gtt-review')).toBe(true)
  })

  test('an index or an unknown symbol shows only its issue text', async () => {
    await setup()
    await open({ exchange: 'NSE_INDEX', symbol: 'NIFTY' })
    expect(text('gtt-refused')).toBe('Indices are quote-only: GTT is not available.')
    expect(screen.queryByTestId('gtt-review')).toBeNull()
    expect(requests('symbol')).toHaveLength(0)

    await open({ exchange: 'NSE', symbol: 'GONE' })
    expect(text('gtt-refused')).toBe('This contract is expired or unknown.')
    expect(screen.queryByTestId('gtt-qty')).toBeNull()
  })

  test('a link that does not parse says so', async () => {
    await setup()
    await show({ exchange: 'NSE' }, <NewGttRoute key={opened++} />)
    expect(screen.getByText('This GTT link is incomplete.')).toBeTruthy()
  })

  test('while the broker is logged out the banner shows and review is disabled', async () => {
    await setup()
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await open(SELL_RELIANCE)
    await ltp(1800)
    await type('gtt-trigger', '1500')
    await type('gtt-price', '1499')
    expect(screen.getByTestId('broker-banner-login')).toBeTruthy()
    expect(disabled('gtt-review')).toBe(true)
  })
})

describe('review and send', () => {
  test('the review shows the ANALYZE badge; confirm waits for the mode and the book', async () => {
    let answerMode = () => {}
    let answerBook = () => {}
    await setup({
      'POST /api/v1/analyzer': () =>
        new Promise<ScriptedReply>((resolve) => {
          answerMode = () => resolve(analyzer('analyze'))
        }),
      'POST /api/v1/gttorderbook': () =>
        new Promise<ScriptedReply>((resolve) => {
          answerBook = () => resolve(gttBook([]))
        }),
    })
    await reviewSell()
    expect(screen.getByTestId('gtt-review-step')).toBeTruthy()
    expect(text('gtt-summary')).toBe(
      'GTT · SELL 1 RELIANCE · trigger 1,500.00 → LIMIT 1,499.00 · CNC',
    )
    expect(screen.queryByTestId('gtt-mode-badge')).toBeNull()
    expect(disabled('gtt-confirm')).toBe(true)

    await act(async () => answerMode())
    await pass(10)
    expect(text('gtt-mode-badge')).toBe('ANALYZE')
    // the book is still out
    expect(disabled('gtt-confirm')).toBe(true)
    await act(async () => answerBook())
    await pass(10)
    expect(disabled('gtt-confirm')).toBe(false)
    expect(text('gtt-confirm')).toBe('Place SELL GTT')
    expect(requests('placegttorder')).toHaveLength(0)
  })

  test('(order safety) a double tap sends one placegttorder; the result leads to the GTT list', async () => {
    let release = () => {}
    await setup({
      'POST /api/v1/placegttorder': () =>
        new Promise<ScriptedReply>((resolve) => {
          release = () => resolve(PLACED)
        }),
    })
    await reviewSell()
    // Two taps before the screen re-renders, in one act: Pressability's click is the press.
    const tap = screen.getByTestId('gtt-confirm').props.onClick as (e: object) => void
    await act(async () => {
      tap({})
      tap({})
    })
    await pass(10)
    expect(requests('placegttorder')).toHaveLength(1)
    expect(disabled('gtt-confirm')).toBe(true)
    await act(async () => release())
    await pass(200)
    expect(requests('placegttorder')).toHaveLength(1)
    // (RF 6) below the LTP: it fires on a fall
    expect(bodyOf('placegttorder')).toEqual({
      apikey: KEY,
      strategy: 'mobile',
      trigger_type: 'SINGLE',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      product: 'CNC',
      quantity: 1,
      pricetype: 'LIMIT',
      price: 1499,
      triggerprice_sl: 1500,
      triggerprice_tg: 0,
    })
    expect(text('gtt-result')).toBe('Sandbox · GTT placed')
    expect(text('gtt-result-id')).toBe('Trigger ID 1001')
    expect(screen.queryByTestId('gtt-confirm')).toBeNull()

    await press('gtt-view-list')
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/orders?segment=gtt')
    await press('gtt-done')
    expect(mockRouter.back).toHaveBeenCalledTimes(1)
  })

  test('(RF 6) a BUY trigger above the LTP goes as triggerprice_tg', async () => {
    await setup()
    await open({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' })
    await ltp(1800)
    await type('gtt-trigger', '1900')
    await type('gtt-price', '1901')
    await press('gtt-review')
    await press('gtt-confirm')
    expect(bodyOf('placegttorder')).toMatchObject({
      action: 'BUY',
      triggerprice_sl: 0,
      triggerprice_tg: 1900,
      price: 1901,
    })
  })

  test('(ruling 26) an LTP that crosses the trigger during the review: nothing is sent', async () => {
    await setup()
    await open({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' })
    await ltp(1800)
    await type('gtt-trigger', '1900')
    await type('gtt-price', '1901')
    await press('gtt-review')
    expect(disabled('gtt-confirm')).toBe(false)
    // reviewed as a rise; it would now go as a fall, and fire on the next tick
    await ltp(1950)
    await press('gtt-confirm')
    expect(requests('placegttorder')).toHaveLength(0)
    expect(text('gtt-error')).toBe('The price moved since the review. The GTT was not sent.')
    expect(screen.getByTestId('gtt-trigger').props.value).toBe('1900')
  })

  test('an OCO from the form: its four fields, its summary and its body', async () => {
    await setup()
    await open(SELL_RELIANCE)
    await ltp(1400)
    await press('gtt-type-OCO')
    await type('gtt-sl-trigger', '1300')
    await type('gtt-sl-price', '1299')
    await type('gtt-tg-trigger', '1500')
    await type('gtt-tg-price', '1501')
    await press('gtt-review')
    expect(text('gtt-summary')).toBe(
      'GTT OCO · SELL 1 RELIANCE · SL 1,300.00 → 1,299.00 · target 1,500.00 → 1,501.00 · CNC',
    )
    await press('gtt-confirm')
    expect(bodyOf('placegttorder')).toMatchObject({
      trigger_type: 'OCO',
      triggerprice_sl: 1300,
      stoploss: 1299,
      triggerprice_tg: 1500,
      target: 1501,
    })
    expect(text('gtt-result')).toBe('Sandbox · GTT placed')
  })

  test('the mode read differs from the badge: nothing is sent, and the review says so', async () => {
    const notSent = expectLog(
      'info',
      /\[orders\] gttPlace: the server is now in live mode, not sent$/,
    )
    let mode: 'live' | 'analyze' = 'analyze'
    await setup({ 'POST /api/v1/analyzer': () => analyzer(mode) })
    await reviewSell()
    expect(text('gtt-mode-badge')).toBe('ANALYZE')
    mode = 'live'
    // the gate's reading is older than 5 s
    await pass(6_000)
    await press('gtt-confirm')
    expect(requests('placegttorder')).toHaveLength(0)
    expect(notSent).toHaveLength(1)
    expect(screen.getByText('The server is now in LIVE mode. Review again.')).toBeTruthy()
    expect(text('gtt-mode-badge')).toBe('LIVE')
  })

  test('a refusal shows the server message back on the edit step', async () => {
    await setup({
      'POST /api/v1/placegttorder': {
        status: 400,
        body: {
          status: 'error',
          message: "{'quantity': ['Quantity must be a whole number.']}",
          mode: 'analyze',
        },
      },
    })
    await reviewSell()
    await press('gtt-confirm')
    expect(text('gtt-error')).toBe("{'quantity': ['Quantity must be a whole number.']}")
    expect(screen.getByTestId('gtt-review')).toBeTruthy()
  })

  test('reviewed as ANALYZE, answered without the sandbox tag: the danger notice', async () => {
    const warned = expectLog(
      'warn',
      /\[orders\] gttPlace: the review showed ANALYZE, but the server answered LIVE$/,
    )
    await setup({ 'POST /api/v1/placegttorder': ok({ status: 'success', trigger_id: '1001' }) })
    await reviewSell()
    await press('gtt-confirm')
    expect(text('live-surprise')).toBe(liveSurpriseText('gttPlace'))
    expect(text('gtt-result')).toBe('GTT placed')
    expect(warned).toHaveLength(1)
  })

  test('Semi-Auto: a queued reply shows the queued copy, the link opens the Action Center', async () => {
    await setup({
      'POST /api/v1/placegttorder': ok({
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: 7,
      }),
    })
    await reviewSell()
    await press('gtt-confirm')
    expect(screen.getByText('Queued for approval in the web Action Center')).toBeTruthy()
    expect(screen.queryByTestId('gtt-result')).toBeNull()
    await press('open-action-center')
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/action-center`)
  })

  test('blocked after the review opened: confirm is disabled', async () => {
    await setup()
    await reviewSell()
    expect(disabled('gtt-confirm')).toBe(false)
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    expect(screen.getByTestId('broker-banner-login')).toBeTruthy()
    expect(disabled('gtt-confirm')).toBe(true)
  })
})

describe('status unknown', () => {
  test('MaybePlaced: CHECKING, then the GTT book shows it; never a second send', async () => {
    let sent = false
    await setup({
      'POST /api/v1/placegttorder': () => {
        sent = true
        return BAD_GATEWAY
      },
      'POST /api/v1/gttorderbook': () => gttBook(sent ? [ROW] : []),
    })
    await reviewSell()
    await press('gtt-confirm')
    expect(screen.getByText(CHECKING)).toBeTruthy()
    await pass(2_100)
    expect(screen.getByText('The GTT book shows it: active.')).toBeTruthy()
    expect(screen.getByTestId('gtt-view-list')).toBeTruthy()
    for (const id of ['gtt-confirm', 'gtt-review']) expect(screen.queryByTestId(id)).toBeNull()
    await pass(130_000)
    expect(requests('placegttorder')).toHaveLength(1)
  })

  test('a GTT book unreadable at the review: a later match may be an earlier GTT', async () => {
    let sent = false
    await setup({
      'POST /api/v1/placegttorder': () => {
        sent = true
        return BAD_GATEWAY
      },
      'POST /api/v1/gttorderbook': () => (sent ? gttBook([ROW]) : 'throw'),
    })
    await reviewSell()
    // confirm waits while the read retries
    expect(disabled('gtt-confirm')).toBe(true)
    await pass(3_100)
    expect(disabled('gtt-confirm')).toBe(false)
    await press('gtt-confirm')
    await pass(2_100)
    expect(screen.queryByText(/The GTT book shows it/)).toBeNull()
    expect(
      screen.getByText(
        'A matching GTT is in the GTT book, but it may be an earlier one. Check the GTT list before trying again.',
      ),
    ).toBeTruthy()
  })

  test('a GTT already in the book at the review is not taken for this one', async () => {
    await setup({
      'POST /api/v1/placegttorder': BAD_GATEWAY,
      'POST /api/v1/gttorderbook': gttBook([ROW]),
    })
    await reviewSell()
    await press('gtt-confirm')
    await pass(130_000)
    expect(
      screen.getByText('The GTT book does not show it. Check the GTT list before trying again.'),
    ).toBeTruthy()
  })

  test("the mode changed at confirm: the review reads the new mode's book, so a GTT already in it is not taken for this one", async () => {
    const notSent = expectLog(
      'info',
      /\[orders\] gttPlace: the server is now in live mode, not sent$/,
    )
    let mode: 'live' | 'analyze' = 'analyze'
    // A strategy's LIVE GTT: the same contract, type and trigger, another side and quantity.
    const LIVE_ROW = {
      ...ROW,
      trigger_id: '2002',
      legs: [{ ...ROW.legs[0], action: 'BUY', quantity: 5 }],
    }
    await setup({
      'POST /api/v1/analyzer': () => analyzer(mode),
      'POST /api/v1/gttorderbook': () =>
        mode === 'analyze' ? gttBook([]) : gttBook([LIVE_ROW], { analyze: false }),
      'POST /api/v1/placegttorder': BAD_GATEWAY,
    })
    await reviewSell()
    expect(text('gtt-mode-badge')).toBe('ANALYZE')
    expect(requests('gttorderbook')).toHaveLength(1)
    mode = 'live'
    // the gate's reading is older than 5 s
    await pass(6_000)
    await press('gtt-confirm')
    expect(notSent).toHaveLength(1)
    expect(screen.getByText('The server is now in LIVE mode. Review again.')).toBeTruthy()
    expect(text('gtt-mode-badge')).toBe('LIVE')
    // the sandbox's book is not the LIVE one: the review reads it again, and confirm waits
    expect(requests('gttorderbook')).toHaveLength(2)
    await pass(200)
    expect(disabled('gtt-confirm')).toBe(false)
    await press('gtt-confirm')
    expect(requests('placegttorder')).toHaveLength(1)
    await pass(130_000)
    expect(screen.queryByText(/The GTT book shows it/)).toBeNull()
    expect(
      screen.getByText('The GTT book does not show it. Check the GTT list before trying again.'),
    ).toBeTruthy()
    expect(requests('placegttorder')).toHaveLength(1)
  })

  test('a GTT book that cannot be read says so', async () => {
    let sent = false
    await setup({
      'POST /api/v1/placegttorder': () => {
        sent = true
        return { status: 500, body: { status: 'error', message: 'Failed to place GTT' } }
      },
      'POST /api/v1/gttorderbook': () => (sent ? 'throw' : gttBook([])),
    })
    await reviewSell()
    await press('gtt-confirm')
    await pass(17_100)
    expect(
      screen.getByText("Couldn't check the GTT book. Check it before trying again."),
    ).toBeTruthy()
  })
})

describe('biometrics', () => {
  test('live with confirmLiveWrites on: a failed check sends nothing and says so', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(3)
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
    await setup({
      'POST /api/v1/analyzer': analyzer('live'),
      'POST /api/v1/gttorderbook': gttBook([], { analyze: false }),
    })
    await reviewSell()
    expect(text('gtt-mode-badge')).toBe('LIVE')
    await press('gtt-confirm')
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Confirm live order',
      disableDeviceFallback: false,
    })
    expect(requests('placegttorder')).toHaveLength(0)
    expect(screen.getByText(CONFIRM_FAILED)).toBeTruthy()
    expect(screen.getByTestId('gtt-confirm')).toBeTruthy()
  })
})

describe('modify', () => {
  test('a GTT no longer in the book, or no longer active, cannot be modified', async () => {
    await setup({ 'POST /api/v1/gttorderbook': gttBook([{ ...ROW, status: 'cancelled' }]) })
    await openModify('1001')
    expect(text('gtt-refused')).toBe('Only an active GTT can be modified.')
    expect(screen.queryByTestId('gtt-review')).toBeNull()

    await openModify('1002')
    expect(text('gtt-refused')).toBe('This GTT is no longer in the book.')
  })

  test('the form starts from the row, its type and side fixed; the body names the trigger id', async () => {
    await setup({
      'POST /api/v1/gttorderbook': gttBook([ROW]),
      'POST /api/v1/modifygttorder': PLACED,
    })
    await openModify('1001')
    expect(screen.getByTestId('gtt-trigger').props.value).toBe('1500')
    expect(screen.getByTestId('gtt-price').props.value).toBe('1499')
    for (const id of ['gtt-side-buy', 'gtt-side-sell', 'gtt-type-SINGLE', 'gtt-type-OCO']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    await ltp(1800)
    await type('gtt-trigger', '1450')
    await press('gtt-review')
    expect(text('gtt-confirm')).toBe('Modify SELL GTT')
    await press('gtt-confirm')
    expect(requests('modifygttorder')).toHaveLength(1)
    expect(bodyOf('modifygttorder')).toEqual({
      apikey: KEY,
      trigger_id: '1001',
      strategy: 'mobile',
      trigger_type: 'SINGLE',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      action: 'SELL',
      product: 'CNC',
      quantity: 1,
      pricetype: 'LIMIT',
      price: 1499,
      triggerprice_sl: 1450,
      triggerprice_tg: 0,
    })
    expect(text('gtt-result')).toBe('Sandbox · GTT modified')
  })

  test("(G2) an NRML GTT on NSE (Angel's MARGIN) is modified as NRML, never as its segment's CNC", async () => {
    const NRML_ROW = { ...ROW, legs: [{ ...ROW.legs[0], product: 'NRML' }] }
    await setup({
      'POST /api/v1/gttorderbook': gttBook([NRML_ROW]),
      'POST /api/v1/modifygttorder': PLACED,
    })
    await openModify('1001')
    expect(screen.getByText('SELL · Single · NRML')).toBeTruthy()
    await ltp(1800)
    await type('gtt-trigger', '1450')
    await press('gtt-review')
    expect(text('gtt-summary')).toBe(
      'GTT · SELL 1 RELIANCE · trigger 1,450.00 → LIMIT 1,499.00 · NRML',
    )
    await press('gtt-confirm')
    expect(requests('modifygttorder')).toHaveLength(1)
    expect(bodyOf('modifygttorder')).toMatchObject({
      trigger_id: '1001',
      exchange: 'NSE',
      product: 'NRML',
      pricetype: 'LIMIT',
      triggerprice_sl: 1450,
    })
  })

  test.each([
    ['MIS', { product: 'MIS' }, "This GTT's product (MIS) can't be modified here."],
    [
      'no product',
      { product: '' },
      "This GTT's product isn't listed, so it can't be modified here.",
    ],
    [
      'a MARKET leg',
      { pricetype: 'MARKET', price: 0 },
      "This GTT places a MARKET order, so it can't be modified here.",
    ],
  ])(
    'a row whose leg the ticket cannot send as listed (%s): no form, nothing sent',
    async (_, leg, refusal) => {
      await setup({
        'POST /api/v1/gttorderbook': gttBook([{ ...ROW, legs: [{ ...ROW.legs[0], ...leg }] }]),
        'POST /api/v1/modifygttorder': PLACED,
      })
      await openModify('1001')
      expect(text('gtt-refused')).toBe(refusal)
      expect(screen.queryByTestId('gtt-review')).toBeNull()
      expect(requests('modifygttorder')).toHaveLength(0)
    },
  )

  test('Semi-Auto in LIVE refuses it: the server text and the Action Center link, nothing retried', async () => {
    const REFUSAL = 'Modify GTT order is not allowed in Semi-Auto mode. Switch to Auto mode.'
    await setup({
      'POST /api/v1/analyzer': analyzer('live'),
      'POST /api/v1/gttorderbook': gttBook([ROW], { analyze: false }),
      'POST /api/v1/modifygttorder': { status: 403, body: { status: 'error', message: REFUSAL } },
    })
    await openModify('1001')
    await ltp(1800)
    await type('gtt-trigger', '1450')
    await press('gtt-review')
    await press('gtt-confirm')
    expect(text('banner-semi-auto-blocked')).toContain(REFUSAL)
    expect(screen.getByTestId('blocked-open-action-center')).toBeTruthy()
    await pass(30_000)
    expect(requests('modifygttorder')).toHaveLength(1)
  })

  test('MaybePlaced: CHECKING, then the GTT book shows the change', async () => {
    let sent = false
    await setup({
      'POST /api/v1/gttorderbook': () => gttBook([sent ? { ...ROW, trigger_prices: [1450] } : ROW]),
      'POST /api/v1/modifygttorder': () => {
        sent = true
        return BAD_GATEWAY
      },
    })
    await openModify('1001')
    await ltp(1800)
    await type('gtt-trigger', '1450')
    await press('gtt-review')
    await press('gtt-confirm')
    expect(screen.getByText(CHECKING)).toBeTruthy()
    await pass(2_100)
    expect(screen.getByText('The GTT book shows the change.')).toBeTruthy()
    expect(screen.getByTestId('gtt-view-list')).toBeTruthy()
    expect(requests('modifygttorder')).toHaveLength(1)
  })

  test('MaybePlaced, and the book still shows the old values: it says so', async () => {
    await setup({
      'POST /api/v1/gttorderbook': gttBook([ROW]),
      'POST /api/v1/modifygttorder': BAD_GATEWAY,
    })
    await openModify('1001')
    await ltp(1800)
    await type('gtt-trigger', '1450')
    await press('gtt-review')
    await press('gtt-confirm')
    await pass(130_000)
    expect(
      screen.getByText('The GTT book still shows the old values. Check it before trying again.'),
    ).toBeTruthy()
    expect(requests('modifygttorder')).toHaveLength(1)
  })

  test('reviewed as ANALYZE, answered without the sandbox tag: the danger notice', async () => {
    const warned = expectLog(
      'warn',
      /\[orders\] gttModify: the review showed ANALYZE, but the server answered LIVE$/,
    )
    await setup({
      'POST /api/v1/gttorderbook': gttBook([ROW]),
      'POST /api/v1/modifygttorder': ok({ status: 'success', trigger_id: '1001' }),
    })
    await openModify('1001')
    await ltp(1800)
    await press('gtt-review')
    await press('gtt-confirm')
    expect(text('live-surprise')).toBe(liveSurpriseText('gttModify'))
    expect(requests('modifygttorder')).toHaveLength(1)
    expect(warned).toHaveLength(1)
  })

  test('a 404 (the GTT fired meanwhile): its text, and the GTT book is read again', async () => {
    const GONE = "No active GTT with trigger_id '1001'"
    await setup({
      'POST /api/v1/gttorderbook': gttBook([ROW]),
      'POST /api/v1/modifygttorder': {
        status: 404,
        body: { status: 'error', message: GONE, mode: 'analyze' },
      },
    })
    await openModify('1001', { behind: true })
    await ltp(1800)
    await press('gtt-review')
    // the list's read beneath the sheet empties the read lane's bucket: the review's reads wait
    await pass(1_000)
    const reads = requests('gttorderbook').length
    await press('gtt-confirm')
    await pass(100)
    expect(text('gtt-error')).toBe(GONE)
    expect(requests('gttorderbook')).toHaveLength(reads + 1)
    expect(requests('modifygttorder')).toHaveLength(1)
  })
})
