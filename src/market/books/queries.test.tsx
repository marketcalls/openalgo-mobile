import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react-native'
import { cloneElement } from 'react'
import { Text } from 'react-native'
import type { z } from 'zod'
import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { createBookInvalidator } from '~/core/query/invalidate'
import { qk } from '~/core/query/keys'
import { createQueryClient } from '~/core/query/queryClient'
import { isExchangeOpen } from '~/core/realtime/marketHours'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { createPollingEngine } from '~/core/realtime/polling'
import { createTickStore } from '~/core/realtime/tickStore'
import type { FeedState } from '~/core/realtime/types'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { type ConnectionState, useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import holdings from '../../../test/fixtures/openalgo-docs/holdings.json'
import idleBook from '../../../test/fixtures/openalgo-docs/orderbook.json'
import positions from '../../../test/fixtures/openalgo-docs/positionbook.json'
import trades from '../../../test/fixtures/openalgo-docs/tradebook.json'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { type Trading, TradingProvider, useTrading } from '../trading'
import {
  type BookName,
  useBookPolling,
  useFunds,
  useHoldings,
  useIsEvented,
  useOrderbook,
  usePositionbook,
  useTradebook,
} from './queries'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const screenActive = useScreenActive as jest.Mock

// A Tuesday, 09:30 IST: NSE is open.
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const PID = 'p1'

/** One NSE order still open, so the book counts as working. */
const workingBook = {
  status: 'success',
  data: {
    orders: [
      {
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
      },
    ],
    statistics: { total_open_orders: 1 },
  },
}

type SetupOptions = {
  broker?: string | null
  feed?: FeedState
  orderStream?: boolean | null
  book?: 'working' | 'idle'
}

const REPLIES: Record<string, unknown> = {
  tradebook: trades,
  positionbook: positions,
  holdings,
  funds,
}

function setup(o: SetupOptions = {}) {
  const counts: Record<string, number> = {}
  const call = jest.fn(async (id: string, _body: unknown, schema: z.ZodType) => {
    counts[id] = (counts[id] ?? 0) + 1
    if (id === 'orderbook') return schema.parse(o.book === 'idle' ? idleBook : workingBook)
    if (id in REPLIES) return schema.parse(REPLIES[id])
    throw new Error(`unexpected ${id}`)
  })
  const api = { call } as unknown as Api
  const polling = createPollingEngine({
    api,
    store: createTickStore((fn) => fn()),
    isLive: () => false,
    network: () => 'home',
    now: Date.now,
    isExchangeOpen,
  })
  const status = { state: o.feed ?? 'live', broker: o.broker === undefined ? 'zerodha' : o.broker }
  const realtime = { status: () => status, onStatus: () => () => {} }
  const caps = {
    ws: () => ({ orderStream: o.orderStream === undefined ? true : o.orderStream }),
    subscribe: () => () => {},
  }
  // the app's defaults (a 5-minute gc among them); the fake clock holds the timers
  const queryClient = createQueryClient()
  const s = {
    api,
    polling,
    realtime,
    caps,
    queryClient,
    storage: profileStorage(memoryKV(), PID),
    profile: { get: () => ({ id: PID, broker: null }) },
    orderEvents: createOrderEventBus(),
    books: createBookInvalidator(queryClient, PID),
  } as unknown as Services
  const count = (id: string) => counts[id] ?? 0
  const tree = (ui: React.ReactElement) => (
    <ServicesProvider value={s}>
      <TradingProvider now={Date.now}>
        <QueryClientProvider client={queryClient}>
          <Grab />
          {ui}
        </QueryClientProvider>
      </TradingProvider>
    </ServicesProvider>
  )
  const mount = async (ui: React.ReactElement) => {
    await render(tree(ui))
    await pass(0)
    // a new element, or React would skip the unchanged subtree and not read the focus again
    return { rerender: () => screen.rerender(tree(cloneElement(ui))) }
  }
  const watch = () => {
    if (!grabbed) throw new Error('not mounted')
    return grabbed.eventWatch
  }
  return { s, call, count, polling, queryClient, mount, watch }
}

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

let grabbed: Trading | undefined
const Grab = () => {
  grabbed = useTrading()
  return null
}

const ORDERS_BOOKS: readonly BookName[] = ['orderbook', 'tradebook']

/** The Orders tab's use of the books: its two books, and their refresh. */
const OrdersProbe = () => {
  const orders = useOrderbook()
  useTradebook()
  useBookPolling(true, ORDERS_BOOKS)
  return <Text testID="orders">{orders.data ? String(orders.data.orders.length) : '-'}</Text>
}

const AllBooks = () => {
  useOrderbook()
  useTradebook()
  usePositionbook()
  useHoldings()
  return null
}

const Funds = ({ enabled = true }: { enabled?: boolean }) => {
  const f = useFunds({ enabled })
  return <Text testID="cash">{f.data?.availablecash ?? '-'}</Text>
}

let readEvented: (() => boolean) | undefined
const EventedProbe = () => {
  readEvented = useIsEvented()
  return null
}

const setConn = (patch: Partial<ConnectionState>) =>
  act(async () => {
    useConnection.getState().set(patch)
  })

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  screenActive.mockReturnValue(true)
  useConnection.getState().reset()
  useConnection.getState().set({ brokerSession: 'active', keyState: 'ok', analyzer: 'live' })
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  grabbed = undefined
  readEvented = undefined
})

