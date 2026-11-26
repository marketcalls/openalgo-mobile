import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { createOrderEventBus } from '~/core/realtime/orderEvents'
import { createPollingEngine, POLL_RATES, type PollConsumer } from '~/core/realtime/polling'
import type { DepthBook, QuotePatch } from '~/core/realtime/protocol'
import { createSubscriptionManager, type SubRequest } from '~/core/realtime/subscriptions'
import { createTickStore } from '~/core/realtime/tickStore'
import { LiveContext, type LiveServices } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import * as depthSupport from '~/market/instruments/depthSupport'
import { chartHref, ticketHref } from '~/market/links'
import { TradingProvider } from '~/market/trading'
import { memoryKV } from '../../../test/helpers/memoryKV'
import DepthRoute from '../../app/(app)/depth/[key]'
import { DepthPanel } from './components/DepthPanel'
import { CONFIRM_SETTLE_MS, NO_BOOK_MS } from './model'
import { DepthScreen } from './screens/DepthScreen'

jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: jest.fn() }))
const mockPush = jest.fn()
let mockKey = 'NSE%3ARELIANCE'
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ key: mockKey }),
}))

const FIVE_ONLY = 'This broker sends 5 levels here.'
const NEEDS_LIVE = 'Deeper levels need the live feed'

beforeEach(() => {
  jest.useFakeTimers()
  ;(useScreenActive as jest.Mock).mockReturnValue(true)
  useConnection.getState().reset()
  useConnection.getState().set({ feed: 'live' })
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  jest.useRealTimers()
})

const NOT_FOUND = new ApiError({
  kind: 'Unsupported',
  status: 404,
  endpoint: 'symbol',
  serverMessage: 'Symbol GONE not found in exchange NFO',
})
const UNREACHABLE = new ApiError({ kind: 'Network', status: 0, endpoint: 'depth' })
const SERVER_DOWN = "Can't reach the server. Check your connection and try again."

/** A `/depth` reply's data (S2): `n` priced levels a side. */
const depthReply = (n: number) => ({
  ltp: 1424,
  prev_close: 1410,
  totalbuyqty: 5000,
  totalsellqty: 6000,
  bids: Array.from({ length: n }, (_, i) => ({ price: 1423.9 - i, quantity: 100 + i })),
  asks: Array.from({ length: n }, (_, i) => ({ price: 1424 + i, quantity: 100 + i })),
})

/** `n` priced levels a side, the best bid and ask first. */
const book = (n: number, bid = 1423.9, ask = 1424): DepthBook => ({
  buy: Array.from({ length: n }, (_, i) => ({ price: bid - i, quantity: 100 + i, orders: 1 })),
  sell: Array.from({ length: n }, (_, i) => ({ price: ask + i, quantity: 100 + i, orders: 2 })),
  levels: n,
})

const pass = (ms: number) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })

type SetupOptions = {
  /** Answers `/depth` (by default it is not called). */
  depth?: (body: Record<string, string>) => Promise<unknown>
  /** 'real': the polling engine runs and polls `/depth`; by default its consumers are only counted. */
  polling?: 'real'
  /** The device's safe-area insets (none by default). */
  insets?: Partial<EdgeInsets>
}

