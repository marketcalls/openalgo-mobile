import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { Capabilities } from '~/core/capabilities/gates'
import { profileStorage } from '~/core/config/storage'
import { ApiError } from '~/core/http/errors'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { type DepthBook, parseInbound, tickToPatch } from '~/core/realtime/protocol'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { chartHref, gttHref, optionChainHref, ticketHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { WatchlistsSchema } from '~/market/watchlists/model'
import { SHEET_CLOSE_MS } from '~/ui/sheetMath'
import { ToastHost } from '~/ui/Toast'
import { buildTheme } from '~/ui/theme'
import { memoryKV } from '../../../test/helpers/memoryKV'
import ChartRoute from '../../app/(app)/chart/[key]'
import InstrumentRoute from '../../app/(app)/instrument/[key]'
import OptionChainRoute from '../../app/(app)/optionchain/[key]'
import ToolRoute from '../../app/(app)/tools/[toolId]'
import { InstrumentSheet } from './screens/InstrumentSheet'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const mockReplace = jest.fn()
const mockBack = jest.fn()
let mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack }),
  useLocalSearchParams: () => mockParams,
}))

beforeEach(() => {
  ;(useScreenActive as jest.Mock).mockReturnValue(true)
  useConnection.getState().reset()
})
afterEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
})

const { trade } = buildTheme('dark')

const NOT_FOUND = new ApiError({
  kind: 'Unsupported',
  status: 404,
  endpoint: 'symbol',
  serverMessage: 'Symbol GONE not found in exchange NFO',
})

/** The `/symbol` names of the derivatives here: the underlying, as the server lists it. */
const NAMES: Record<string, string> = {
  NIFTY30DEC26FUT: 'NIFTY',
  USDINR26DEC26FUT: 'USDINR',
}

const CAPS: Capabilities = {
  host: 'https://algo.example.com',
  version: '2.0.3.5',
  versionSource: 'app-info',
  endpoints: ['gttorderbook', 'placegttorder'],
  probed: {},
  fields: {},
  features: {},
  ws: { orderStream: true, ping: true, close1012: true, authDeadline: true },
  probedAt: 1,
}

type SetupOptions = {
  /** The probed caps; none (not probed yet) by default. */
  caps?: Capabilities
  /** The server's broker, as the ping saved it on the profile. */
  broker?: string
}

const setup = (seed: Record<string, string> = {}, o: SetupOptions = {}) => {
  const store = createTickStore((fn) => fn(), { evictAfterMs: 0 })
  const kv = memoryKV(seed)
  const call = jest.fn(async (id: string, body: Record<string, string>) => {
    if (id === 'symbol') {
      if (body.symbol === 'GONE') throw NOT_FOUND
      const name = NAMES[body.symbol ?? ''] ?? `${body.symbol} FULL NAME`
      return { symbol: body.symbol, exchange: body.exchange, name }
    }
    throw new Error(`unexpected ${id}`)
  })
  const acquire = jest.fn((_r: unknown) => () => {})
  const realtime = {
    acquire,
    isLive: () => false,
    confirmedDepth: () => undefined,
    status: () => ({ broker: null }),
    onStatus: () => () => {},
  }
  const polling = { register: () => () => {}, health: () => 'none', onHealth: () => () => {} }
  const live = { realtime, polling, store } as unknown as LiveServices
  const caps = { get: () => o.caps ?? null, subscribe: () => () => {}, setFeature: jest.fn() }
  const services = {
    api: { call },
    store,
    realtime,
    polling,
    caps,
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1', broker: o.broker ?? null }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  // no gc timer: it would hold the test process open
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  const tree = (node: React.ReactElement) => (
    <ServicesProvider value={services}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={client}>
          <TickStoreContext.Provider value={store}>
            <LiveContext.Provider value={live}>
              {node}
              <ToastHost />
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  )
  const show = (exchange: string, symbol: string) =>
    render(tree(<InstrumentSheet exchange={exchange} symbol={symbol} />))
  const saved = () => WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))
  const requested = () => call.mock.calls.map(([id]) => id)
  return { store, call, acquire, show, tree, saved, requested }
}

