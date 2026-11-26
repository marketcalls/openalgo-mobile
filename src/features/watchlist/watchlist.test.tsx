import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo, Alert, type AlertButton, View } from 'react-native'
import { profileStorage } from '~/core/config/storage'
import { ApiError } from '~/core/http/errors'
import { istDate } from '~/core/realtime/marketHours'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { createPollingEngine } from '~/core/realtime/polling'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { instrumentHref, searchHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { DEFAULT_WATCHLISTS, type Watchlists, WatchlistsSchema } from '~/market/watchlists/model'
import { loadWatchlists, saveWatchlists } from '~/market/watchlists/store'
import { ToastHost } from '~/ui/Toast'
import { buildTheme } from '~/ui/theme'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { newGroupId, newListId, useSeedQuotes } from './api'
import { WatchRow } from './components/WatchRow'
import { WatchlistScreen } from './screens/WatchlistScreen'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock
// The strip has its own tests (indexStrip.test.tsx); here it would add feed holds and poll consumers.
jest.mock('./components/IndexStrip', () => ({
  IndexStrip: () => {
    const { View } = require('react-native')
    return <View testID="index-strip" />
  },
}))
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))

const ORIGIN = 'https://algo.example.com'
/** The server's own validation refusal, put ahead of the broker results (quotes_service.py:30-36). */
const GONE =
  "Symbol 'NIFTY25NOV25FUT' not found for exchange 'NFO'. " +
  'Please verify the symbol name and ensure master contracts are downloaded.'
/** A broker failure: kotak and nuvama give every symbol of a failed batch `error: str(e)`. */
const TIMED_OUT = "HTTPSConnectionPool(host='api.example.com', port=443): Read timed out."

beforeEach(() => {
  keepExpectedLogs()
  jest.useFakeTimers()
  screenActive.mockReturnValue(true)
  useConnection.getState().reset()
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  mockPush.mockReset()
})

type Sym = { symbol: string; exchange: string }
type Call = (id: string, body: { symbols?: Sym[] } & Record<string, unknown>) => Promise<unknown>
type BookRow = { symbol: string; exchange: string; product: string; quantity: number }

/** multiquotes answers every symbol with a price, unless a test scripts the reply. */
const priced: Call = async (_id, body) =>
  (body.symbols ?? []).map((s) => ({ ...s, data: { ltp: 1500, prev_close: 1490 } }))

const setup = (
  o: {
    live?: boolean
    call?: Call
    seed?: Record<string, string>
    books?: { holdings?: BookRow[]; positions?: BookRow[] }
  } = {},
) => {
  let pending: (() => void) | null = null
  const store = createTickStore((fn) => {
    pending = fn
  })
  const flush = () =>
    act(async () => {
      const f = pending
      pending = null
      f?.()
    })
  const quotes = o.call ?? priced
  // The holdings marker's books, in their parsed shapes; every other id goes to `quotes`.
  const call = jest.fn(async (id: string, body: { symbols?: Sym[] } & Record<string, unknown>) => {
    if (id === 'holdings') return { rows: o.books?.holdings ?? [], stats: {}, dropped: 0 }
    if (id === 'positionbook') return { rows: o.books?.positions ?? [], dropped: 0 }
    return quotes(id, body)
  })
  const api = { call } as unknown as Services['api']
  const kv = memoryKV(o.seed)
  const polling = createPollingEngine({
    api,
    store,
    isLive: () => o.live ?? true,
    network: () => 'home',
    now: Date.now,
    isExchangeOpen: () => true,
  })
  /** The feed subscriptions rows hold now, by key. */
  const held = new Map<string, number>()
  const realtime = {
    acquire: jest.fn((r: Sym) => {
      const k = `${r.exchange}:${r.symbol}`
      held.set(k, (held.get(k) ?? 0) + 1)
      return () => held.set(k, (held.get(k) ?? 1) - 1)
    }),
    confirmedDepth: () => undefined,
  }
  const live = { realtime, polling, store } as unknown as LiveServices
  // no gc timer: it would hold the test process open
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  const services = {
    api,
    store,
    queryClient,
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1', restOrigin: ORIGIN }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  const wrap = (ui: React.ReactElement) => (
    <ServicesProvider value={services}>
      <QueryClientProvider client={queryClient}>
        <TradingProvider now={Date.now}>
          <TickStoreContext.Provider value={store}>
            <LiveContext.Provider value={live}>
              {ui}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </TradingProvider>
      </QueryClientProvider>
    </ServicesProvider>
  )
  const count = (id: string) => call.mock.calls.filter((c) => c[0] === id).length
  const saved = (): Watchlists =>
    WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))
  const holds = (k: string) => held.get(k) ?? 0
  /** The multiquotes requests' bodies, in order. */
  const seeds = () => call.mock.calls.filter((c) => c[0] === 'multiquotes').map((c) => c[1])
  return { store, flush, call, count, wrap, polling, holds, kv, saved, seeds }
}

/** Lets the storage reads, the seed and the store writes finish. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const later = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const lists = (...ls: { id: string; name: string; items: Sym[] }[]): Record<string, string> => ({
  'oa.p1.watchlists': JSON.stringify({ version: 1, activeId: ls[0]?.id, lists: ls }),
})

/** The default list's symbols, as added. */
const DEFAULT_ORDER = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'NIFTY']

/** The rows' symbols, top to bottom. */
const symbols = () =>
  screen
    .getAllByTestId(/^watch-row-/)
    .map((n) => String(n.props.testID).replace(/^watch-row-[A-Z_]+-/, ''))

/** The rows and group headers, top to bottom, by testID. */
const layout = () =>
  screen.getAllByTestId(/^(watch-row-|wl-group-\d+$)/).map((n) => String(n.props.testID))

/**
 * Leaves the screen and comes back (the instrument sheet opened and closed). Each render gets a
 * new element: React would skip one it has already rendered.
 */
const refocus = async (
  rerender: (ui: React.ReactElement) => Promise<unknown>,
  ui: () => React.ReactElement,
) => {
  screenActive.mockReturnValue(false)
  await rerender(ui())
  screenActive.mockReturnValue(true)
  await rerender(ui())
  await settle()
}

const ITEMS = [{ exchange: 'NSE', symbol: 'RELIANCE' }]
let seeded: ReadonlySet<string> = new Set()
const Probe = ({ items = ITEMS }: { items?: Sym[] }) => {
  seeded = useSeedQuotes(items).unknown
  return <WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />
}

const tick = async (h: ReturnType<typeof setup>, ltp: number) => {
  h.store.put('NSE:RELIANCE', { ltp, close: 1490 }, 'ws')
  await h.flush()
}

/** Answers the next Alert with the button labelled `label`. */
const answerAlert = (label: string) =>
  jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons?: AlertButton[]) => {
    const b = buttons?.find((x) => x.text === label)
    if (!b) throw new Error(`no ${label} button`)
    b.onPress?.()
  })

