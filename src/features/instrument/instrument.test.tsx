import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { profileStorage } from '~/core/config/storage'
import { ApiError } from '~/core/http/errors'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { chartHref, depthHref, ticketHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { WatchlistsSchema } from '~/market/watchlists/model'
import { ToastHost } from '~/ui/Toast'
import { memoryKV } from '../../../test/helpers/memoryKV'
import ChartRoute from '../../app/(app)/chart/[key]'
import ToolRoute from '../../app/(app)/tools/[toolId]'
import { InstrumentSheet } from './screens/InstrumentSheet'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const mockReplace = jest.fn()
let mockToolId = 'optionchain'
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({ toolId: mockToolId }),
}))

beforeEach(() => {
  ;(useScreenActive as jest.Mock).mockReturnValue(true)
  useConnection.getState().reset()
})
afterEach(() => jest.clearAllMocks())

const NOT_FOUND = new ApiError({
  kind: 'Unsupported',
  status: 404,
  endpoint: 'symbol',
  serverMessage: 'Symbol GONE not found in exchange NFO',
})

const setup = (seed: Record<string, string> = {}) => {
  const store = createTickStore((fn) => fn(), { evictAfterMs: 0 })
  const kv = memoryKV(seed)
  const call = jest.fn(async (id: string, body: Record<string, string>) => {
    if (id === 'symbol') {
      if (body.symbol === 'GONE') throw NOT_FOUND
      return { symbol: body.symbol, exchange: body.exchange, name: `${body.symbol} FULL NAME` }
    }
    throw new Error(`unexpected ${id}`)
  })
  const acquire = jest.fn((_r: unknown) => () => {})
  const live = {
    realtime: { acquire, confirmedDepth: () => undefined },
    polling: { register: () => () => {} },
    store,
  } as unknown as LiveServices
  const services = {
    api: { call },
    store,
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1' }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  // no gc timer: it would hold the test process open
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  const show = (exchange: string, symbol: string) =>
    render(
      <ServicesProvider value={services}>
        <TradingProvider now={Date.now}>
          <QueryClientProvider client={client}>
            <TickStoreContext.Provider value={store}>
              <LiveContext.Provider value={live}>
                <InstrumentSheet exchange={exchange} symbol={symbol} />
                <ToastHost />
              </LiveContext.Provider>
            </TickStoreContext.Provider>
          </QueryClientProvider>
        </TradingProvider>
      </ServicesProvider>,
    )
  const saved = () => WatchlistsSchema.parse(JSON.parse(kv.data.get('oa.p1.watchlists') ?? 'null'))
  return { store, call, acquire, show, saved }
}

const settle = () =>
  act(async () => {
    // react-query tells its observers from a 0 ms timer
    await new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })

const open = async (exchange: string, symbol: string, seed?: Record<string, string>) => {
  const h = setup(seed)
  await h.show(exchange, symbol)
  await settle()
  return h
}

describe('InstrumentSheet', () => {
  test('an index has Chart and Depth but no BUY or SELL', async () => {
    await open('NSE_INDEX', 'NIFTY')
    expect(screen.getByTestId('inst-chart')).toBeTruthy()
    expect(screen.getByTestId('inst-depth')).toBeTruthy()
    expect(screen.queryByTestId('inst-buy')).toBeNull()
    expect(screen.queryByTestId('inst-sell')).toBeNull()
  })

  test('shows the symbol, name, exchange, price and change', async () => {
    const h = await open('NSE', 'RELIANCE')
    await act(async () => h.store.put('NSE:RELIANCE', { ltp: 1500, close: 1490 }, 'ws'))
    expect(screen.getByText('RELIANCE')).toBeTruthy()
    expect(screen.getByText('RELIANCE FULL NAME')).toBeTruthy()
    expect(screen.getByText('NSE')).toBeTruthy()
    expect(screen.getByTestId('inst-ltp').props.children).toBe('1,500.00')
    expect(screen.getByTestId('inst-change').props.children.join('')).toContain('+10.00')
  })

  test('BUY and SELL open the ticket on that side; Chart and Depth open their routes', async () => {
    await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('inst-buy'))
    expect(mockReplace).toHaveBeenLastCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'BUY' }),
    )
    await fireEvent.press(screen.getByTestId('inst-sell'))
    expect(mockReplace).toHaveBeenLastCalledWith(
      ticketHref({ exchange: 'NSE', symbol: 'RELIANCE', action: 'SELL' }),
    )
    await fireEvent.press(screen.getByTestId('inst-chart'))
    expect(mockReplace).toHaveBeenLastCalledWith(chartHref('NSE', 'RELIANCE'))
    await fireEvent.press(screen.getByTestId('inst-depth'))
    expect(mockReplace).toHaveBeenLastCalledWith(depthHref('NSE', 'RELIANCE'))
  })

  test('BUY and SELL are disabled while the broker is logged out', async () => {
    await open('NSE', 'RELIANCE')
    await act(() => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await fireEvent.press(screen.getByTestId('inst-buy'))
    expect(mockReplace).not.toHaveBeenCalled()
  })

  test('the option chain button opens the tool with the key, except on CDS and the like', async () => {
    await open('NFO', 'NIFTY25NOV25FUT')
    await fireEvent.press(screen.getByTestId('inst-optionchain'))
    expect(mockReplace).toHaveBeenLastCalledWith('/tools/optionchain?u=NFO%3ANIFTY25NOV25FUT')
  })

  test.each(['CDS', 'BCD', 'CRYPTO', 'GLOBAL_INDEX', 'MCX_INDEX', 'NCDEX'])(
    'no option chain on %s',
    async (ex) => {
      await open(ex, 'X')
      expect(screen.queryByTestId('inst-optionchain')).toBeNull()
    },
  )

  test('an expired contract shows only that: no actions, and no feed slot', async () => {
    const h = await open('NFO', 'GONE')
    expect(screen.getByTestId('inst-unknown')).toBeTruthy()
    expect(screen.queryByTestId('inst-buy')).toBeNull()
    expect(screen.queryByTestId('inst-chart')).toBeNull()
    expect(h.acquire).not.toHaveBeenCalled()
  })

  test('inst-watch adds to the active list, then removes', async () => {
    const h = await open('NSE', 'WIPRO')
    expect(screen.getByTestId('inst-watch')).toHaveTextContent(/Add to Watchlist/)
    await fireEvent.press(screen.getByTestId('inst-watch'))
    await settle()
    expect(h.saved().lists[0]?.items).toContainEqual({ exchange: 'NSE', symbol: 'WIPRO' })
    expect(screen.getByTestId('inst-watch')).toHaveTextContent(/Remove from Watchlist/)
    await fireEvent.press(screen.getByTestId('inst-watch'))
    await settle()
    expect(h.saved().lists[0]?.items).not.toContainEqual({ exchange: 'NSE', symbol: 'WIPRO' })
  })
})

describe('placeholder routes', () => {
  test('the chart route says charts are not in this build', async () => {
    await render(<ChartRoute />)
    expect(screen.getByText("Charts aren't in this build yet.")).toBeTruthy()
    expect(screen.getByText('They arrive in the next update.')).toBeTruthy()
  })

  test('the tools route names option chains, or tools', async () => {
    mockToolId = 'optionchain'
    const a = await render(<ToolRoute />)
    expect(screen.getByText("Option chains aren't in this build yet.")).toBeTruthy()
    await a.unmount()
    mockToolId = 'greeks'
    await render(<ToolRoute />)
    expect(screen.getByText("Tools aren't in this build yet.")).toBeTruthy()
  })
})