const setup = (broker: string | null = 'dhan', o: SetupOptions = {}) => {
  const store = createTickStore((fn) => fn())
  const kv = memoryKV()
  const call = jest.fn(async (id: string, body: Record<string, string>): Promise<unknown> => {
    if (id === 'symbol') {
      if (body.symbol === 'GONE') throw NOT_FOUND
      return { symbol: body.symbol, exchange: body.exchange, name: `${body.symbol} FULL NAME` }
    }
    if (id === 'depth' && o.depth) return o.depth(body)
    throw new Error(`unexpected ${id}`)
  })
  // The real subscription manager on a live socket: it decides what is on the wire, and its
  // confirmedDepth is min(ack, the most levels any ws depth tick on the wire entry carried).
  const subs = createSubscriptionManager({ send: () => {} })
  subs.resendAll()
  /** The holds not yet released: what the wire entry's consumers are asking for. */
  const held = new Set<SubRequest>()
  const acquire = jest.fn((r: SubRequest) => {
    const release = subs.acquire(r)
    held.add(r)
    return () => {
      held.delete(r)
      release()
    }
  })
  const realtime = {
    acquire,
    isLive: jest.fn((ex: string, sym: string) => subs.isWired(ex, sym)),
    confirmedDepth: jest.fn((ex: string, sym: string) => subs.confirmedDepth(ex, sym)),
    status: () => ({ broker: null }),
    onStatus: () => () => {},
  }
  // As services.tsx wires it: depth is polled until the socket delivers a book.
  const engine =
    o.polling === 'real'
      ? createPollingEngine({
          api: { call } as unknown as Pick<Api, 'call'>,
          store,
          isLive: (ex, sym) => subs.isWired(ex, sym),
          isDepthLive: (ex, sym) =>
            subs.isWired(ex, sym) && subs.confirmedDepth(ex, sym) !== undefined,
          network: () => 'home',
          now: Date.now,
          isExchangeOpen: () => true,
        })
      : undefined
  const register = jest.fn((c: PollConsumer, active: boolean) =>
    engine ? engine.register(c, active) : () => {},
  )
  const polling = {
    register,
    health: () => engine?.health() ?? 'none',
    onHealth: (fn: () => void) => engine?.onHealth(fn) ?? (() => {}),
  }
  const live = { realtime, polling, store } as unknown as LiveServices
  const check = jest.fn(async () => 'active')
  const services = {
    api: { call },
    store,
    realtime,
    polling,
    broker: { check },
    storage: profileStorage(kv, 'p1'),
    profile: { get: () => ({ id: 'p1', broker, restOrigin: 'https://algo.example.com' }) },
    orderEvents: createOrderEventBus(),
  } as unknown as Services
  // no gc timer: it would hold the test process open
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  })
  const insets: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0, ...o.insets }
  const tree = (node: React.ReactElement) => (
    <SafeAreaInsetsContext.Provider value={insets}>
      <ServicesProvider value={services}>
        <TradingProvider now={Date.now}>
          <QueryClientProvider client={client}>
            <TickStoreContext.Provider value={store}>
              <LiveContext.Provider value={live}>{node}</LiveContext.Provider>
            </TickStoreContext.Provider>
          </QueryClientProvider>
        </TradingProvider>
      </ServicesProvider>
    </SafeAreaInsetsContext.Provider>
  )
  return { store, call, acquire, held, register, subs, tree }
}

type Harness = ReturnType<typeof setup>

/** One screen per key, as the stack gives each pushed depth route its own. */
const screenOf = (exchange: string, symbol: string) => (
  <DepthScreen key={`${exchange}:${symbol}`} exchange={exchange} symbol={symbol} />
)

/**
 * Renders the screen inside one services container: a harness is one signed-in session, and
 * its providers stay mounted while `goTo` shows other symbols, as the app shell's do.
 */
const open = async (exchange: string, symbol: string, h: Harness = setup()) => {
  const r = await render(h.tree(screenOf(exchange, symbol)))
  // the /symbol lookup, then react-query's notify timer
  await pass(10)
  const key = `${exchange}:${symbol}`
  return {
    ...h,
    ...r,
    rerender: () => r.rerender(h.tree(screenOf(exchange, symbol))),
    /** Another symbol's depth screen in place of this one, in the same session. */
    goTo: async (ex: string, sym: string) => {
      await r.rerender(h.tree(screenOf(ex, sym)))
      await pass(10)
    },
    tick: (patch: QuotePatch, source: 'ws' | 'poll' = 'ws') =>
      act(async () => {
        // a later tick carries a later time
        jest.advanceTimersByTime(5)
        // as wsClient's onTick: a socket depth tick feeds the wire entry's level count first
        if (source === 'ws' && patch.depth) {
          h.subs.noteDepthLevels(exchange, symbol, patch.depth.levels)
        }
        h.store.put(key, patch, source)
      }),
    /** The server's subscribe ack for the key's wire entry (C8: an error entry is a refusal). */
    ack: (o: { ok?: boolean; depth?: number }) =>
      h.subs.onAck({
        t: 'sub_ack',
        entries: [
          {
            exchange,
            symbol,
            ok: o.ok ?? true,
            ...(o.depth !== undefined ? { depth: o.depth } : {}),
          },
        ],
      }),
  }
}

