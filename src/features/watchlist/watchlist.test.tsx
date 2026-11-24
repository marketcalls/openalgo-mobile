import { act, render, screen } from '@testing-library/react-native'
import { AccessibilityInfo } from 'react-native'
import { profileStorage } from '~/core/config/storage'
import { createPollingEngine } from '~/core/realtime/polling'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { type Services, ServicesProvider } from '~/core/services/services'
import { useSeedQuotes } from './api'
import { WatchRow } from './components/WatchRow'
import { DEFAULT_WATCHLISTS, WatchlistsSchema } from './model'
import { WatchlistScreen } from './screens/WatchlistScreen'
import { loadWatchlists, saveWatchlists } from './store'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock

beforeEach(() => {
  jest.useFakeTimers()
  screenActive.mockReturnValue(true)
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

const memoryKV = () => {
  const m = new Map<string, string>()
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
    keys: async (p: string) => [...m.keys()].filter((k) => k.startsWith(p)),
  }
}

const results = (ltp: number, prev: number) => [
  { symbol: 'RELIANCE', exchange: 'NSE', data: { ltp, prev_close: prev } },
]

const setup = (o: { live?: boolean } = {}) => {
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
  const call = jest.fn(async (_id: string, _body: unknown, _schema: unknown) => results(1500, 1490))
  const api = { call } as unknown as Services['api']
  const polling = createPollingEngine({
    api,
    store,
    isLive: () => o.live ?? true,
    network: () => 'home',
    now: Date.now,
    isAnyMarketOpen: () => true,
  })
  const realtime = { acquire: () => () => {}, confirmedDepth: () => undefined }
  const live = { realtime, polling, store } as unknown as LiveServices
  const services = { api, store } as unknown as Services
  const wrap = (ui: React.ReactElement) => (
    <ServicesProvider value={services}>
      <TickStoreContext.Provider value={store}>
        <LiveContext.Provider value={live}>{ui}</LiveContext.Provider>
      </TickStoreContext.Provider>
    </ServicesProvider>
  )
  return { store, flush, call, wrap, polling }
}

const ITEMS = [{ exchange: 'NSE', symbol: 'RELIANCE' }]
const Probe = () => {
  useSeedQuotes(ITEMS)
  return <WatchRow exchange="NSE" symbol="RELIANCE" reduceMotion />
}

const tick = async (h: ReturnType<typeof setup>, ltp: number) => {
  h.store.put('NSE:RELIANCE', { ltp, close: 1490 }, 'ws')
  await h.flush()
}

describe('watchlist storage', () => {
  test('the first load seeds the defaults under oa.<pid>.watchlists', async () => {
    const kv = memoryKV()
    const s = profileStorage(kv, 'p1')
    const w = await loadWatchlists(s)
    expect(w).toEqual(DEFAULT_WATCHLISTS)
    expect(WatchlistsSchema.parse(JSON.parse(kv.m.get('oa.p1.watchlists') ?? 'null'))).toEqual(
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
      version: 1 as const,
      lists: [{ id: 'default', name: 'Mine', items: [{ exchange: 'NSE', symbol: 'ITC' }] }],
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
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
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
})

describe('WatchlistScreen', () => {
  test('lists the default symbols and, with a live feed, makes no REST call after the seed', async () => {
    const h = setup({ live: true })
    const kv = memoryKV()
    const services = { api: { call: h.call }, store: h.store, storage: profileStorage(kv, 'p1') }
    const ui = (
      <ServicesProvider value={services as unknown as Services}>
        <TickStoreContext.Provider value={h.store}>
          <LiveContext.Provider
            value={{
              realtime: { acquire: () => () => {}, confirmedDepth: () => undefined },
              polling: h.polling,
              store: h.store,
            }}
          >
            <WatchlistScreen />
          </LiveContext.Provider>
        </TickStoreContext.Provider>
      </ServicesProvider>
    )
    await render(ui)
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    expect(screen.getByTestId('watch-row-NSE-RELIANCE')).toBeTruthy()
    expect(screen.getByTestId('watch-row-NSE_INDEX-NIFTY')).toBeTruthy()
    expect(kv.m.has('oa.p1.watchlists')).toBe(true)
    expect(h.call).toHaveBeenCalledTimes(1) // the seed
    expect(h.call.mock.calls[0]?.[1]).toEqual({
      symbols: DEFAULT_WATCHLISTS.lists[0]?.items.map((i) => ({
        symbol: i.symbol,
        exchange: i.exchange,
      })),
    })
    await act(async () => {
      jest.advanceTimersByTime(10_000)
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    expect(h.call).toHaveBeenCalledTimes(1)
  })
})