/** A left swipe of `dx` px on a row, through its responder handlers. */
async function swipe(id: string, dx: number) {
  const el = screen.getByTestId(`watch-swipe-${id}`)
  const at = (x: number, prev: number, ts: number) => ({
    nativeEvent: { touches: [{}], changedTouches: [] },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ts,
      touchBank: [
        {
          touchActive: true,
          startPageX: 300,
          startPageY: 20,
          startTimeStamp: 1,
          currentPageX: x,
          currentPageY: 20,
          currentTimeStamp: ts,
          previousPageX: prev,
          previousPageY: 20,
          previousTimeStamp: ts - 1,
        },
      ],
    },
  })
  // The responder system's order: start capture (resets), move capture (measures), then ask.
  el.props.onStartShouldSetResponderCapture(at(300, 300, 1))
  el.props.onMoveShouldSetResponderCapture(at(300 + dx, 300, 10))
  expect(el.props.onMoveShouldSetResponder(at(300 + dx, 300, 10))).toBe(true)
  await act(async () => {
    el.props.onResponderGrant(at(300 + dx, 300, 10))
    el.props.onResponderMove(at(300 + dx, 300, 20))
    el.props.onResponderRelease(at(300 + dx, 300 + dx, 30))
  })
  await settle()
}

describe('watchlist storage', () => {
  test('the first load seeds the defaults under oa.<pid>.watchlists', async () => {
    const kv = memoryKV()
    const s = profileStorage(kv, 'p1')
    const w = await loadWatchlists(s)
    expect(w).toEqual(DEFAULT_WATCHLISTS)
    expect(WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))).toEqual(
      DEFAULT_WATCHLISTS,
    )
    const list = DEFAULT_WATCHLISTS.lists[0]
    expect(list?.id).toBe('default')
    expect(list?.name).toBe('Watchlist')
    expect(list?.items.map((i) => `${i.exchange}:${i.symbol}`)).toEqual([
      'NSE:RELIANCE',
      'NSE:TCS',
      'NSE:INFY',
      'NSE:HDFCBANK',
      'NSE:ICICIBANK',
      'NSE:SBIN',
      'NSE_INDEX:NIFTY',
    ])
  })

  test('a saved list is loaded back, not replaced by the defaults', async () => {
    const s = profileStorage(memoryKV(), 'p1')
    await loadWatchlists(s)
    const mine = {
      version: 2 as const,
      activeId: 'default',
      lists: [
        {
          id: 'default',
          name: 'Mine',
          items: [{ exchange: 'NSE', symbol: 'ITC' }],
          groups: [],
          sort: 'added' as const,
        },
      ],
    }
    await saveWatchlists(s, mine)
    expect(await loadWatchlists(s)).toEqual(mine)
  })
})

describe('WatchRow', () => {
  test('shows -- , then the seeded price after focus, then a later WS tick', async () => {
    const h = setup()
    await render(h.wrap(<Probe />))
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('--')
    await settle()
    await h.flush()
    expect(h.call).toHaveBeenCalledTimes(1)
    expect(h.call.mock.calls[0]?.[0]).toBe('multiquotes')
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,500.00')
    await tick(h, 1502.5)
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,502.50')
    expect(screen.getByText('NSE')).toBeTruthy()
    expect(screen.getByText('RELIANCE')).toBeTruthy()
  })

  test('a stale feed dims the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    const opacity = () => {
      const st = screen.getByTestId('watch-row-NSE-RELIANCE').props.style
      return [st].flat(3).find((x: { opacity?: number } | undefined) => x?.opacity !== undefined)
        ?.opacity
    }
    expect(opacity()).toBe(1)
    await act(async () => h.store.setStale(true))
    expect(opacity()).toBe(0.5)
  })

  test('a price change flashes for 400 ms; reduced motion has no flash', async () => {
    const h = setup()
    const { rerender } = await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" />))
    await tick(h, 1500)
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull() // first quote is no change
    await tick(h, 1501)
    expect(screen.getByTestId('watch-flash-NSE-RELIANCE')).toBeTruthy()
    await act(async () => void jest.advanceTimersByTime(400))
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull()

    await rerender(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    await tick(h, 1502)
    expect(screen.queryByTestId('watch-flash-NSE-RELIANCE')).toBeNull()
  })

  test('a row has no B/S; a press opens the instrument sheet', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    expect(screen.queryByTestId('watch-buy-NSE-RELIANCE')).toBeNull()
    expect(screen.queryByTestId('watch-sell-NSE-RELIANCE')).toBeNull()
    expect(screen.getByTestId('watch-ex-NSE-RELIANCE')).toHaveTextContent('NSE')
    await fireEvent.press(screen.getByTestId('watch-row-NSE-RELIANCE'))
    expect(mockPush).toHaveBeenCalledWith(instrumentHref('NSE', 'RELIANCE'))
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  test('NIFTY shows INDICES under its symbol', async () => {
    const h = setup()
    await render(h.wrap(<WatchRow exchange="NSE_INDEX" symbol="NIFTY" reduceMotion />))
    expect(screen.getByTestId('watch-ex-NSE_INDEX-NIFTY')).toHaveTextContent('INDICES')
    expect(screen.queryByTestId('watch-held-NSE_INDEX-NIFTY')).toBeNull()
  })

  test('the held marker shows whole and fractional quantities, never -0, and is labelled held or short', async () => {
    const h = setup()
    const held: [string, string, number][] = [
      ['CRYPTO', 'BTCUSDT', 0.004],
      ['CRYPTO', 'ETHUSDT', -0.3],
      ['NSE', 'RELIANCE', 10],
      ['NSE', 'TCS', -25],
      ['NSE', 'SBIN', 1234567],
      ['CRYPTO', 'SOLUSDT', 1.234567],
      // float noise from summed fractional rows
      ['CRYPTO', 'XRPUSDT', -1e-12],
    ]
    await render(
      h.wrap(
        <View>
          {held.map(([ex, sym, q]) => (
            <WatchRow key={sym} exchange={ex} symbol={sym} held={q} reduceMotion />
          ))}
        </View>,
      ),
    )
    const marker = (ex: string, sym: string) => screen.getByTestId(`watch-held-${ex}-${sym}`)
    const shown: [string, string, string, string][] = [
      ['CRYPTO', 'BTCUSDT', '0.004', 'Held 0.004'],
      ['CRYPTO', 'ETHUSDT', '-0.3', 'Short 0.3'],
      ['NSE', 'RELIANCE', '10', 'Held 10'],
      ['NSE', 'TCS', '-25', 'Short 25'],
      ['NSE', 'SBIN', '12,34,567', 'Held 12,34,567'],
      ['CRYPTO', 'SOLUSDT', '1.2346', 'Held 1.2346'],
      ['CRYPTO', 'XRPUSDT', '0', 'Held 0'],
    ]
    for (const [ex, sym, text, label] of shown) {
      expect(marker(ex, sym)).toHaveTextContent(text, { exact: true })
      expect(marker(ex, sym)).toHaveAccessibleName(label)
    }
    expect(screen.getByLabelText('Short 25')).toBe(marker('NSE', 'TCS'))
  })

  test('the price is in the colour of the day change', async () => {
    const h = setup()
    const { trade, c } = buildTheme('dark')
    await render(h.wrap(<WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />))
    const ltp = () => screen.getByTestId('watch-ltp-NSE-RELIANCE')
    await tick(h, 1500)
    expect(ltp()).toHaveStyle({ color: trade.profit })
    await tick(h, 1480)
    expect(ltp()).toHaveStyle({ color: trade.loss })
    await tick(h, 1490)
    expect(ltp()).toHaveStyle({ color: c.foreground })
  })
})