/** A changed subscription reaches the wire after the socket's 100 ms debounce. */
const ON_WIRE_MS = 150

const bids = () => screen.queryAllByTestId(/^depth-bid-\d+$/)
const asks = () => screen.queryAllByTestId(/^depth-ask-\d+$/)
const RELIANCE = { exchange: 'NSE', symbol: 'RELIANCE' }

describe('levels switch', () => {
  test('dhan on NSE, live: 5 or 20; choosing 20 acquires depth 20 and shows 20 levels', async () => {
    const h = await open('NSE', 'RELIANCE')
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
    await h.tick({ depth: book(20) })
    expect(bids()).toHaveLength(5)
    expect(screen.getByTestId('depth-levels-5')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 20 })
    await h.tick({ depth: book(20) })
    expect(bids()).toHaveLength(20)
    expect(asks()).toHaveLength(20)
    expect(screen.getByTestId('depth-bid-19')).toBeTruthy()

    // the feed confirms 20
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(20) })
    await h.tick({ depth: book(20) })
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(bids()).toHaveLength(20)
  })

  test('a broker with 5 levels only: no switch and no note', async () => {
    await open('NSE', 'RELIANCE', setup('zerodha'))
    expect(screen.queryByTestId('depth-levels-5')).toBeNull()
    expect(screen.queryByText(NEEDS_LIVE)).toBeNull()
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
  })

  test('dhan on BSE: no switch', async () => {
    await open('BSE', 'RELIANCE')
    expect(screen.queryByTestId('depth-levels-20')).toBeNull()
  })

  test('polling hides the switch and says deeper levels need the live feed', async () => {
    useConnection.getState().set({ feed: 'polling' })
    const h = await open('NSE', 'RELIANCE')
    expect(screen.queryByTestId('depth-levels-20')).toBeNull()
    expect(screen.getByText(NEEDS_LIVE)).toBeTruthy()
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
    expect(h.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'depth' }), true)
  })

  test('the feed dropping after 20 was chosen goes back to 5, and 20 returns with it', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await act(async () => useConnection.getState().set({ feed: 'reconnecting' }))
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
    expect(screen.getByText(NEEDS_LIVE)).toBeTruthy()
    await act(async () => useConnection.getState().set({ feed: 'live' }))
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 20 })
    expect(screen.queryByText(NEEDS_LIVE)).toBeNull()
  })
})