describe('book queries', () => {
  test('each book is read once when its screen is focused', async () => {
    const h = setup()
    await h.mount(<AllBooks />)
    for (const id of ['orderbook', 'tradebook', 'positionbook', 'holdings']) {
      expect(h.count(id)).toBe(1)
    }
    expect(screen.queryByTestId('orders')).toBeNull()
  })

  test.each<[string, Partial<ConnectionState>]>([
    ['a logged-out broker', { brokerSession: 'logged_out' }],
    ['a refused key', { keyState: 'invalid' }],
    ['a ban', { banned: 'text' }],
  ])('blocked by %s: no read on focus, and polling makes 0 calls in 60 s', async (_, patch) => {
    useConnection.getState().set(patch)
    const h = setup({ broker: 'ibulls', book: 'working' })
    await h.mount(<OrdersProbe />)
    expect(h.count('orderbook')).toBe(0)
    expect(h.count('tradebook')).toBe(0)
    await pass(60_000)
    expect(h.call).not.toHaveBeenCalled()
    expect(h.polling.stats().calls.custom).toBe(0)
    expect(h.polling.stats().consumers).toBe(0)
    expect(screen.getByTestId('orders')).toHaveTextContent('-')
  })

  test('a login after the block reads the books at once and starts polling', async () => {
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const h = setup({ broker: 'ibulls', book: 'working' })
    await h.mount(<OrdersProbe />)
    await setConn({ brokerSession: 'active' })
    await pass(0)
    expect(h.count('orderbook')).toBe(1)
    expect(screen.getByTestId('orders')).toHaveTextContent('1')
    await pass(5000)
    expect(h.count('orderbook')).toBe(2)
  })

  test('a screen hidden for 10 minutes keeps its book; blocked on return, it shows it unread', async () => {
    const h = setup({ broker: 'ibulls', book: 'working' })
    const view = await h.mount(<OrdersProbe />)
    expect(screen.getByTestId('orders')).toHaveTextContent('1')
    screenActive.mockReturnValue(false)
    await view.rerender()
    await pass(600_000)
    await setConn({ brokerSession: 'logged_out' })
    screenActive.mockReturnValue(true)
    await view.rerender()
    await pass(0)
    expect(screen.getByTestId('orders')).toHaveTextContent('1')
    expect(h.count('orderbook')).toBe(1)
  })

  test('a hidden screen reads nothing, polls nothing and ignores invalidation; focus refetches', async () => {
    screenActive.mockReturnValue(false)
    const h = setup({ broker: 'ibulls', book: 'working' })
    const view = await h.mount(<OrdersProbe />)
    expect(h.count('orderbook')).toBe(0)
    h.s.books.poke()
    await pass(60_000)
    expect(h.call).not.toHaveBeenCalled()
    screenActive.mockReturnValue(true)
    await view.rerender()
    await pass(0)
    expect(h.count('orderbook')).toBe(1)
  })
})

describe('useFunds', () => {
  test('reads funds while enabled and focused', async () => {
    const h = setup()
    await h.mount(<Funds />)
    expect(h.count('funds')).toBe(1)
    expect(screen.getByTestId('cash')).toHaveTextContent('320.66')
  })

  test('is off while blocked, while not enabled, and while its screen is hidden', async () => {
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const blocked = setup()
    await blocked.mount(<Funds />)
    expect(blocked.count('funds')).toBe(0)
    await screen.unmount()

    useConnection.getState().set({ brokerSession: 'active' })
    const off = setup()
    await off.mount(<Funds enabled={false} />)
    expect(off.count('funds')).toBe(0)
    await screen.unmount()

    screenActive.mockReturnValue(false)
    const hidden = setup()
    await hidden.mount(<Funds />)
    hidden.s.books.poke()
    await pass(1000)
    expect(hidden.count('funds')).toBe(0)
  })
})