describe('newListId', () => {
  test('an id from the time, moved on past any list that has it', () => {
    const t = 1_764_000_000_000
    const w = { ...DEFAULT_WATCHLISTS, lists: [] }
    expect(newListId(w, t)).toBe(`l${t.toString(36)}`)
    const taken = {
      ...w,
      lists: [
        { id: `l${t.toString(36)}`, name: 'A', items: [], groups: [], sort: 'added' as const },
      ],
    }
    expect(newListId(taken, t)).toBe(`l${(t + 1).toString(36)}`)
  })
})

describe('newGroupId', () => {
  test('an id from the time with the g prefix, moved on past any group of the list that has it', () => {
    const t = 1_764_000_000_000
    const list = DEFAULT_WATCHLISTS.lists[0]
    if (!list) throw new Error('no default list')
    expect(newGroupId(list, t)).toBe(`g${t.toString(36)}`)
    const taken = { ...list, groups: [{ id: `g${t.toString(36)}`, name: 'Banks' }] }
    expect(newGroupId(taken, t)).toBe(`g${(t + 1).toString(36)}`)
  })
})

describe('useSeedQuotes', () => {
  test('returns the keys whose multiquotes entry carried an error', async () => {
    const h = setup({
      call: async () => [
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
      ],
    })
    const items = [...ITEMS, { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }]
    await render(h.wrap(<Probe items={items} />))
    await settle()
    expect([...seeded]).toEqual(['NFO:NIFTY25NOV25FUT'])
  })

  test("adds a seed 400's invalid_symbols", async () => {
    const h = setup({
      call: async () => {
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    await render(h.wrap(<Probe items={[{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }]} />))
    await settle()
    expect([...seeded]).toEqual(['NFO:NIFTY25NOV25FUT'])
  })

  test("a whole-batch 400 for one entry's exchange marks that entry, by its index, and no other", async () => {
    const h = setup({
      call: async () => {
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          refusedAt: [1],
        })
      },
    })
    const items = [...ITEMS, { exchange: 'NCO', symbol: 'CRUDEOIL' }]
    await render(h.wrap(<Probe items={items} />))
    await settle()
    expect([...seeded]).toEqual(['NCO:CRUDEOIL'])
  })

  test('a broker failure entry is not a refusal: no key joins the set', async () => {
    const h = setup({
      call: async (_id, body) => (body.symbols ?? []).map((s) => ({ ...s, error: TIMED_OUT })),
    })
    const items = [...ITEMS, { exchange: 'NFO', symbol: 'NIFTY30DEC25FUT' }]
    await render(h.wrap(<Probe items={items} />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect([...seeded]).toEqual([])
  })

  test("the server's other refusal, an exchange it does not accept, is unknown too", async () => {
    const h = setup({
      call: async () => [
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
        {
          symbol: 'CRUDEOIL',
          exchange: 'NCO',
          error: "Invalid exchange 'NCO'. Must be one of: NSE, NFO, CDS, BSE, BFO, BCD, MCX",
        },
      ],
    })
    await render(h.wrap(<Probe items={[...ITEMS, { exchange: 'NCO', symbol: 'CRUDEOIL' }]} />))
    await settle()
    expect([...seeded]).toEqual(['NCO:CRUDEOIL'])
  })
})

describe('WatchlistScreen', () => {
  test('the index strip sits above the lists', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('index-strip')).toBeOnTheScreen()
  })

  test('a focus reads one multiquotes, holdings and positionbook, then nothing; a refocus within 60 s reads only multiquotes', async () => {
    const h = setup({ live: true })
    const ui = () => h.wrap(<WatchlistScreen />)
    const { rerender } = await render(ui())
    await settle()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).toBeTruthy()
    expect(screen.getByTestId('watch-row-NSE_INDEX-NIFTY')).toBeTruthy()
    expect(h.kv.data.has('oa.p1.watchlists')).toBe(true)
    expect(h.count('multiquotes')).toBe(1)
    expect(h.count('holdings')).toBe(1)
    expect(h.count('positionbook')).toBe(1)
    expect(h.call).toHaveBeenCalledTimes(3)
    expect(h.seeds()[0]).toEqual({
      symbols: DEFAULT_WATCHLISTS.lists[0]?.items.map((i) => ({
        symbol: i.symbol,
        exchange: i.exchange,
      })),
    })
    await later(30_000)
    expect(h.call).toHaveBeenCalledTimes(3)
    // the instrument sheet opened and closed twice, within the books' 60 s
    await refocus(rerender, ui)
    await later(5_000)
    await refocus(rerender, ui)
    await later(5_000)
    expect(h.count('multiquotes')).toBe(3)
    expect(h.count('holdings')).toBe(1)
    expect(h.count('positionbook')).toBe(1)
  })

  test('waits for the saved lists: the seed asks for the saved list, never the defaults', async () => {
    const h = setup({
      seed: lists({ id: 'a', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'ITC' }] }),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.seeds()).toEqual([{ symbols: [{ symbol: 'ITC', exchange: 'NSE' }] }])
    expect(screen.getByTestId('watch-row-NSE-ITC')).toBeOnTheScreen()
    expect(screen.queryByTestId('watch-row-NSE-RELIANCE')).toBeNull()
  })

  test('wl-search-add opens search to add to the active list', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('wl-search')).toBeNull()
    expect(screen.queryByTestId('wl-add')).toBeNull()
    await fireEvent.press(screen.getByTestId('wl-search-add'))
    expect(mockPush).toHaveBeenCalledWith(searchHref({ addTo: 'default' }))
    expect(mockPush).toHaveBeenCalledWith('/search?addTo=default')
  })

  test('wl-count reads 7/250 for the defaults, and the active tab is underlined', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('wl-count')).toHaveTextContent('7/250')
    const tab = screen.getByTestId('wl-tab-default')
    expect(tab).toBeSelected()
    expect(tab).toHaveStyle({
      borderBottomWidth: 2,
      borderBottomColor: buildTheme('dark').c.primary,
    })
    expect(tab).toHaveTextContent('Watchlist')
  })

  test('holdings RELIANCE 10, a short TCS -50 and a closed INFY: the marker shows 10 and -50, none for INFY', async () => {
    const h = setup({
      books: {
        holdings: [{ symbol: 'RELIANCE', exchange: 'NSE', product: 'CNC', quantity: 10 }],
        positions: [
          { symbol: 'TCS', exchange: 'NSE', product: 'MIS', quantity: -50 },
          { symbol: 'INFY', exchange: 'NSE', product: 'MIS', quantity: 0 },
        ],
      },
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    // react-query tells its observers from a 0 ms timer
    await later(1)
    expect(screen.getByTestId('watch-held-NSE-RELIANCE')).toHaveTextContent('10')
    expect(screen.getByTestId('watch-held-NSE-TCS')).toHaveTextContent('-50')
    expect(screen.queryByTestId('watch-held-NSE-INFY')).toBeNull()
    expect(screen.queryByTestId('watch-held-NSE-SBIN')).toBeNull()
    // and the seeded price, up on the day, is in the profit colour
    await h.flush()
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveStyle({
      color: buildTheme('dark').trade.profit,
    })
  })

  test('wl-sort then wl-sort-AZ orders the rows by symbol and saves the sort', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(symbols()).toEqual(DEFAULT_ORDER)
    await fireEvent.press(screen.getByTestId('wl-sort'))
    expect(screen.getByTestId('wl-sort-ADDED')).toBeChecked()
    await fireEvent.press(screen.getByTestId('wl-sort-AZ'))
    await settle()
    expect(screen.queryByTestId('wl-sort-AZ')).toBeNull()
    expect(symbols()).toEqual(['HDFCBANK', 'ICICIBANK', 'INFY', 'NIFTY', 'RELIANCE', 'SBIN', 'TCS'])
    expect(h.saved().lists[0]?.sort).toBe('az')
    expect(h.saved().lists[0]?.items.map((i) => i.symbol)).toEqual(DEFAULT_ORDER)
  })

  test('a % change sort is a snapshot: a tick that would reorder waits for the next focus', async () => {
    const ltp: Record<string, number> = {}
    const h = setup({
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) => ({
          ...s,
          data: { ltp: ltp[s.symbol] ?? 1500, prev_close: 1490 },
        })),
    })
    const ui = () => h.wrap(<WatchlistScreen />)
    const { rerender } = await render(ui())
    await settle()
    await fireEvent.press(screen.getByTestId('wl-sort'))
    await fireEvent.press(screen.getByTestId('wl-sort-CHANGE'))
    await settle()
    expect(h.saved().lists[0]?.sort).toBe('change')
    // every symbol is up 0.67%: ties keep the added order
    expect(symbols()).toEqual(DEFAULT_ORDER)
    ltp.SBIN = 1600
    ltp.TCS = 1400
    await act(async () => {
      h.store.put('NSE:SBIN', { ltp: 1600, close: 1490 }, 'ws')
      h.store.put('NSE:TCS', { ltp: 1400, close: 1490 }, 'ws')
    })
    await h.flush()
    expect(screen.getByTestId('watch-ltp-NSE-SBIN')).toHaveTextContent('1,600.00')
    expect(symbols()).toEqual(DEFAULT_ORDER)
    // nor does a render that is not a focus
    await rerender(ui())
    await settle()
    expect(symbols()).toEqual(DEFAULT_ORDER)
    await refocus(rerender, ui)
    expect(symbols()).toEqual(['SBIN', 'RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'NIFTY', 'TCS'])
  })

  test('with the seed skipped (blocked), the refocus alone retakes the snapshot', async () => {
    const h = setup()
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const ui = () => h.wrap(<WatchlistScreen />)
    const { rerender } = await render(ui())
    await settle()
    await fireEvent.press(screen.getByTestId('wl-sort'))
    await fireEvent.press(screen.getByTestId('wl-sort-CHANGE'))
    await settle()
    // no seed, so no prices: the added order
    expect(symbols()).toEqual(DEFAULT_ORDER)
    await act(async () => {
      h.store.put('NSE:SBIN', { ltp: 1600, close: 1490 }, 'ws')
      h.store.put('NSE:TCS', { ltp: 1400, close: 1490 }, 'ws')
    })
    await h.flush()
    expect(symbols()).toEqual(DEFAULT_ORDER)
    await refocus(rerender, ui)
    expect(h.count('multiquotes')).toBe(0)
    // the priced rows first, by % change; the rest keep the added order
    expect(symbols()).toEqual(['SBIN', 'TCS', 'RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'NIFTY'])
  })

  test('a later seed outside a focus does not retake the snapshot: the session turning active, a broker login', async () => {
    const ltp: Record<string, number> = {}
    const h = setup({
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) => ({
          ...s,
          data: { ltp: ltp[s.symbol] ?? 1500, prev_close: 1490 },
        })),
    })
    const ui = () => h.wrap(<WatchlistScreen />)
    const { rerender } = await render(ui())
    await settle()
    await fireEvent.press(screen.getByTestId('wl-sort'))
    await fireEvent.press(screen.getByTestId('wl-sort-CHANGE'))
    await settle()
    expect(symbols()).toEqual(DEFAULT_ORDER)
    // a later seed's prices are newer than the first's
    await later(1_000)
    ltp.SBIN = 1600
    ltp.TCS = 1400
    // from "unknown", the session turns active: the unknown set clears and the list is seeded again
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    await h.flush()
    expect(h.count('multiquotes')).toBe(2)
    expect(screen.getByTestId('watch-ltp-NSE-SBIN')).toHaveTextContent('1,600.00')
    expect(symbols()).toEqual(DEFAULT_ORDER)
    // the broker logs out and in again: blocked flips, and the list is seeded once more
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await settle()
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    await h.flush()
    expect(h.count('multiquotes')).toBe(3)
    expect(symbols()).toEqual(DEFAULT_ORDER)
    // the next focus takes the snapshot
    await refocus(rerender, ui)
    expect(symbols()).toEqual(['SBIN', 'RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'NIFTY', 'TCS'])
  })

  test('the first seed after a list switch retakes the snapshot', async () => {
    const h = setup({
      seed: {
        'oa.p1.watchlists': JSON.stringify({
          version: 2,
          activeId: 'a',
          lists: [
            {
              id: 'a',
              name: 'One',
              sort: 'added',
              groups: [],
              items: [{ exchange: 'NSE', symbol: 'RELIANCE' }],
            },
            {
              id: 'b',
              name: 'Two',
              sort: 'ltp',
              groups: [],
              items: [
                { exchange: 'NSE', symbol: 'ITC' },
                { exchange: 'NSE', symbol: 'SBIN' },
              ],
            },
          ],
        }),
      },
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) => ({
          ...s,
          data: { ltp: s.symbol === 'SBIN' ? 800 : 400, prev_close: 390 },
        })),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-tab-b'))
    await settle()
    expect(h.seeds().at(-1)).toEqual({
      symbols: [
        { symbol: 'ITC', exchange: 'NSE' },
        { symbol: 'SBIN', exchange: 'NSE' },
      ],
    })
    expect(symbols()).toEqual(['SBIN', 'ITC'])
  })

  test('a sort chosen while a seed is out is retaken once that seed lands', async () => {
    const ltp: Record<string, number> = {}
    let holding = false
    let release: (() => void) | undefined
    const answer = (body: { symbols?: Sym[] }) =>
      (body.symbols ?? []).map((s) => ({
        ...s,
        data: { ltp: ltp[s.symbol] ?? 1500, prev_close: 1490 },
      }))
    const h = setup({
      call: (_id, body) =>
        holding
          ? new Promise((resolve) => {
              release = () => resolve(answer(body))
            })
          : Promise.resolve(answer(body)),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await later(1_000)
    ltp.SBIN = 1600
    ltp.TCS = 1400
    holding = true
    // the session turns active: a seed outside a focus goes out
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(h.count('multiquotes')).toBe(2)
    await fireEvent.press(screen.getByTestId('wl-sort'))
    await fireEvent.press(screen.getByTestId('wl-sort-CHANGE'))
    await settle()
    // the store's prices are all up 0.67% yet
    expect(symbols()).toEqual(DEFAULT_ORDER)
    await act(async () => release?.())
    await settle()
    expect(symbols()).toEqual(['SBIN', 'RELIANCE', 'INFY', 'HDFCBANK', 'ICICIBANK', 'NIFTY', 'TCS'])
  })

  test('a sort chosen at the last session applies once the first seed lands', async () => {
    const h = setup({
      seed: {
        'oa.p1.watchlists': JSON.stringify({
          version: 2,
          activeId: 'a',
          lists: [
            {
              id: 'a',
              name: 'Mine',
              sort: 'ltp',
              groups: [],
              items: [
                { exchange: 'NSE', symbol: 'ITC' },
                { exchange: 'NSE', symbol: 'SBIN' },
              ],
            },
          ],
        }),
      },
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) => ({
          ...s,
          data: { ltp: s.symbol === 'SBIN' ? 800 : 400, prev_close: 390 },
        })),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(symbols()).toEqual(['SBIN', 'ITC'])
  })

  test('wl-manage then wl-list-down-0 reorders the lists and saves', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        { id: 'b', name: 'Two', items: [{ exchange: 'NSE', symbol: 'SBIN' }] },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-manage'))
    expect(screen.getByTestId('wl-list-0')).toHaveTextContent(/One/)
    expect(screen.getByTestId('wl-list-up-0')).toBeDisabled()
    expect(screen.getByTestId('wl-list-down-1')).toBeDisabled()
    await fireEvent.press(screen.getByTestId('wl-list-down-0'))
    await settle()
    expect(h.saved().lists.map((l) => l.id)).toEqual(['b', 'a'])
    expect(screen.getByTestId('wl-list-0')).toHaveTextContent(/Two/)
    const tabs = screen.getAllByTestId(/^wl-tab-/).map((n) => n.props.testID)
    expect(tabs).toEqual(['wl-tab-b', 'wl-tab-a'])
    // the active list stays the one shown
    expect(screen.getByTestId('wl-tab-a')).toBeSelected()
    await fireEvent.press(screen.getByTestId('wl-manage-done'))
    expect(screen.queryByTestId('wl-list-0')).toBeNull()
  })

  test('the manage sheet renames and deletes a list; the last list has no delete there', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        { id: 'b', name: 'Two', items: [{ exchange: 'NSE', symbol: 'SBIN' }] },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-manage'))
    await fireEvent.press(screen.getByTestId('wl-list-rename-1'))
    expect(screen.getByTestId('wl-name-input').props.value).toBe('Two')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Swing')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()
    expect(h.saved().lists.map((l) => l.name)).toEqual(['One', 'Swing'])
    // back to the lists, still in the sheet
    expect(screen.getByTestId('wl-list-1')).toHaveTextContent(/Swing/)

    const confirmed = answerAlert('Delete')
    await fireEvent.press(screen.getByTestId('wl-list-delete-1'))
    await settle()
    expect(confirmed.mock.calls[0]?.[0]).toBe('Delete Swing and its 1 symbol?')
    expect(h.saved().lists.map((l) => l.id)).toEqual(['a'])
    expect(screen.getByTestId('wl-list-delete-0')).toBeDisabled()
  })

  test('the remove action confirms, removes and saves', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(alert).toHaveBeenCalledWith(
      'Remove TCS from Watchlist?',
      undefined,
      expect.any(Array),
      expect.anything(),
    )
    expect(screen.queryByTestId('watch-row-NSE-TCS')).toBeNull()
    expect(h.saved().lists[0]?.items.map((i) => i.symbol)).not.toContain('TCS')
    expect(h.saved().lists[0]?.items).toHaveLength(6)
  })

  test('a cancelled remove keeps the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Cancel')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.getByTestId('watch-row-NSE-TCS')).toBeOnTheScreen()
    expect(h.saved().lists[0]?.items).toHaveLength(7)
  })

  test('a left swipe past the threshold asks to remove; a short one does nothing', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await swipe('NSE-INFY', -40)
    expect(alert).not.toHaveBeenCalled()
    alert.mockRestore()

    const confirmed = answerAlert('Remove')
    await swipe('NSE-INFY', -150)
    expect(confirmed.mock.calls[0]?.[0]).toBe('Remove INFY from Watchlist?')
    expect(screen.queryByTestId('watch-row-NSE-INFY')).toBeNull()
    expect(h.saved().lists[0]?.items.map((i) => i.symbol)).not.toContain('INFY')
  })

  test('edit mode moves rows up and down and saves; regrouping needs a group', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('wl-up-NSE-TCS')).toBeNull()
    expect(screen.queryByTestId('wl-new-group')).toBeNull()
    await fireEvent.press(screen.getByTestId('wl-edit'))
    expect(screen.getByTestId('wl-up-NSE-RELIANCE')).toBeDisabled()
    expect(screen.getByTestId('wl-down-NSE_INDEX-NIFTY')).toBeDisabled()
    expect(screen.queryByTestId('wl-regroup-NSE-TCS')).toBeNull()
    expect(screen.getByTestId('wl-new-group')).toBeOnTheScreen()

    await fireEvent.press(screen.getByTestId('wl-up-NSE-TCS'))
    await settle()
    const order = () => h.saved().lists[0]?.items.map((i) => i.symbol)
    expect(order()?.slice(0, 3)).toEqual(['TCS', 'RELIANCE', 'INFY'])
    await fireEvent.press(screen.getByTestId('wl-down-NSE-RELIANCE'))
    await settle()
    expect(order()?.slice(0, 3)).toEqual(['TCS', 'INFY', 'RELIANCE'])
    expect(screen.getByTestId('wl-up-NSE-TCS')).toBeDisabled()

    const alert = answerAlert('Remove')
    await fireEvent.press(screen.getByTestId('wl-remove-NSE-SBIN'))
    await settle()
    expect(alert.mock.calls[0]?.[0]).toBe('Remove SBIN from Watchlist?')
    expect(order()).not.toContain('SBIN')

    await fireEvent.press(screen.getByTestId('wl-edit'))
    expect(screen.queryByTestId('wl-up-NSE-TCS')).toBeNull()
    expect(screen.queryByTestId('wl-new-group')).toBeNull()
  })

  test('in edit mode, wl-new-group named Banks shows wl-group-0; wl-regroup then wl-move-0 puts HDFCBANK under it', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-edit'))
    await fireEvent.press(screen.getByTestId('wl-new-group'))
    expect(screen.getByText('New group')).toBeOnTheScreen()
    expect(screen.getByTestId('wl-name-input').props.value).toBe('')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Banks')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    expect(screen.getByTestId('wl-group-0')).toHaveTextContent(/Banks/)
    const group = h.saved().lists[0]?.groups[0]
    expect(group?.name).toBe('Banks')
    expect(group?.id).toMatch(/^g/)

    await fireEvent.press(screen.getByTestId('wl-regroup-NSE-HDFCBANK'))
    expect(screen.getByTestId('wl-move-none')).toBeChecked()
    await fireEvent.press(screen.getByTestId('wl-move-0'))
    await settle()
    expect(screen.queryByTestId('wl-move-0')).toBeNull()
    const saved = h.saved().lists[0]?.items.find((i) => i.symbol === 'HDFCBANK')
    expect(saved).toEqual({ exchange: 'NSE', symbol: 'HDFCBANK', group: group?.id })
    expect(layout().slice(-2)).toEqual(['wl-group-0', 'watch-row-NSE-HDFCBANK'])
    expect(screen.getByTestId('wl-group-0')).toHaveTextContent(/1/)
    // alone in its group, it cannot move up or down
    expect(screen.getByTestId('wl-up-NSE-HDFCBANK')).toBeDisabled()
    expect(screen.getByTestId('wl-down-NSE-HDFCBANK')).toBeDisabled()
    // NIFTY is now the last ungrouped row
    expect(screen.getByTestId('wl-down-NSE_INDEX-NIFTY')).toBeDisabled()
  })

  test('a stored list with groups shows them after the ungrouped rows; groups reorder, and Delete keeps their symbols', async () => {
    const h = setup({
      seed: {
        'oa.p1.watchlists': JSON.stringify({
          version: 2,
          activeId: 'a',
          lists: [
            {
              id: 'a',
              name: 'Mine',
              sort: 'added',
              groups: [
                { id: 'g1', name: 'Banks' },
                { id: 'g2', name: 'IT' },
              ],
              items: [
                { exchange: 'NSE', symbol: 'HDFCBANK', group: 'g1' },
                { exchange: 'NSE', symbol: 'TCS', group: 'g2' },
                { exchange: 'NSE', symbol: 'ITC' },
              ],
            },
          ],
        }),
      },
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(layout()).toEqual([
      'watch-row-NSE-ITC',
      'wl-group-0',
      'watch-row-NSE-HDFCBANK',
      'wl-group-1',
      'watch-row-NSE-TCS',
    ])
    expect(screen.getByTestId('wl-group-0')).toHaveTextContent(/Banks/)
    expect(screen.queryByTestId('wl-group-menu-0')).toBeNull()

    await fireEvent.press(screen.getByTestId('wl-edit'))
    expect(screen.getByTestId('wl-group-up-0')).toBeDisabled()
    expect(screen.getByTestId('wl-group-down-1')).toBeDisabled()
    await fireEvent.press(screen.getByTestId('wl-group-down-0'))
    await settle()
    expect(h.saved().lists[0]?.groups.map((g) => g.id)).toEqual(['g2', 'g1'])
    expect(screen.getByTestId('wl-group-1')).toHaveTextContent(/Banks/)

    answerAlert('Delete')
    const confirmed = answerAlert('Delete')
    await fireEvent.press(screen.getByTestId('wl-group-menu-1'))
    await settle()
    expect(confirmed.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'Delete group Banks?',
      'Its symbols stay in the list.',
    ])
    const doc = h.saved().lists[0]
    expect(doc?.groups.map((g) => g.id)).toEqual(['g2'])
    expect(doc?.items.find((i) => i.symbol === 'HDFCBANK')).toEqual({
      exchange: 'NSE',
      symbol: 'HDFCBANK',
    })
    expect(screen.getByTestId('watch-row-NSE-HDFCBANK')).toBeOnTheScreen()
    expect(screen.queryByTestId('wl-group-1')).toBeNull()
  })

  test('a group menu renames the group', async () => {
    const h = setup({
      seed: {
        'oa.p1.watchlists': JSON.stringify({
          version: 2,
          activeId: 'a',
          lists: [
            {
              id: 'a',
              name: 'Mine',
              sort: 'added',
              groups: [{ id: 'g1', name: 'Banks' }],
              items: [{ exchange: 'NSE', symbol: 'HDFCBANK', group: 'g1' }],
            },
          ],
        }),
      },
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-edit'))
    answerAlert('Rename')
    await fireEvent.press(screen.getByTestId('wl-group-menu-0'))
    expect(screen.getByText('Rename group')).toBeOnTheScreen()
    expect(screen.getByTestId('wl-name-input').props.value).toBe('Banks')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Lenders')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()
    expect(h.saved().lists[0]?.groups).toEqual([{ id: 'g1', name: 'Lenders' }])
    expect(screen.getByTestId('wl-group-0')).toHaveTextContent(/Lenders/)
  })

  test('wl-new asks for a name, prefilled; the new list appears, becomes active and starts empty', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('wl-new')).toBeNull()
    await fireEvent.press(screen.getByTestId('wl-manage'))
    await fireEvent.press(screen.getByTestId('wl-new'))
    expect(screen.getByTestId('wl-name-input').props.value).toBe('Watchlist 2')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), '  Swing  ')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()

    const doc = h.saved()
    expect(doc.lists.map((l) => l.name)).toEqual(['Watchlist', 'Swing'])
    const id = doc.lists[1]?.id ?? ''
    expect(id).not.toBe('default')
    expect(doc.activeId).toBe(id)
    expect(screen.getByTestId(`wl-tab-${id}`)).toBeSelected()
    expect(screen.getByTestId('wl-tab-default')).not.toBeSelected()
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    // the sheet closed on the new list
    expect(screen.queryByTestId('wl-manage-done')).toBeNull()
    expect(screen.getByText('This list is empty')).toBeOnTheScreen()
    expect(screen.getByTestId('wl-count')).toHaveTextContent('0/250')
    await fireEvent.press(screen.getByTestId('wl-empty-add'))
    expect(mockPush).toHaveBeenCalledWith(searchHref({ addTo: id }))
  })

  test('a tab press shows that list and seeds its symbols', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        { id: 'b', name: 'Two', items: [{ exchange: 'NSE', symbol: 'SBIN' }] },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('wl-tab-a')).toBeSelected()
    await fireEvent.press(screen.getByTestId('wl-tab-b'))
    await settle()
    expect(screen.getByTestId('wl-tab-b')).toBeSelected()
    expect(screen.getByTestId('watch-row-NSE-SBIN')).toBeOnTheScreen()
    expect(screen.queryByTestId('watch-row-NSE-ITC')).toBeNull()
    expect(h.saved().activeId).toBe('b')
    expect(h.seeds().at(-1)).toEqual({ symbols: [{ symbol: 'SBIN', exchange: 'NSE' }] })
  })

  test('cancelling the name changes nothing; at 50 lists wl-new says so instead', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-manage'))
    await fireEvent.press(screen.getByTestId('wl-new'))
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Swing')
    await fireEvent.press(screen.getByTestId('wl-name-cancel'))
    await settle()
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    expect(screen.getByTestId('wl-list-0')).toBeOnTheScreen()
    expect(h.saved().lists).toHaveLength(1)

    const full = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, name: `L${i}`, items: [] }))
    const f = setup({ seed: lists(...full) })
    await render(f.wrap(<WatchlistScreen />))
    await settle()
    await fireEvent.press(screen.getByTestId('wl-manage'))
    await fireEvent.press(screen.getByTestId('wl-new'))
    expect(screen.queryByTestId('wl-name-input')).toBeNull()
    // closed, so the toast is not hidden under it
    expect(screen.queryByTestId('wl-manage-done')).toBeNull()
    expect(screen.getByTestId('toast')).toHaveTextContent('You can keep up to 50 lists.')
  })

  test('a failed save says so and keeps the row', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const warned = expectLog('warn', /could not save the lists/)
    h.kv.set = async () => {
      throw new Error('disk full')
    }
    answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NSE-TCS'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.getByTestId('toast')).toHaveTextContent('Could not save your lists. Try again.')
    expect(screen.getByTestId('watch-row-NSE-TCS')).toBeOnTheScreen()
    expect(warned).toHaveLength(1)
  })

  test('a long press renames a list', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Rename')
    await fireEvent(screen.getByTestId('wl-tab-default'), 'longPress')
    expect(screen.getByTestId('wl-name-input').props.value).toBe('Watchlist')
    await fireEvent.changeText(screen.getByTestId('wl-name-input'), 'Long term')
    await fireEvent.press(screen.getByTestId('wl-name-save'))
    await settle()
    expect(screen.getByTestId('wl-tab-default')).toHaveTextContent('Long term')
    expect(h.saved().lists[0]?.name).toBe('Long term')
  })

  test('a long press deletes a list after confirming with its name and symbol count', async () => {
    const h = setup({
      seed: lists(
        { id: 'a', name: 'One', items: [{ exchange: 'NSE', symbol: 'ITC' }] },
        {
          id: 'b',
          name: 'Swing',
          items: [
            { exchange: 'NSE', symbol: 'SBIN' },
            { exchange: 'NSE', symbol: 'TCS' },
          ],
        },
      ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    answerAlert('Delete')
    const confirmed = answerAlert('Delete')
    await fireEvent(screen.getByTestId('wl-tab-b'), 'longPress')
    await settle()
    expect(confirmed.mock.calls.at(-1)?.[0]).toBe('Delete Swing and its 2 symbols?')
    expect(screen.queryByTestId('wl-tab-b')).toBeNull()
    expect(h.saved().lists.map((l) => l.id)).toEqual(['a'])
  })

  test('deleting the last list shows "Keep at least one list." and asks nothing more', async () => {
    const h = setup()
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    const alert = answerAlert('Delete')
    await fireEvent(screen.getByTestId('wl-tab-default'), 'longPress')
    await settle()
    expect(alert).toHaveBeenCalledTimes(1) // the menu; no delete confirm
    expect(screen.getByTestId('toast')).toHaveTextContent('Keep at least one list.')
    expect(screen.getByTestId('wl-tab-default')).toBeOnTheScreen()
    expect(h.saved().lists).toHaveLength(1)
  })

  test('a multiquotes error entry shows "Expired or unknown", with no price and no /symbol call', async () => {
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async () => [
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
      ],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(screen.queryByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toBeOnTheScreen()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).not.toHaveTextContent(/Expired/)
    expect(h.count('symbol')).toBe(0)
    // once known, an unknown key holds no feed subscription and no poll
    expect(h.holds('NFO:NIFTY25NOV25FUT')).toBe(0)
    expect(h.holds('NSE:RELIANCE')).toBe(1)
    expect(h.polling.stats().consumers).toBe(1)
    // and can still be removed
    answerAlert('Remove')
    await fireEvent(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT'), 'accessibilityAction', {
      nativeEvent: { actionName: 'remove' },
    })
    await settle()
    expect(screen.queryByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toBeNull()
  })

  test('a broker error entry, not the server\'s "not found", is not badged', async () => {
    const h = setup({
      seed: lists({ id: 'a', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'RELIANCE' }] }),
      call: async () => [{ symbol: 'RELIANCE', exchange: 'NSE', error: TIMED_OUT }],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.queryByTestId('watch-unknown-NSE-RELIANCE')).toBeNull()
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).not.toHaveTextContent(/Expired/)
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toBeOnTheScreen()
    // the row stays live: it holds the feed, and the next tick lands
    expect(h.holds('NSE:RELIANCE')).toBe(1)
    await tick(h, 1502.5)
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,502.50')
  })

  test('the broker session turning active again forgets the refusals and asks again', async () => {
    let listed = false // the server has not downloaded its master contracts yet
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) =>
          s.symbol === 'NIFTY25NOV25FUT' && !listed
            ? { ...s, error: GONE }
            : { ...s, data: { ltp: 1500, prev_close: 1490 } },
        ),
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    listed = true
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(h.count('multiquotes')).toBe(2)
    expect(h.seeds()[1]?.symbols).toContainEqual({
      symbol: 'NIFTY25NOV25FUT',
      exchange: 'NFO',
    })
    expect(screen.queryByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeNull()
    expect(screen.getByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await h.flush()
    expect(screen.getByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toHaveTextContent('1,500.00')
  })

  test("the session turning active during the server's symbol-table reload: every symbol refused, then a later seed restores the prices", async () => {
    let reloading = false
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NSE', symbol: 'ITC' },
        ],
      }),
      call: async (_id, body) =>
        (body.symbols ?? []).map((s) =>
          reloading ? { ...s, error: GONE } : { ...s, data: { ltp: 1500, prev_close: 1490 } },
        ),
    })
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    // back from "Log in to your broker": the server deletes and refills its symbol table
    reloading = true
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(screen.getByTestId('watch-unknown-NSE-RELIANCE')).toBeOnTheScreen()
    reloading = false
    // the refusals were tentative: within minutes the rows are asked for again
    await later(3 * 60_000)
    await settle()
    expect(screen.queryByTestId('watch-unknown-NSE-RELIANCE')).toBeNull()
    expect(screen.queryByTestId('watch-unknown-NSE-ITC')).toBeNull()
    await h.flush()
    expect(screen.getByTestId('watch-ltp-NSE-RELIANCE')).toHaveTextContent('1,500.00')
  })

  test('from "unknown", the session turning active forgets the refusals and seeds again', async () => {
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: async () => [
        { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO', error: GONE },
        { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp: 1500, prev_close: 1490 } },
      ],
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    expect(useConnection.getState().brokerSession).toBe('unknown')
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    // still refused: badged again, and asked once, not in a loop
    expect(h.count('multiquotes')).toBe(2)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(2)
  })

  test('a reply sent before a clear does not bring its refusals back', async () => {
    const replies: ((refuse: string[]) => void)[] = []
    const h = setup({
      seed: lists({
        id: 'a',
        name: 'Mine',
        items: [
          { exchange: 'NSE', symbol: 'RELIANCE' },
          { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
        ],
      }),
      call: (_id, body) =>
        new Promise((resolve) => {
          replies.push((refuse) =>
            resolve(
              (body.symbols ?? []).map((s) =>
                refuse.includes(s.symbol)
                  ? { ...s, error: GONE.replaceAll('NIFTY25NOV25FUT', s.symbol) }
                  : { ...s, data: { ltp: 1500, prev_close: 1490 } },
              ),
            ),
          )
        }),
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    replies[0]?.(['NIFTY25NOV25FUT'])
    await settle()
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    // a refocus asks for RELIANCE only; the session turns active while that is out
    screenActive.mockReturnValue(false)
    await rerender(h.wrap(<WatchlistScreen />))
    screenActive.mockReturnValue(true)
    await rerender(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.seeds()[1]?.symbols).toEqual([{ symbol: 'RELIANCE', exchange: 'NSE' }])
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    await settle()
    expect(h.count('multiquotes')).toBe(3)
    // the old reply refuses RELIANCE, the new one lists both: neither is badged
    replies[1]?.(['RELIANCE'])
    await settle()
    replies[2]?.([])
    await settle()
    expect(screen.queryByTestId('watch-unknown-NSE-RELIANCE')).toBeNull()
    expect(screen.queryByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeNull()
  })

  test('a new IST day forgets the refusals: the next focus asks once more', async () => {
    jest.setSystemTime(Date.UTC(2026, 10, 24, 9, 30)) // 15:00 IST
    const h = setup({
      live: false,
      seed: lists({
        id: 'a',
        name: 'Expired',
        items: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
      }),
      call: async () => {
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    const refocus = async () => {
      screenActive.mockReturnValue(false)
      await rerender(h.wrap(<WatchlistScreen />))
      screenActive.mockReturnValue(true)
      await rerender(h.wrap(<WatchlistScreen />))
      await settle()
    }
    // the same IST day: nothing is asked again
    await refocus()
    expect(h.count('multiquotes')).toBe(1)
    jest.setSystemTime(Date.UTC(2026, 10, 25, 3, 45)) // 09:15 IST, the next day
    await refocus()
    expect(h.count('multiquotes')).toBe(2)
    expect(screen.getByTestId('watch-unknown-NFO-NIFTY25NOV25FUT')).toBeOnTheScreen()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(2)
    expect(h.polling.stats().consumers).toBe(0)
  })

  test('RF 1: a list of only NIFTY25NOV25FUT gets a seed 400, then no more multiquotes', async () => {
    const h = setup({
      live: false, // polling mode: a live row would poll every 2 s
      seed: lists({
        id: 'a',
        name: 'Expired',
        items: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
      }),
      call: async (id) => {
        if (id !== 'multiquotes') throw new Error(`unexpected ${id}`)
        throw new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'multiquotes',
          serverMessage: GONE,
          invalidSymbols: [{ exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' }],
        })
      },
    })
    const { rerender } = await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(screen.queryByTestId('watch-ltp-NFO-NIFTY25NOV25FUT')).toBeNull()
    await later(10_000)
    expect(h.count('multiquotes')).toBe(1)
    // focusing again does not ask for it again
    screenActive.mockReturnValue(false)
    await rerender(h.wrap(<WatchlistScreen />))
    screenActive.mockReturnValue(true)
    await rerender(h.wrap(<WatchlistScreen />))
    await later(10_000)
    expect(h.count('multiquotes')).toBe(1)
    expect(h.count('symbol')).toBe(0)
    expect(h.polling.stats().consumers).toBe(0)
    expect(h.holds('NFO:NIFTY25NOV25FUT')).toBe(0)
  })

  test('a key the instrument cache already marks unknown is shown so and never seeded', async () => {
    const h = setup({
      seed: {
        ...lists({
          id: 'a',
          name: 'Mine',
          items: [
            { exchange: 'NSE', symbol: 'ITC' },
            { exchange: 'NFO', symbol: 'NIFTY25NOV25FUT' },
          ],
        }),
        'oa.p1.instruments': JSON.stringify({
          day: istDate(Date.now()),
          items: [],
          unknown: [{ k: 'NFO:NIFTY25NOV25FUT', at: Date.now() }],
        }),
      },
    })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    expect(screen.getByTestId('watch-row-NFO-NIFTY25NOV25FUT')).toHaveTextContent(
      /Expired or unknown/,
    )
    expect(h.seeds()).toEqual([{ symbols: [{ symbol: 'ITC', exchange: 'NSE' }] }])
  })

  test('blocked: focusing makes zero multiquotes calls; unblocking seeds', async () => {
    const h = setup({ live: true })
    useConnection.getState().set({ brokerSession: 'logged_out' })
    await render(h.wrap(<WatchlistScreen />))
    await settle()
    await later(10_000)
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).toBeOnTheScreen()
    expect(h.count('multiquotes')).toBe(0)
    await act(async () => useConnection.getState().set({ keyState: 'invalid' }))
    await later(10_000)
    expect(h.count('multiquotes')).toBe(0)
    await act(async () => useConnection.getState().set({ brokerSession: 'active', keyState: 'ok' }))
    await settle()
    expect(h.count('multiquotes')).toBe(1)
  })
})