describe('confirming deeper levels (ruling 10)', () => {
  test('an error ack for 20: "This broker sends 5 levels here.", depth 5 again, 5 rows', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    // the server refused the subscribe: the key is not wired, and polling takes it
    h.ack({ ok: false, depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()
    expect(screen.queryByTestId('depth-levels-20')).toBeNull()
    expect(screen.queryByTestId('depth-levels-5')).toBeNull()
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
    await h.tick({ depth: book(5) }, 'poll')
    expect(bids()).toHaveLength(5)
    expect(asks()).toHaveLength(5)
  })

  test('the downgrade holds for that broker and exchange for the session, not others', async () => {
    const a = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    a.ack({ ok: false, depth: 20 })
    await pass(CONFIRM_SETTLE_MS)

    await a.goTo('NSE', 'SBIN')
    expect(screen.queryByTestId('depth-levels-20')).toBeNull()
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()

    await a.goTo('NFO', 'NIFTY25NOV25FUT')
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('a downgrade ends with its session: after sign-out or a server change, 20 is offered again', async () => {
    const a = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    a.ack({ ok: false, depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()
    await a.unmount()

    // Signing out, or changing the server, unmounts the app group and its services container;
    // signing in again builds a new one (test/app/appLayout.test.tsx shows the shell doing so).
    await open('NSE', 'RELIANCE', setup('dhan'))
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('an ack depth of 5 downgrades once a tick after the window is past 5, not before', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    h.ack({ depth: 5 })
    // the 5-level subscription's last ticks can still arrive
    await h.tick({ depth: book(5) })
    await h.tick({ depth: book(5) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    await pass(CONFIRM_SETTLE_MS)
    // the levels seen so far may be the old subscription's: confirmedDepth is not judged yet
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    // past 5 levels, min(ack, levels) of 5 can only be the ack's
    await h.tick({ depth: book(20) })
    expect(h.subs.confirmedDepth('NSE', 'RELIANCE')).toBe(5)
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()
    expect(h.acquire).toHaveBeenLastCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
  })

  test('a 5-level tick on the new subscription, then a first 20-level one after the window, keeps 20', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    // the 5-level subscription's last tick lands on the new wire entry
    await h.tick({ depth: book(5) })
    expect(h.subs.confirmedDepth('NSE', 'RELIANCE')).toBe(5)
    // a quiet contract, or a slow first 20-level tick: nothing more until the window has opened
    await pass(CONFIRM_SETTLE_MS)
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    await h.tick({ depth: book(20) })
    expect(h.subs.confirmedDepth('NSE', 'RELIANCE')).toBe(20)
    await h.tick({ depth: book(20) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
    expect(bids()).toHaveLength(20)
  })

  test('the tick on screen when the window opens is not one of the first two', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    await h.tick({ depth: book(5) })
    await pass(CONFIRM_SETTLE_MS)
    // one 5-level tick since the window: not two yet
    await h.tick({ depth: book(5) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    await h.tick({ depth: book(20) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('a thin 20-level book (12 priced levels) does not downgrade', async () => {
    const h = await open('NFO', 'NIFTY25NOV2530000CE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(12) })
    await h.tick({ depth: book(12) })
    expect(h.subs.confirmedDepth('NFO', 'NIFTY25NOV2530000CE')).toBe(12)
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
    expect(bids()).toHaveLength(12)
  })

  test('two 5-level ticks after the subscribe downgrade', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(5) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    await h.tick({ depth: book(5) })
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()
  })

  test('20-level ticks, a 0-level tick and a 5-level poll do not downgrade', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(CONFIRM_SETTLE_MS)
    // off hours the broker pads the book: no priced level yet
    await h.tick({ depth: book(0) })
    expect(h.subs.confirmedDepth('NSE', 'RELIANCE')).toBe(0)
    await h.tick({ depth: book(5) }, 'poll')
    await h.tick({ depth: book(5) }, 'poll')
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    await h.tick({ depth: book(20) })
    await h.tick({ depth: book(20) })
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('leaving the screen during the check does not count as a refusal', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    // another screen covers this one: the subscription is released, and leaves the wire
    ;(useScreenActive as jest.Mock).mockReturnValue(false)
    await h.rerender()
    await pass(CONFIRM_SETTLE_MS)
    expect(h.subs.isWired('NSE', 'RELIANCE')).toBe(false)
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    // back: the subscribe goes out again after the debounce, and the check starts afresh
    ;(useScreenActive as jest.Mock).mockReturnValue(true)
    await h.rerender()
    await pass(CONFIRM_SETTLE_MS * 2)
    expect(h.subs.isWired('NSE', 'RELIANCE')).toBe(true)
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('leaving once the check is open: coming back does not judge the unwired gap', async () => {
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(20) })
    ;(useScreenActive as jest.Mock).mockReturnValue(false)
    await h.rerender()
    await pass(CONFIRM_SETTLE_MS)
    // back: until the debounce puts the subscribe on the wire again, the key is not wired
    ;(useScreenActive as jest.Mock).mockReturnValue(true)
    await h.rerender()
    expect(h.subs.isWired('NSE', 'RELIANCE')).toBe(false)
    await pass(CONFIRM_SETTLE_MS * 2)
    expect(screen.queryByText(FIVE_ONLY)).toBeNull()
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
  })

  test('once the first two ticks are judged, later ticks are neither kept nor judged', async () => {
    const judge = jest.spyOn(depthSupport, 'confirmLevels')
    const h = await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(20) })
    await h.tick({ depth: book(20) })
    // the verdict: 20 levels stay
    expect(judge).toHaveBeenLastCalledWith(expect.objectContaining({ wsLevels: [20, 20] }))
    const judged = judge.mock.calls.length

    // the rest of a trading session's ticks
    for (let i = 0; i < 50; i++) await h.tick({ depth: book(20), ltp: 1424 + i })
    expect(judge).toHaveBeenCalledTimes(judged)
    const kept = judge.mock.calls.map(([f]) => f.wsLevels.length)
    expect(Math.max(...kept)).toBe(2)
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
    expect(bids()).toHaveLength(20)

    // a fresh subscribe (the screen comes back) starts a fresh check
    ;(useScreenActive as jest.Mock).mockReturnValue(false)
    await h.rerender()
    ;(useScreenActive as jest.Mock).mockReturnValue(true)
    await h.rerender()
    await pass(ON_WIRE_MS)
    h.ack({ depth: 20 })
    await pass(CONFIRM_SETTLE_MS)
    await h.tick({ depth: book(5) })
    await h.tick({ depth: book(5) })
    expect(judge).toHaveBeenLastCalledWith(expect.objectContaining({ wsLevels: [5, 5] }))
    expect(screen.getByText(FIVE_ONLY)).toBeTruthy()
  })
})

describe('ladder', () => {
  test('a bid opens SELL LIMIT at its price; an ask BUY LIMIT', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick({ depth: book(5, 1423.9, 1424.15) })
    await fireEvent.press(screen.getByTestId('depth-bid-0'))
    expect(mockPush).toHaveBeenLastCalledWith(
      ticketHref({ ...RELIANCE, action: 'SELL', pricetype: 'LIMIT', price: 1423.9 }),
    )
    await fireEvent.press(screen.getByTestId('depth-ask-0'))
    expect(mockPush).toHaveBeenLastCalledWith(
      ticketHref({ ...RELIANCE, action: 'BUY', pricetype: 'LIMIT', price: 1424.15 }),
    )
  })

  test('each level shows price, quantity and orders', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick({
      depth: {
        buy: [{ price: 1423.9, quantity: 1250, orders: 7 }],
        sell: [{ price: 1424, quantity: 40 }],
        levels: 1,
      },
    })
    expect(screen.getByTestId('depth-bid-0')).toHaveTextContent(/1,423\.90.*7.*1,250/)
    expect(screen.getByTestId('depth-ask-0')).toHaveTextContent(/1,424\.00.*40/)
  })

  test('the ladder heads read Bid, Orders, Qty and Offer, Orders, Qty', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick({ depth: book(5) })
    const head = screen.getByTestId('depth-ladder').children[0]
    expect(JSON.stringify(head)).toMatch(/Bid.*Orders.*Qty.*Offer.*Orders.*Qty/)
  })

  test('BUY and SELL open a MARKET ticket', async () => {
    await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-buy'))
    expect(mockPush).toHaveBeenLastCalledWith(
      ticketHref({ ...RELIANCE, action: 'BUY', pricetype: 'MARKET' }),
    )
    await fireEvent.press(screen.getByTestId('depth-sell'))
    expect(mockPush).toHaveBeenLastCalledWith(
      ticketHref({ ...RELIANCE, action: 'SELL', pricetype: 'MARKET' }),
    )
  })

  test('logged out: the broker banner; BUY, SELL and level taps open nothing', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick({ depth: book(5) })
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    expect(screen.getByTestId('banner-broker')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('depth-buy'))
    await fireEvent.press(screen.getByTestId('depth-sell'))
    await fireEvent.press(screen.getByTestId('depth-bid-0'))
    await fireEvent.press(screen.getByTestId('depth-ask-0'))
    expect(mockPush).not.toHaveBeenCalled()
  })

  test('a skeleton until the first book; on the live feed a quiet book is no error', async () => {
    const h = await open('NSE', 'RELIANCE')
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    await pass(NO_BOOK_MS * 2)
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    expect(screen.queryByTestId('depth-error')).toBeNull()
    await h.tick({ depth: book(5) })
    expect(screen.queryByTestId('skeleton')).toBeNull()
  })

  test('the BUY and SELL footer clears the home indicator: its bottom padding adds the inset', async () => {
    const a = await open('NSE', 'RELIANCE', setup('dhan', { insets: { bottom: 34 } }))
    const pad = () => StyleSheet.flatten(screen.getByTestId('depth-footer').props.style)
    expect(pad().paddingBottom).toBe(12 + 34)
    expect(pad().paddingTop).toBe(12)
    await a.unmount()
    await open('NSE', 'RELIANCE', setup('dhan'))
    expect(pad().paddingBottom).toBe(12)
  })
})

describe('a book that does not come (design 7.11)', () => {
  beforeEach(() => {
    useConnection.getState().set({ feed: 'polling' })
    // the engine logs each failed poll
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  test('failing /depth polls: an error with "Try again", which polls /depth at once', async () => {
    let up = false
    const depth = jest.fn(async () => {
      if (!up) throw UNREACHABLE
      return depthReply(5)
    })
    await open('NSE', 'RELIANCE', setup('dhan', { polling: 'real', depth }))
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    expect(screen.queryByTestId('depth-error')).toBeNull()
    // the first poll fails
    await pass(POLL_RATES.depth.home)
    expect(depth).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('depth-error')).toBeTruthy()
    expect(screen.queryByTestId('skeleton')).toBeNull()
    // BUY and SELL stay: a MARKET ticket needs no book
    expect(screen.getByTestId('depth-buy')).toBeTruthy()

    // the server is back: "Try again" polls now, not at the next interval
    up = true
    await fireEvent.press(screen.getByText('Try again'))
    await pass(0)
    expect(depth).toHaveBeenCalledTimes(2)
    expect(depth).toHaveBeenLastCalledWith({ symbol: 'RELIANCE', exchange: 'NSE' })
    expect(screen.queryByTestId('depth-error')).toBeNull()
    expect(bids()).toHaveLength(5)
    expect(screen.getByTestId('depth-total-buy')).toHaveTextContent('5,000')
  })

  test("a retry that fails says why; the polls' next reply clears it", async () => {
    let up = false
    const depth = jest.fn(async () => {
      if (!up) throw UNREACHABLE
      return depthReply(5)
    })
    await open('NSE', 'RELIANCE', setup('dhan', { polling: 'real', depth }))
    await pass(POLL_RATES.depth.home)
    await fireEvent.press(screen.getByText('Try again'))
    await pass(0)
    expect(depth).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('depth-error')).toHaveTextContent(SERVER_DOWN, { exact: false })
    // the engine goes on polling; its first reply brings the book
    up = true
    await pass(POLL_RATES.depth.home)
    expect(screen.queryByTestId('depth-error')).toBeNull()
    expect(bids()).toHaveLength(5)
  })

  test('no book within NO_BOOK_MS while the feed is not live: an error with "Try again"', async () => {
    // polls that neither fail nor deliver
    const depth = jest.fn(async () => depthReply(5))
    await open('NSE', 'RELIANCE', setup('dhan', { depth }))
    await pass(NO_BOOK_MS - 100)
    expect(screen.getByTestId('skeleton')).toBeTruthy()
    expect(screen.queryByTestId('depth-error')).toBeNull()
    await pass(100)
    expect(screen.getByTestId('depth-error')).toBeTruthy()
    expect(depth).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByText('Try again'))
    await pass(0)
    expect(depth).toHaveBeenCalledTimes(1)
    expect(bids()).toHaveLength(5)
  })

  test('the time limit is longer than two of the slowest depth polls (tunnel, market closed)', () => {
    expect(NO_BOOK_MS).toBeGreaterThanOrEqual(
      2 * POLL_RATES.depth.tunnel * POLL_RATES.offHoursFactor,
    )
  })

  test('logged out: no error and no retry, since nothing may poll the broker', async () => {
    useConnection.getState().set({ brokerSession: 'logged_out' })
    const depth = jest.fn(async () => {
      throw UNREACHABLE
    })
    await open('NSE', 'RELIANCE', setup('dhan', { polling: 'real', depth }))
    await pass(NO_BOOK_MS * 2)
    expect(screen.queryByTestId('depth-error')).toBeNull()
    expect(screen.queryByText('Try again')).toBeNull()
    expect(screen.getByTestId('skeleton')).toBeTruthy()
  })
})

describe('header', () => {
  const quote: QuotePatch = {
    ltp: 1500,
    close: 1490,
    open: 1495,
    high: 1510.5,
    low: 1488,
    volume: 1234567,
    oi: 98765,
    totalBuyQty: 45000,
    totalSellQty: 52000,
    depth: book(5),
  }

  test('LTP, change, O/H/L, prev close, volume and the totals; no OI on NSE', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick(quote)
    expect(screen.getByTestId('depth-ltp')).toHaveTextContent('1,500.00')
    expect(screen.getByTestId('depth-change')).toHaveTextContent(/\+10\.00/)
    expect(screen.getByTestId('depth-open')).toHaveTextContent('1,495.00')
    expect(screen.getByTestId('depth-high')).toHaveTextContent('1,510.50')
    expect(screen.getByTestId('depth-low')).toHaveTextContent('1,488.00')
    expect(screen.getByTestId('depth-prev-close')).toHaveTextContent('1,490.00')
    expect(screen.getByTestId('depth-volume')).toHaveTextContent('12,34,567')
    expect(screen.getByTestId('depth-total-buy')).toHaveTextContent('45,000')
    expect(screen.getByTestId('depth-total-sell')).toHaveTextContent('52,000')
    expect(screen.queryByTestId('depth-oi')).toBeNull()
    // the header reads the depth subscription's own ticks: no second quote consumer
    expect(h.register).toHaveBeenCalledTimes(1)
    expect(h.acquire).toHaveBeenCalledTimes(1)
  })

  test('OI on a derivative exchange', async () => {
    const h = await open('NFO', 'NIFTY25NOV25FUT')
    await h.tick(quote)
    expect(screen.getByTestId('depth-oi')).toHaveTextContent('98,765')
  })

  test('stale prices say when they last updated', async () => {
    const h = await open('NSE', 'RELIANCE')
    await h.tick(quote)
    expect(screen.queryByTestId('stale-note')).toBeNull()
    await act(async () => h.store.setStale(true))
    expect(screen.getByTestId('stale-note')).toHaveTextContent(/Last updated \d\d:\d\d:\d\d/)
  })
})

describe('quote-only and unknown', () => {
  test('NIFTY: the quote, no ladder and no BUY or SELL, on mode 2', async () => {
    const h = await open('NSE_INDEX', 'NIFTY')
    await h.tick({ ltp: 24000, close: 23900, depth: book(5) })
    expect(screen.getByTestId('depth-ltp')).toHaveTextContent('24,000.00')
    expect(bids()).toHaveLength(0)
    expect(screen.queryByTestId('depth-buy')).toBeNull()
    expect(screen.queryByTestId('depth-sell')).toBeNull()
    expect(screen.queryByTestId('depth-levels-5')).toBeNull()
    expect(screen.queryByTestId('depth-total-buy')).toBeNull()
    expect(h.acquire).toHaveBeenCalledWith({ exchange: 'NSE_INDEX', symbol: 'NIFTY', mode: 2 })
    expect(h.acquire).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 3 }))
  })

  test('depth-chart opens the chart, on NIFTY and on RELIANCE', async () => {
    const a = await open('NSE_INDEX', 'NIFTY')
    await fireEvent.press(screen.getByTestId('depth-chart'))
    expect(mockPush).toHaveBeenLastCalledWith(chartHref('NSE_INDEX', 'NIFTY'))
    await a.unmount()
    await open('NSE', 'RELIANCE')
    await fireEvent.press(screen.getByTestId('depth-chart'))
    expect(mockPush).toHaveBeenLastCalledWith(chartHref('NSE', 'RELIANCE'))
  })

  test('an expired contract: "Expired or unknown", and no feed slot or poll', async () => {
    const h = await open('NFO', 'GONE')
    expect(screen.getByTestId('depth-unknown')).toHaveTextContent('Expired or unknown')
    expect(screen.queryByTestId('depth-buy')).toBeNull()
    expect(screen.queryByTestId('depth-chart')).toBeNull()
    expect(h.acquire).not.toHaveBeenCalled()
    expect(h.register).not.toHaveBeenCalled()
  })
})

describe('depth route', () => {
  test('opens the screen for the key', async () => {
    const h = setup()
    mockKey = 'NSE%3ARELIANCE'
    await render(h.tree(<DepthRoute />))
    await pass(10)
    expect(screen.getByTestId('depth-screen')).toBeTruthy()
    expect(h.acquire).toHaveBeenCalledWith({ ...RELIANCE, mode: 3, depth: 5 })
  })

  test('a malformed link says so', async () => {
    mockKey = 'RELIANCE'
    await render(<DepthRoute />)
    expect(screen.getByText('This link is incomplete.')).toBeTruthy()
  })
})

describe('DepthPanel on its own', () => {
  test('dhan, NSE, live: the level switch, and a bid tap reports a SELL LIMIT at its price', async () => {
    const h = setup()
    const onLevel = jest.fn()
    await render(h.tree(<DepthPanel exchange="NSE" symbol="RELIANCE" onLevel={onLevel} />))
    await pass(10)
    expect(screen.getByTestId('depth-levels-20')).toBeTruthy()
    await act(async () => {
      jest.advanceTimersByTime(5)
      h.store.put('NSE:RELIANCE', { depth: book(5), totalBuyQty: 5000, totalSellQty: 6000 }, 'ws')
    })
    expect(screen.getByTestId('depth-total-buy')).toHaveTextContent('5,000')
    await fireEvent.press(screen.getByTestId('depth-bid-0'))
    expect(onLevel).toHaveBeenLastCalledWith({
      ...RELIANCE,
      action: 'SELL',
      pricetype: 'LIMIT',
      price: 1423.9,
    })
  })

  test('choosing 20 leaves no depth-5 hold behind (one book consumer)', async () => {
    const h = setup()
    await render(h.tree(<DepthPanel exchange="NSE" symbol="RELIANCE" onLevel={jest.fn()} />))
    await pass(10)
    await fireEvent.press(screen.getByTestId('depth-levels-20'))
    const depth = [...h.held].filter((r) => r.mode === 3).map((r) => r.depth)
    expect(depth).toEqual([20])
  })
})