const settle = () =>
  act(async () => {
    // react-query tells its observers from a 0 ms timer
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const open = async (
  exchange: string,
  symbol: string,
  seed?: Record<string, string>,
  o?: SetupOptions,
) => {
  const h = setup(seed, o)
  await h.show(exchange, symbol)
  await settle()
  return h
}

/** A market_data frame as the socket sends it, through the app's own parse into the store. */
const tick = (h: ReturnType<typeof setup>, ex: string, sym: string, data: object) =>
  act(async () => {
    const m = parseInbound(JSON.stringify({ type: 'market_data', symbol: sym, exchange: ex, data }))
    if (m?.t !== 'tick') throw new Error('not a tick')
    h.store.put(`${ex}:${sym}`, tickToPatch(m.data), 'ws')
  })

/** `n` priced levels a side, the best bid and ask first. */
const book = (n: number): DepthBook => ({
  buy: Array.from({ length: n }, (_, i) => ({ price: 1423.9 - i, quantity: 100 + i, orders: 1 })),
  sell: Array.from({ length: n }, (_, i) => ({ price: 1424 + i, quantity: 100 + i, orders: 2 })),
  levels: n,
})

const modes = (h: ReturnType<typeof setup>) => h.acquire.mock.calls.map(([r]) => r)
const expand = () => fireEvent.press(screen.getByTestId('instrument-sheet-handle'))

describe('the header', () => {
  test('the symbol, then the exchange, LTP and change in the colour of the change', async () => {
    const h = await open('NSE', 'RELIANCE')
    await act(async () => h.store.put('NSE:RELIANCE', { ltp: 1500, close: 1490 }, 'ws'))
    expect(screen.getByText('RELIANCE')).toBeTruthy()
    expect(screen.getByTestId('inst-sub')).toHaveTextContent('NSE · 1,500.00 +10.00 (+0.67%)')
    expect(screen.getByTestId('inst-ltp').props.children).toBe('1,500.00')
    expect(screen.getByTestId('inst-ltp')).toHaveStyle({ color: trade.profit })
    expect(screen.getByTestId('inst-change')).toHaveStyle({ color: trade.profit })
    await act(async () => h.store.put('NSE:RELIANCE', { ltp: 1480 }, 'ws'))
    expect(screen.getByTestId('inst-ltp')).toHaveStyle({ color: trade.loss })
    expect(screen.getByTestId('inst-change').props.children.join('')).toContain('-10.00')
  })

  test('an index shows INDICES for its exchange', async () => {
    await open('NSE_INDEX', 'NIFTY')
    expect(screen.getByTestId('inst-sub')).toHaveTextContent(/^INDICES · /)
  })
})

describe('indices', () => {
  test('NIFTY has no BUY, SELL, depth or GTT; its option chain opens its own', async () => {
    const h = await open('NSE_INDEX', 'NIFTY', {}, { caps: gttCaps(true), broker: 'zerodha' })
    await act(() => useConnection.getState().set({ analyzer: 'live' }))
    expect(screen.queryByTestId('inst-buy')).toBeNull()
    expect(screen.queryByTestId('inst-sell')).toBeNull()
    expect(screen.queryByTestId('depth-ladder')).toBeNull()
    expect(screen.queryByTestId('skeleton')).toBeNull()
    expect(screen.queryByTestId('inst-gtt')).toBeNull()
    // the quote alone, in mode 2: there is no book to hold
    expect(modes(h)).toEqual([{ exchange: 'NSE_INDEX', symbol: 'NIFTY', mode: 2 }])
    await fireEvent.press(screen.getByTestId('inst-optionchain'))
    expect(mockReplace).toHaveBeenLastCalledWith('/optionchain/NSE_INDEX%3ANIFTY')
  })

  test('INDIAVIX has no option chain', async () => {
    await open('NSE_INDEX', 'INDIAVIX')
    expect(screen.getByTestId('inst-chart')).toBeTruthy()
    expect(screen.queryByTestId('inst-optionchain')).toBeNull()
  })
})

describe('trading', () => {
  test('BUY and SELL replace the sheet with the ticket on that side; View chart opens the chart', async () => {
    await open('NSE', 'RELIANCE')
    expect(screen.getByTestId('inst-buy')).toHaveTextContent('BUY')
    await fireEvent.press(screen.getByTestId('inst-buy'))
    expect(mockReplace).toHaveBeenLastCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' }),
    )
    await fireEvent.press(screen.getByTestId('inst-sell'))
    expect(mockReplace).toHaveBeenLastCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL' }),
    )
    expect(screen.getByTestId('inst-chart')).toHaveTextContent('View chart')
    await fireEvent.press(screen.getByTestId('inst-chart'))
    expect(mockReplace).toHaveBeenLastCalledWith(chartHref('NSE', 'RELIANCE'))
    expect(screen.queryByTestId('inst-depth')).toBeNull()
  })

  test('BUY and SELL are disabled while the broker is logged out', async () => {
    await open('NSE', 'RELIANCE')
    await act(() => useConnection.getState().set({ brokerSession: 'logged_out' }))
    expect(screen.getByTestId('inst-buy')).toBeDisabled()
    expect(screen.getByTestId('inst-sell')).toBeDisabled()
    await fireEvent.press(screen.getByTestId('inst-buy'))
    await fireEvent.press(screen.getByTestId('inst-sell'))
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

describe('depth', () => {
  test('the ladder shows inside the sheet, and a bid opens a SELL LIMIT ticket at its price', async () => {
    useConnection.getState().set({ feed: 'live' })
    const h = await open('NSE', 'RELIANCE')
    await act(async () => h.store.put('NSE:RELIANCE', { ltp: 1424, depth: book(5) }, 'ws'))
    expect(screen.getByTestId('depth-ladder')).toBeOnTheScreen()
    await fireEvent.press(screen.getByTestId('depth-bid-0'))
    expect(mockReplace).toHaveBeenLastCalledWith(
      ticketHref({
        exchange: 'NSE',
        symbol: 'RELIANCE',
        action: 'SELL',
        pricetype: 'LIMIT',
        price: 1423.9,
      }),
    )
    // the panel's book is the sheet's one subscription: the header only reads its quote
    expect(modes(h)).toEqual([{ exchange: 'NSE', symbol: 'RELIANCE', mode: 3, depth: 5 }])
  })
})

/** Caps on which a GTT reply for zerodha in LIVE showed `seen`. */
function gttCaps(seen: boolean): Capabilities {
  return { ...CAPS, features: { 'gtt:zerodha:live': seen } }
}

describe('Create GTT', () => {
  test('shows while the server serves GTT for the broker in this mode, and opens the GTT ticket', async () => {
    const h = await open('NSE', 'RELIANCE', {}, { caps: gttCaps(true), broker: 'zerodha' })
    expect(screen.queryByTestId('inst-gtt')).toBeNull() // the mode is not known yet
    await act(() => useConnection.getState().set({ analyzer: 'live' }))
    expect(screen.getByTestId('inst-gtt')).toHaveTextContent('Create GTT')
    await fireEvent.press(screen.getByTestId('inst-gtt'))
    expect(mockReplace).toHaveBeenLastCalledWith(gttHref({ exchange: 'NSE', symbol: 'RELIANCE' }))
    expect(h.requested()).not.toContain('gttorderbook')
  })

  test.each([
    ['a GTT reply showed none', { caps: gttCaps(false), broker: 'zerodha' }],
    ['the server is not probed yet', { broker: 'zerodha' }],
  ])('is hidden when %s', async (_n, o) => {
    const h = await open('NSE', 'RELIANCE', {}, o)
    await act(() => useConnection.getState().set({ analyzer: 'live' }))
    expect(screen.getByTestId('inst-buy')).toBeTruthy()
    expect(screen.queryByTestId('inst-gtt')).toBeNull()
    expect(h.requested()).not.toContain('gttorderbook')
  })
})

describe('option chain', () => {
  test.each([
    ['NFO', 'NIFTY30DEC26FUT', optionChainHref('NSE_INDEX', 'NIFTY')],
    ['CDS', 'USDINR26DEC26FUT', optionChainHref('CDS', 'USDINR')],
  ])("%s %s opens its underlying's chain", async (ex, sym, href) => {
    await open(ex, sym)
    expect(screen.getByTestId('inst-optionchain')).toHaveTextContent('Option chain')
    await fireEvent.press(screen.getByTestId('inst-optionchain'))
    expect(mockReplace).toHaveBeenLastCalledWith(href)
  })

  test('an NSE stock has none (until the symbol master can tell)', async () => {
    await open('NSE', 'RELIANCE')
    expect(screen.queryByTestId('inst-optionchain')).toBeNull()
  })
})

describe('(RF 5) the sheet without a drag', () => {
  const QUOTE = {
    ltp: 1424.5,
    open: 1410,
    high: 1430,
    low: 1405.25,
    close: 1418,
    volume: 1234567,
    average_price: 1420.1,
    last_quantity: 25,
    ltt: 1764150045, // 15:10:45 IST, in epoch seconds
    upper_circuit: '1559.8',
    lower_circuit: '1276.2',
  }

  test('the quote details show only at full height: the handle toggles them', async () => {
    const h = await open('NSE', 'RELIANCE')
    await tick(h, 'NSE', 'RELIANCE', QUOTE)
    expect(screen.queryByTestId('inst-quote-details')).toBeNull()
    await expand()
    expect(screen.getByTestId('inst-quote-details')).toBeOnTheScreen()
    const figure = (id: string) => screen.getByTestId(`inst-q-${id}`)
    expect(figure('open')).toHaveTextContent('1,410.00')
    expect(figure('high')).toHaveTextContent('1,430.00')
    expect(figure('low')).toHaveTextContent('1,405.25')
    expect(figure('close')).toHaveTextContent('1,418.00')
    expect(figure('volume')).toHaveTextContent('12,34,567')
    expect(figure('avg')).toHaveTextContent('1,420.10')
    expect(figure('ltq')).toHaveTextContent('25')
    expect(figure('ltt')).toHaveTextContent('15:10:45')
    expect(figure('lc')).toHaveTextContent('1,276.20')
    expect(figure('uc')).toHaveTextContent('1,559.80')
    // equities have no open interest
    expect(screen.queryByTestId('inst-q-oi')).toBeNull()
    await expand()
    expect(screen.queryByTestId('inst-quote-details')).toBeNull()
  })

  test('a figure the quote does not carry is left out; contracts in lots show OI', async () => {
    const h = await open('NFO', 'NIFTY30DEC26FUT')
    await tick(h, 'NFO', 'NIFTY30DEC26FUT', { ltp: 24100, close: 24000, oi: 750000 })
    await expand()
    expect(screen.getByTestId('inst-q-oi')).toHaveTextContent('7,50,000')
    expect(screen.getByTestId('inst-q-close')).toHaveTextContent('24,000.00')
    for (const id of ['open', 'high', 'low', 'volume', 'avg', 'ltq', 'ltt', 'lc', 'uc']) {
      expect(screen.queryByTestId(`inst-q-${id}`)).toBeNull()
    }
  })

  test('an index shows its quote details from its own mode-2 quote', async () => {
    const h = await open('NSE_INDEX', 'NIFTY')
    await tick(h, 'NSE_INDEX', 'NIFTY', { ltp: 24100, close: 24000, high: 24150 })
    await expand()
    expect(screen.getByTestId('inst-q-high')).toHaveTextContent('24,150.00')
  })

  test('the backdrop closes the sheet: router.back once it has slid down', async () => {
    await open('NSE', 'RELIANCE')
    jest.useFakeTimers()
    await fireEvent.press(screen.getByTestId('instrument-sheet-backdrop'))
    await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS - 1))
    expect(mockBack).not.toHaveBeenCalled()
    await act(async () => jest.advanceTimersByTime(1))
    expect(mockBack).toHaveBeenCalledTimes(1)
  })
})

describe('unchanged', () => {
  test('an expired contract shows only that: no actions, no depth and no feed slot', async () => {
    const h = await open('NFO', 'GONE')
    expect(screen.getByTestId('inst-unknown')).toBeTruthy()
    await expand()
    for (const id of ['inst-buy', 'inst-chart', 'inst-optionchain', 'inst-gtt', 'depth-ladder']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
    expect(screen.queryByTestId('inst-ltp')).toBeNull()
    expect(screen.queryByTestId('inst-quote-details')).toBeNull()
    expect(h.acquire).not.toHaveBeenCalled()
  })

  test('inst-watch adds to the active list, then removes', async () => {
    const h = await open('NSE', 'WIPRO')
    expect(screen.getByTestId('inst-watch')).toHaveAccessibleName('Add to Watchlist')
    await fireEvent.press(screen.getByTestId('inst-watch'))
    await settle()
    expect(h.saved().lists[0]?.items).toContainEqual({ exchange: 'NSE', symbol: 'WIPRO' })
    expect(screen.getByTestId('inst-watch')).toHaveAccessibleName('Remove from Watchlist')
    await fireEvent.press(screen.getByTestId('inst-watch'))
    await settle()
    expect(h.saved().lists[0]?.items).not.toContainEqual({ exchange: 'NSE', symbol: 'WIPRO' })
  })
})

describe('the instrument route', () => {
  test('a malformed link says so, in a sheet that closes', async () => {
    mockParams = { key: 'NSE' }
    await render(setup().tree(<InstrumentRoute />))
    expect(screen.getByText('This link is incomplete.')).toBeTruthy()
    jest.useFakeTimers()
    await fireEvent.press(screen.getByTestId('instrument-sheet-backdrop'))
    await act(async () => jest.advanceTimersByTime(SHEET_CLOSE_MS))
    expect(mockBack).toHaveBeenCalledTimes(1)
  })
})

describe('placeholder routes', () => {
  test('the chart route says charts are not in this build', async () => {
    await render(<ChartRoute />)
    expect(screen.getByText("Charts aren't in this build yet.")).toBeTruthy()
    expect(screen.getByText('They arrive in the next update.')).toBeTruthy()
  })

  test('the option chain route says option chains are not in this build', async () => {
    mockParams = { key: 'NSE_INDEX%3ANIFTY' }
    await render(<OptionChainRoute />)
    expect(screen.getByText("Option chains aren't in this build yet.")).toBeTruthy()
  })

  test('the tools route names option chains, or tools', async () => {
    mockParams = { toolId: 'optionchain' }
    const a = await render(<ToolRoute />)
    expect(screen.getByText("Option chains aren't in this build yet.")).toBeTruthy()
    await a.unmount()
    mockParams = { toolId: 'greeks' }
    await render(<ToolRoute />)
    expect(screen.getByText("Tools aren't in this build yet.")).toBeTruthy()
  })
})