describe('useBookPolling', () => {
  test('zerodha with the stream live polls every 30 s, even with an order working', async () => {
    const h = setup({ broker: 'zerodha', book: 'working' })
    await h.mount(<OrdersProbe />)
    expect(h.count('orderbook')).toBe(1)
    await pass(29_999)
    expect(h.count('orderbook')).toBe(1)
    await pass(1)
    expect(h.count('orderbook')).toBe(2)
    await pass(30_000)
    expect(h.count('orderbook')).toBe(3)
  })

  test('ibulls (no order events) polls a working book every 5 s and an idle one every 30 s', async () => {
    const working = setup({ broker: 'ibulls', book: 'working' })
    await working.mount(<OrdersProbe />)
    await pass(15_000)
    expect(working.count('orderbook')).toBe(4)
    await screen.unmount()

    const idle = setup({ broker: 'ibulls', book: 'idle' })
    await idle.mount(<OrdersProbe />)
    await pass(15_000)
    expect(idle.count('orderbook')).toBe(1)
    await pass(15_000)
    expect(idle.count('orderbook')).toBe(2)
  })

  test('without a live order stream (polling mode, or orderStream false), working → every 5 s', async () => {
    const polling = setup({ broker: 'zerodha', feed: 'polling', book: 'working' })
    await polling.mount(<OrdersProbe />)
    await pass(10_000)
    expect(polling.count('orderbook')).toBe(3)
    await screen.unmount()

    const old = setup({ broker: 'zerodha', orderStream: false, book: 'working' })
    await old.mount(<OrdersProbe />)
    await pass(10_000)
    expect(old.count('orderbook')).toBe(3)
  })

  test('RF 3: zerodha, stream live, expect("A1") and no event for 10 s → a working book polls at 5 s', async () => {
    const h = setup({ broker: 'zerodha', book: 'working' })
    await h.mount(<OrdersProbe />)
    await act(async () => h.watch().expect('A1'))
    await pass(10_000)
    expect(h.watch().demoted()).toBe(true)
    // the 30 s wait armed before the demotion runs out; from then on every 5 s
    await pass(20_000)
    expect(h.count('orderbook')).toBe(2)
    await pass(20_000)
    expect(h.count('orderbook')).toBe(6)
  })

  test('RF 3: the order event at 3 s, through the bus → not demoted, still every 30 s', async () => {
    const h = setup({ broker: 'zerodha', book: 'working' })
    await h.mount(<OrdersProbe />)
    await act(async () => h.watch().expect('A1'))
    await pass(3000)
    await act(async () =>
      h.s.orderEvents.emit({ t: 'order_update', orderid: 'A1', order_status: 'open' }),
    )
    await pass(57_000)
    expect(h.watch().demoted()).toBe(false)
    expect(h.count('orderbook')).toBe(3)
  })

  test('the market closed → ×5: an idle zerodha book at 16:30 IST waits 150 s', async () => {
    jest.setSystemTime(Date.UTC(2026, 10, 24, 11, 0))
    const h = setup({ broker: 'zerodha', book: 'idle' })
    await h.mount(<OrdersProbe />)
    await pass(149_999)
    expect(h.count('orderbook')).toBe(1)
    await pass(1)
    expect(h.count('orderbook')).toBe(2)
  })

  test("a poll refreshes only the screen's own books, not the other tabs' or funds", async () => {
    const h = setup({ broker: 'ibulls', book: 'working' })
    await h.mount(<OrdersProbe />)
    const invalidate = jest.spyOn(h.queryClient, 'invalidateQueries')
    await pass(5000)
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey)
    expect(keys).toEqual([qk.orderbook(PID), qk.tradebook(PID)])
  })

  test('the consumer goes when the screen loses focus', async () => {
    const h = setup({ broker: 'ibulls', book: 'working' })
    const view = await h.mount(<OrdersProbe />)
    expect(h.polling.stats().consumers).toBe(1)
    screenActive.mockReturnValue(false)
    await view.rerender()
    expect(h.polling.stats().consumers).toBe(0)
    await pass(30_000)
    expect(h.count('orderbook')).toBe(1)
  })
})

describe('useIsEvented', () => {
  test('reads the policy as things stand when called', async () => {
    const h = setup({ broker: 'zerodha' })
    await h.mount(<EventedProbe />)
    expect(readEvented?.()).toBe(true)
    await act(async () => h.watch().expect('A1'))
    await pass(10_000)
    expect(readEvented?.()).toBe(false)
  })

  test('ibulls has no events, except in analyzer mode', async () => {
    const h = setup({ broker: 'ibulls' })
    await h.mount(<EventedProbe />)
    expect(readEvented?.()).toBe(false)
    await setConn({ analyzer: 'analyze' })
    expect(readEvented?.()).toBe(true)
  })

  test('no live order stream: not evented', async () => {
    const h = setup({ broker: 'zerodha', orderStream: null })
    await h.mount(<EventedProbe />)
    expect(readEvented?.()).toBe(false)
  })
})
