import type { OrderEventBus } from '~/core/realtime/orderEvents'
import type { PollConsumer } from '~/core/realtime/polling'
import type { OrderUpdate } from '~/core/realtime/protocol'
import type { SubRequest } from '~/core/realtime/subscriptions'
import { createTickStore } from '~/core/realtime/tickStore'
import type { FeedStatus } from '~/core/realtime/wsClient'
import { DOM_WS_URL, type NativeToDom } from '~/dom/bridge/protocol'
import {
  createWsEmulation,
  type EmulationDeps,
  MAX_DOM_PAGE_SYMBOLS,
  MAX_DOM_SOCKETS_PER_PAGE,
  MAX_DOM_SYMBOLS,
} from './wsEmulation'

// Thursday 2026-11-26, 10:00 IST: NSE is open. 17:30 IST: NSE has closed, MCX has not.
const OPEN_AT = Date.parse('2026-11-26T04:30:00Z')
const CLOSED_AT = Date.parse('2026-11-26T12:00:00Z')
const KEY = 'NSE:RELIANCE'

const AUTH_OK = {
  type: 'auth',
  status: 'success',
  message: 'Authentication successful',
  broker: 'zerodha',
  user_id: null,
}
const NOT_AUTHENTICATED = {
  status: 'error',
  code: 'NOT_AUTHENTICATED',
  message: 'You must authenticate first',
}

beforeEach(() => {
  // Fake timers fake Date too, the clock TickStore.put stamps quotes with.
  jest.useFakeTimers({ now: OPEN_AT })
})
afterEach(() => {
  jest.useRealTimers()
})

function fakeRealtime(state: FeedStatus['state']) {
  let status: FeedStatus = {
    state,
    lastCloseCode: null,
    failures: 0,
    everLive: true,
    broker: 'zerodha',
  }
  const listeners = new Set<(s: FeedStatus) => void>()
  let held = 0
  return {
    acquire: jest.fn((_r: SubRequest) => {
      held++
      let live = true
      return () => {
        if (!live) return
        live = false
        held--
      }
    }),
    status: () => status,
    onStatus(fn: (s: FeedStatus) => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    set(p: Partial<FeedStatus>) {
      status = { ...status, ...p }
      for (const fn of Array.from(listeners)) fn(status)
    },
    held: () => held,
    watchers: () => listeners.size,
  }
}

function fakePolling() {
  let live = 0
  return {
    register: jest.fn((_c: PollConsumer, _a: boolean | (() => boolean)) => {
      live++
      let on = true
      return () => {
        if (!on) return
        on = false
        live--
      }
    }),
    consumers: () => live,
  }
}

function fakeBus(): OrderEventBus & { listeners: () => number } {
  const fns = new Set<(u: OrderUpdate) => void>()
  return {
    emit: (u) => {
      for (const fn of Array.from(fns)) fn(u)
    },
    subscribe(fn) {
      fns.add(fn)
      return () => {
        fns.delete(fn)
      }
    },
    listeners: () => fns.size,
  }
}

type Reply = Record<string, unknown>
type SocketPost = Extract<NativeToDom, { kind: 'socket' }>

function setup(
  o: {
    whenPolling?: 'relay' | 'fail'
    feedMode?: 'live' | 'polling'
    isOpen?: EmulationDeps['isOpen']
  } = {},
) {
  let pending: (() => void) | null = null
  const store = createTickStore((fn) => {
    pending = fn
  })
  let feedMode = o.feedMode ?? 'live'
  const rt = fakeRealtime(feedMode === 'polling' ? 'polling' : 'live')
  const polling = fakePolling()
  const bus = fakeBus()
  const active = () => true
  const posts: NativeToDom[] = []
  const em = createWsEmulation({
    realtime: rt,
    store,
    polling,
    orderEvents: bus,
    feedMode: () => feedMode,
    whenPolling: o.whenPolling ?? 'relay',
    active,
    post: (m) => posts.push(m),
    ...(o.isOpen ? { isOpen: o.isOpen } : {}),
  })

  const open = (sid: number, url = DOM_WS_URL) =>
    em.handle({ v: 1, kind: 'socket', sid, op: 'open', url })
  const send = (sid: number, msg: object | string) =>
    em.handle({
      v: 1,
      kind: 'socket',
      sid,
      op: 'send',
      data: typeof msg === 'string' ? msg : JSON.stringify(msg),
    })
  const close = (sid: number) => em.handle({ v: 1, kind: 'socket', sid, op: 'close' })

  /** What was posted to `sid` since the last call: frames parsed, open and close as `{event}`. */
  const replies = (sid: number): Reply[] => {
    const mine: SocketPost[] = []
    const rest: NativeToDom[] = []
    for (const p of posts) {
      if (p.kind === 'socket' && p.sid === sid) mine.push(p)
      else rest.push(p)
    }
    posts.splice(0, posts.length, ...rest)
    return mine.map((p) =>
      p.event === 'message' ? (JSON.parse(p.data) as Reply) : { event: p.event },
    )
  }

  /** The one reply posted to `sid` since the last read. */
  const reply = (sid: number): Reply => {
    const [only, ...more] = replies(sid)
    expect(more).toEqual([])
    if (!only) throw new Error(`nothing was posted to socket ${sid}`)
    return only
  }

  /** An open, authenticated socket with nothing left to read. */
  const authed = (sid: number) => {
    open(sid)
    send(sid, { action: 'authenticate', api_key: '__native__' })
    replies(sid)
  }

  /** The library's own subscribe frame: one pair, a numeric mode, depth only for Depth. */
  const sub = (sid: number, symbol: string, mode: 1 | 2 | 3, exchange = 'NSE') => {
    send(sid, {
      action: 'subscribe',
      symbol,
      exchange,
      mode,
      ...(mode === 3 ? { depth: 5, depth_level: 5 } : {}),
    })
  }

  const flush = () => {
    const fn = pending
    pending = null
    fn?.()
  }

  return {
    em,
    rt,
    store,
    polling,
    bus,
    active,
    posts,
    open,
    send,
    close,
    replies,
    reply,
    authed,
    sub,
    flush,
    setFeedMode: (m: 'live' | 'polling') => {
      feedMode = m
    },
  }
}

const tick = (symbol: string, mode: number, data: object, exchange = 'NSE') => ({
  type: 'market_data',
  symbol,
  exchange,
  mode,
  broker: 'zerodha',
  data,
})

test('authenticate succeeds locally whatever the key; subscriptions need it first', () => {
  const t = setup()
  t.open(1)
  expect(t.replies(1)).toEqual([{ event: 'open' }])

  t.sub(1, 'RELIANCE', 1)
  t.send(1, { action: 'unsubscribe', symbol: 'RELIANCE', exchange: 'NSE', mode: 1 })
  t.send(1, { action: 'unsubscribe_all' })
  t.send(1, { action: 'subscribe_orders' })
  expect(t.replies(1)).toEqual(Array(4).fill(NOT_AUTHENTICATED))
  expect(t.rt.acquire).not.toHaveBeenCalled()
  expect(t.bus.listeners()).toBe(0)

  t.send(1, { action: 'authenticate', api_key: '__native__' })
  t.send(1, { action: 'auth', api_key: 'any other key' })
  expect(t.replies(1)).toEqual([AUTH_OK, AUTH_OK])

  t.sub(1, 'RELIANCE', 1)
  expect(t.rt.acquire).toHaveBeenCalledTimes(1)
})

test('an open to any other URL is closed at once, and a closed socket is not answered', () => {
  const t = setup()
  t.open(1, 'wss://evil.example/ws')
  expect(t.replies(1)).toEqual([{ event: 'close' }])
  expect(t.em.openSockets()).toBe(0)

  t.send(1, { action: 'ping' })
  t.send(7, { action: 'authenticate', api_key: 'x' })
  t.close(7)
  expect(t.posts).toEqual([])
})

test('subscribe holds the app feed at the mode asked and acks like the server', () => {
  const t = setup()
  t.authed(1)
  t.send(1, {
    action: 'subscribe',
    symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }],
    mode: 3,
    depth: 5,
  })
  expect(t.rt.acquire).toHaveBeenCalledWith({
    exchange: 'NSE',
    symbol: 'RELIANCE',
    mode: 3,
    depth: 5,
  })
  const ack = t.reply(1)
  expect((ack.subscriptions as Reply[])[0]).toMatchObject({
    status: 'success',
    mode: 'Depth',
    depth: 5,
  })
  expect(ack).toEqual({
    type: 'subscribe',
    status: 'success',
    subscriptions: [
      {
        symbol: 'RELIANCE',
        exchange: 'NSE',
        status: 'success',
        mode: 'Depth',
        depth: 5,
        broker: 'zerodha',
      },
    ],
    message: 'Subscription processing complete',
    broker: 'zerodha',
  })

  // The library's frame: one pair and a numeric mode. LTP carries no depth.
  t.sub(1, 'INFY', 1)
  expect(t.rt.acquire).toHaveBeenLastCalledWith({ exchange: 'NSE', symbol: 'INFY', mode: 1 })
  expect(t.reply(1).subscriptions).toEqual([
    { symbol: 'INFY', exchange: 'NSE', status: 'success', mode: 'LTP', broker: 'zerodha' },
  ])

  // A label in any case, and the level under depth_level.
  t.send(1, { action: 'subscribe', symbol: 'TCS', exchange: 'NSE', mode: 'depth', depth_level: 20 })
  expect(t.rt.acquire).toHaveBeenLastCalledWith({
    exchange: 'NSE',
    symbol: 'TCS',
    mode: 3,
    depth: 20,
  })
  expect(t.reply(1).subscriptions).toEqual([expect.objectContaining({ mode: 'Depth', depth: 20 })])

  // A level the app's feed does not have is 5, and so is one that is not a number.
  for (const level of [{ depth: 50 }, { depth_level: 7 }, { depth: '20' }]) {
    t.send(1, { action: 'subscribe', symbol: 'SBIN', exchange: 'NSE', mode: 3, ...level })
    expect(t.rt.acquire).toHaveBeenLastCalledWith({
      exchange: 'NSE',
      symbol: 'SBIN',
      mode: 3,
      depth: 5,
    })
    expect(t.reply(1).subscriptions).toEqual([expect.objectContaining({ mode: 'Depth', depth: 5 })])
  }
})

test('a repeated subscribe replaces its hold: one hold, one frame per flush', () => {
  const t = setup()
  t.authed(1)
  t.sub(1, 'RELIANCE', 3)
  t.send(1, { action: 'subscribe', symbol: 'RELIANCE', exchange: 'NSE', mode: 3, depth: 20 })
  t.replies(1)
  expect(t.rt.acquire).toHaveBeenLastCalledWith({
    exchange: 'NSE',
    symbol: 'RELIANCE',
    mode: 3,
    depth: 20,
  })
  expect(t.rt.held()).toBe(1)
  expect(t.polling.consumers()).toBe(1)

  t.store.put(KEY, { ltp: 2500 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([tick('RELIANCE', 3, { ltp: 2500, depth: { buy: [], sell: [] } })])
})

test('a bad exchange is an error entry and the ack is partial', () => {
  const t = setup()
  t.authed(1)
  t.send(1, {
    action: 'subscribe',
    symbols: [
      { symbol: 'RELIANCE', exchange: 'NSE' },
      { symbol: 'AAPL', exchange: 'NASDAQ' },
      { symbol: 'X'.repeat(65), exchange: 'NSE' },
      // Like the server, a pair without a symbol or an exchange is skipped.
      { symbol: '', exchange: 'NSE' },
      { exchange: 'NSE' },
    ],
    mode: 1,
  })
  expect(t.rt.acquire).toHaveBeenCalledTimes(1)
  const ack = t.reply(1)
  expect(ack.status).toBe('partial')
  expect(ack.subscriptions).toEqual([
    expect.objectContaining({ symbol: 'RELIANCE', status: 'success' }),
    {
      symbol: 'AAPL',
      exchange: 'NASDAQ',
      status: 'error',
      message: 'Invalid exchange',
      broker: 'zerodha',
    },
    expect.objectContaining({ exchange: 'NSE', status: 'error', message: 'Invalid symbol' }),
  ])
})

test('ticks after the subscribe become one market_data frame per subscriber per flush, at its mode', () => {
  const t = setup()
  t.authed(1)
  t.authed(2)
  t.sub(1, 'RELIANCE', 1)
  t.sub(2, 'RELIANCE', 2)
  t.sub(2, 'RELIANCE', 3)
  t.replies(1)
  t.replies(2)

  t.store.put(KEY, { ltp: 2500 }, 'ws')
  t.store.put(
    KEY,
    {
      ltp: 2501,
      open: 2490,
      high: 2510,
      low: 2480,
      close: 2470,
      volume: 120_000,
      avgPrice: 2495.5,
      bid: 2500.5,
      ask: 2501.5,
      totalBuyQty: 1000,
      totalSellQty: 800,
      lastQty: 5,
      upperCircuit: 2700,
      depth: {
        buy: [{ price: 2500.5, quantity: 10, orders: 2 }],
        sell: [{ price: 2501.5, quantity: 4 }],
        levels: 1,
      },
    },
    'ws',
  )
  t.flush()

  expect(t.replies(1)).toEqual([tick('RELIANCE', 1, { ltp: 2501 })])
  // oi is absent from the quote, so the Quote frame leaves it out.
  expect(t.replies(2)).toEqual([
    tick('RELIANCE', 2, {
      ltp: 2501,
      open: 2490,
      high: 2510,
      low: 2480,
      close: 2470,
      volume: 120_000,
      average_price: 2495.5,
      bid: 2500.5,
      ask: 2501.5,
    }),
    tick('RELIANCE', 3, {
      ltp: 2501,
      depth: {
        buy: [{ price: 2500.5, quantity: 10, orders: 2 }],
        sell: [{ price: 2501.5, quantity: 4 }],
      },
      total_buy_quantity: 1000,
      total_sell_quantity: 800,
    }),
  ])

  // Nothing new in the store, nothing sent.
  t.flush()
  expect(t.posts).toEqual([])
})

test('a ws tick carries its trade time as ltt at every mode; a polled quote does not (conflict 5)', () => {
  const t = setup()
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'RELIANCE', 2)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  const book = { buy: [{ price: 2499.5, quantity: 3 }], sell: [], levels: 1 }

  t.store.put(KEY, { ltp: 2500, ltt: OPEN_AT - 500, volume: 900, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 1, { ltp: 2500, ltt: OPEN_AT - 500 }),
    tick('RELIANCE', 2, { ltp: 2500, ltt: OPEN_AT - 500, volume: 900 }),
    tick('RELIANCE', 3, {
      ltp: 2500,
      ltt: OPEN_AT - 500,
      depth: { buy: [{ price: 2499.5, quantity: 3 }], sell: [] },
    }),
  ])

  // The store keeps the ws trade time under the polled price; it is not this quote's.
  t.store.put(KEY, { ltp: 2502 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 1, { ltp: 2502 }),
    tick('RELIANCE', 2, { ltp: 2502, volume: 900 }),
    tick('RELIANCE', 3, { ltp: 2502, depth: { buy: [], sell: [] } }),
  ])
})

test("a ws price that came without a trade time is not framed on the earlier trade's ltt", () => {
  const t = setup()
  // Another screen's stream left its last trade time in the store.
  t.store.put(KEY, { ltp: 2400, ltt: OPEN_AT - 60_000 }, 'ws')
  t.flush()
  jest.advanceTimersByTime(1000)
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  const book = { buy: [{ price: 2409, quantity: 2 }], sell: [], levels: 1 }

  // This stream sends no ltt: the merge keeps the old one under each new price.
  t.store.put(KEY, { ltp: 2410 }, 'ws')
  t.flush()
  expect(t.store.get(KEY)?.ltt).toBe(OPEN_AT - 60_000)
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 1, { ltp: 2410 }),
    tick('RELIANCE', 3, { ltp: 2410, depth: { buy: [], sell: [] } }),
  ])

  // A book at that same price is still not the old trade's.
  t.store.put(KEY, { ltp: 2410, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 1, { ltp: 2410 }),
    tick('RELIANCE', 3, { ltp: 2410, depth: { buy: [{ price: 2409, quantity: 2 }], sell: [] } }),
  ])

  // A new trade time is framed, and stays with its price while only the book moves.
  t.store.put(KEY, { ltp: 2411, ltt: OPEN_AT + 900 }, 'ws')
  t.flush()
  t.store.put(KEY, { ltp: 2411, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1).map((r) => (r.data as Reply).ltt)).toEqual([
    OPEN_AT + 900,
    OPEN_AT + 900,
    OPEN_AT + 900,
    OPEN_AT + 900,
  ])
})

test('an ltt stored before the subscribe is never framed, nor after a repeated subscribe', () => {
  const t = setup()
  // Another screen's streams: a trade time, then a price that came without one. The merge keeps
  // the old ltt under the newer ltp, so the store's ltt is not its ltp's.
  t.store.put(KEY, { ltp: 2400, ltt: OPEN_AT - 60_000 }, 'ws')
  t.flush()
  t.store.put(KEY, { ltp: 2405 }, 'ws')
  t.flush()
  expect(t.store.get(KEY)).toMatchObject({ ltp: 2405, ltt: OPEN_AT - 60_000 })
  jest.advanceTimersByTime(1000)
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'RELIANCE', 2)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  const book = { buy: [{ price: 2404, quantity: 2 }], sell: [], levels: 1 }
  // The three holds' frames; toEqual reads an undefined ltt as absent, as the frame leaves it out.
  const framed = (ltp: number, ltt?: number) => [
    tick('RELIANCE', 1, { ltp, ltt }),
    tick('RELIANCE', 2, { ltp, ltt, volume: 1000 }),
    tick('RELIANCE', 3, {
      ltp,
      ltt,
      depth: { buy: [{ price: 2404, quantity: 2 }], sell: [] },
    }),
  ]

  // A book and a volume at the price the subscribe found are not the old trade's.
  t.store.put(KEY, { ltp: 2405, volume: 1000, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual(framed(2405))

  // A new trade time is this stream's, and is framed.
  t.store.put(KEY, { ltp: 2406, ltt: OPEN_AT + 900 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual(framed(2406, OPEN_AT + 900))

  // A price without one leaves that ltt behind, and a repeated subscribe does not take it back.
  t.store.put(KEY, { ltp: 2407 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual(framed(2407))
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  t.store.put(KEY, { ltp: 2407, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual(framed(2407))

  // The next trade time is framed on every hold, the replaced one too.
  t.store.put(KEY, { ltp: 2408, ltt: OPEN_AT + 2000 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual(framed(2408, OPEN_AT + 2000))
})

test('a quote stored before the subscribe, or a seed, is never sent (RF 5)', () => {
  const t = setup()
  // Another screen streamed the symbol: the store holds its last quote, unflushed.
  t.store.put(KEY, { ltp: 2400 }, 'ws')
  jest.advanceTimersByTime(1000)
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  t.flush()
  expect(t.replies(1)).toEqual([])

  t.store.seed(KEY, { ltp: 2450 }, Date.now())
  t.flush()
  expect(t.replies(1)).toEqual([])

  t.store.put(KEY, { ltp: 2460 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 1, { ltp: 2460 }),
    tick('RELIANCE', 3, { ltp: 2460, depth: { buy: [], sell: [] } }),
  ])
})

test('unsubscribe, close and closeAll release every hold', () => {
  const t = setup()
  t.authed(1)
  t.send(1, {
    action: 'subscribe',
    symbols: [
      { symbol: 'RELIANCE', exchange: 'NSE' },
      { symbol: 'INFY', exchange: 'NSE' },
    ],
    mode: 1,
  })
  t.sub(1, 'RELIANCE', 3)
  t.send(1, { action: 'subscribe_orders' })
  t.replies(1)
  expect(t.rt.held()).toBe(3)
  expect(t.polling.consumers()).toBe(3)

  t.send(1, { action: 'unsubscribe', symbol: 'INFY', exchange: 'NSE', mode: 1 })
  expect(t.replies(1)).toEqual([
    {
      type: 'unsubscribe',
      status: 'success',
      message: 'Unsubscription processing complete',
      successful: [
        { symbol: 'INFY', exchange: 'NSE', mode: 'LTP', status: 'success', broker: 'zerodha' },
      ],
      failed: [],
      broker: 'zerodha',
    },
  ])
  expect(t.rt.held()).toBe(2)
  expect(t.polling.consumers()).toBe(2)

  t.send(1, { action: 'unsubscribe_all' })
  const all = t.reply(1)
  expect(all).toMatchObject({ type: 'unsubscribe', status: 'success', failed: [] })
  expect(all.successful).toEqual([
    expect.objectContaining({ symbol: 'RELIANCE', mode: 'LTP' }),
    expect.objectContaining({ symbol: 'RELIANCE', mode: 'Depth' }),
  ])
  expect(t.rt.held()).toBe(0)
  expect(t.polling.consumers()).toBe(0)

  // The page closes the socket: its holds and its order stream go, and nothing is posted.
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'INFY', 3)
  t.replies(1)
  t.close(1)
  expect(t.rt.held()).toBe(0)
  expect(t.polling.consumers()).toBe(0)
  expect(t.bus.listeners()).toBe(0)
  expect(t.em.openSockets()).toBe(0)
  expect(t.posts).toEqual([])

  // closeAll (the page is gone or reloads) releases every socket's and posts nothing.
  t.authed(2)
  t.authed(3)
  t.sub(2, 'RELIANCE', 1)
  t.sub(3, 'RELIANCE', 3)
  t.send(3, { action: 'subscribe_orders' })
  t.replies(2)
  t.replies(3)
  expect(t.em.openSockets()).toBe(2)
  t.em.closeAll()
  expect(t.rt.held()).toBe(0)
  expect(t.polling.consumers()).toBe(0)
  expect(t.bus.listeners()).toBe(0)
  expect(t.em.openSockets()).toBe(0)

  t.store.put(KEY, { ltp: 2500 }, 'ws')
  t.flush()
  expect(t.posts).toEqual([])
})

test('a reopened sid starts afresh: the old socket is released and nothing is posted for it', () => {
  const t = setup()
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.replies(1)

  // A reloaded page numbers its sockets from 1 again.
  t.open(1)
  expect(t.replies(1)).toEqual([{ event: 'open' }])
  expect(t.rt.held()).toBe(0)
  expect(t.em.openSockets()).toBe(1)
  t.sub(1, 'RELIANCE', 1)
  expect(t.replies(1)).toEqual([NOT_AUTHENTICATED])
})

test('unsubscribing mode 1 keeps the Depth hold and its frames', () => {
  const t = setup()
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'RELIANCE', 3)
  t.send(1, { action: 'unsubscribe', symbol: 'RELIANCE', exchange: 'NSE', mode: 1 })
  t.replies(1)
  expect(t.rt.held()).toBe(1)

  t.store.put(
    KEY,
    { ltp: 2500, depth: { buy: [], sell: [{ price: 2501, quantity: 3 }], levels: 1 } },
    'ws',
  )
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 3, { ltp: 2500, depth: { buy: [], sell: [{ price: 2501, quantity: 3 }] } }),
  ])
})

test('under polling a Depth subscriber gets the ltp with an empty book', () => {
  const t = setup({ feedMode: 'polling' })
  t.authed(1)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)

  t.store.put(KEY, { ltp: 2500, bid: 2499.5, ask: 2500.5 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([tick('RELIANCE', 3, { ltp: 2500, depth: { buy: [], sell: [] } })])
})

test('a ws book followed by polling gives the empty book (conflict 5)', () => {
  const t = setup()
  t.authed(1)
  t.sub(1, 'RELIANCE', 3)
  t.replies(1)
  const book = { buy: [{ price: 2499, quantity: 7 }], sell: [], levels: 1 }

  t.store.put(KEY, { ltp: 2500, depth: book }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('RELIANCE', 3, { ltp: 2500, depth: { buy: [{ price: 2499, quantity: 7 }], sell: [] } }),
  ])

  // The feed hands off to polling; the store still merges the old ws book under each poll.
  t.setFeedMode('polling')
  t.rt.set({ state: 'polling' })
  t.store.put(KEY, { ltp: 2503 }, 'poll')
  t.flush()
  expect(t.store.get(KEY)?.depth).toEqual(book)
  expect(t.replies(1)).toEqual([tick('RELIANCE', 3, { ltp: 2503, depth: { buy: [], sell: [] } })])
})

test('an off-hours poll is not framed; a ws tick, or a poll for a market still open, is (conflict 5)', () => {
  jest.setSystemTime(CLOSED_AT)
  const t = setup({ feedMode: 'polling' })
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'CRUDEOIL26DECFUT', 1, 'MCX')
  t.replies(1)

  t.store.put(KEY, { ltp: 2500 }, 'poll')
  t.store.put('MCX:CRUDEOIL26DECFUT', { ltp: 6100 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([tick('CRUDEOIL26DECFUT', 1, { ltp: 6100 }, 'MCX')])

  t.store.put(KEY, { ltp: 2501 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([tick('RELIANCE', 1, { ltp: 2501 })])
})

test('an exchange with no known session window is never filtered by the default hours', () => {
  const t = setup({ feedMode: 'polling' })
  t.authed(1)
  t.sub(1, 'SPX', 1, 'GLOBAL_INDEX')
  t.sub(1, 'GUARSEED', 1, 'NCDEX')
  t.replies(1)

  t.store.put('GLOBAL_INDEX:SPX', { ltp: 6800 }, 'poll')
  t.store.put('NCDEX:GUARSEED', { ltp: 5400 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('SPX', 1, { ltp: 6800 }, 'GLOBAL_INDEX'),
    tick('GUARSEED', 1, { ltp: 5400 }, 'NCDEX'),
  ])
})

test('the open check is injectable: the chart passes its session calendar', () => {
  // A holiday at 10:00 IST, by the calendar; MCX has a special session; NCDEX is unknown.
  const isOpen = jest.fn((exchange: string, _now: number) =>
    exchange === 'NSE' ? false : exchange === 'MCX' ? true : null,
  )
  const t = setup({ feedMode: 'polling', isOpen })
  t.authed(1)
  t.sub(1, 'RELIANCE', 1)
  t.sub(1, 'CRUDEOIL26DECFUT', 1, 'MCX')
  t.sub(1, 'GUARSEED', 1, 'NCDEX')
  t.replies(1)

  t.store.put(KEY, { ltp: 2500 }, 'poll')
  t.store.put('MCX:CRUDEOIL26DECFUT', { ltp: 6100 }, 'poll')
  t.store.put('NCDEX:GUARSEED', { ltp: 5400 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([
    tick('CRUDEOIL26DECFUT', 1, { ltp: 6100 }, 'MCX'),
    tick('GUARSEED', 1, { ltp: 5400 }, 'NCDEX'),
  ])
  expect(isOpen).toHaveBeenCalledWith('NSE', OPEN_AT)

  // Only a polled quote asks: a ws tick on the holiday is the market's own.
  isOpen.mockClear()
  t.store.put(KEY, { ltp: 2501 }, 'ws')
  t.flush()
  expect(t.replies(1)).toEqual([tick('RELIANCE', 1, { ltp: 2501 })])
  expect(isOpen).not.toHaveBeenCalled()
})

test('ping is answered locally', () => {
  const t = setup()
  t.open(1)
  t.replies(1)
  t.send(1, { action: 'ping' })
  expect(t.replies(1)).toEqual([{ type: 'pong', status: 'success', server_timestamp: OPEN_AT }])

  t.send(1, { action: 'authenticate', api_key: '__native__' })
  t.replies(1)
  jest.advanceTimersByTime(45_000)
  t.send(1, { action: 'ping' })
  expect(t.replies(1)).toEqual([
    { type: 'pong', status: 'success', server_timestamp: OPEN_AT + 45_000 },
  ])
  expect(t.rt.acquire).not.toHaveBeenCalled()
})

test('the 51st symbol on one socket is refused', () => {
  const t = setup()
  t.authed(1)
  const symbols = Array.from({ length: MAX_DOM_SYMBOLS + 1 }, (_, i) => ({
    symbol: `S${i}`,
    exchange: 'NSE',
  }))
  t.send(1, { action: 'subscribe', symbols, mode: 1 })
  expect(MAX_DOM_SYMBOLS).toBe(50)
  expect(t.rt.acquire).toHaveBeenCalledTimes(50)
  const ack = t.reply(1)
  expect(ack.status).toBe('partial')
  const entries = ack.subscriptions as Reply[]
  expect(entries.filter((e) => e.status === 'success')).toHaveLength(50)
  expect(entries[50]).toEqual({
    symbol: 'S50',
    exchange: 'NSE',
    status: 'error',
    message: 'At most 50 symbols per connection',
    broker: 'zerodha',
  })

  // A second mode on a symbol it holds is no new symbol.
  t.sub(1, 'S0', 3)
  expect(t.reply(1).status).toBe('success')
  // Unsubscribing frees the place; another socket counts its own.
  t.send(1, { action: 'unsubscribe', symbol: 'S1', exchange: 'NSE', mode: 1 })
  t.replies(1)
  t.sub(1, 'S50', 1)
  expect(t.reply(1).status).toBe('success')
  t.authed(2)
  t.sub(2, 'S51', 1)
  expect(t.reply(2).status).toBe('success')
})

test('a page opens at most 4 sockets at once; one more is closed as it opens', () => {
  const t = setup()
  expect(MAX_DOM_SOCKETS_PER_PAGE).toBe(4)
  const sids = Array.from({ length: MAX_DOM_SOCKETS_PER_PAGE }, (_, i) => i + 1)
  for (const sid of sids) t.authed(sid)
  expect(t.em.openSockets()).toBe(4)

  t.open(5)
  expect(t.replies(5)).toEqual([{ event: 'close' }])
  expect(t.em.openSockets()).toBe(4)
  t.send(5, { action: 'authenticate', api_key: '__native__' })
  expect(t.posts).toEqual([])

  // A reopened sid takes its own place again; a closed one frees its place.
  t.open(4)
  expect(t.replies(4)).toEqual([{ event: 'open' }])
  t.close(4)
  t.open(5)
  expect(t.replies(5)).toEqual([{ event: 'open' }])
  expect(t.em.openSockets()).toBe(4)
})

test('a page holds at most 200 symbols across its sockets', () => {
  const t = setup()
  expect(MAX_DOM_PAGE_SYMBOLS).toBe(200)
  // Four full sockets of their own symbols fill the page: the page's cap is the one that refuses.
  const names = (sid: number) =>
    Array.from({ length: MAX_DOM_SYMBOLS }, (_, i) => ({ symbol: `P${sid}X${i}`, exchange: 'NSE' }))
  for (let sid = 1; sid < MAX_DOM_SOCKETS_PER_PAGE; sid++) {
    t.authed(sid)
    t.send(sid, { action: 'subscribe', symbols: names(sid), mode: 1 })
    expect(t.reply(sid).status).toBe('success')
  }
  // The request that fills the page counts its own symbols as it goes.
  t.authed(4)
  t.send(4, {
    action: 'subscribe',
    symbols: [...names(4), { symbol: 'EXTRA', exchange: 'NSE' }],
    mode: 1,
  })
  const filled = t.reply(4)
  expect(filled.status).toBe('partial')
  expect((filled.subscriptions as Reply[]).at(-1)).toEqual({
    symbol: 'EXTRA',
    exchange: 'NSE',
    status: 'error',
    message: 'At most 200 symbols per page',
    broker: 'zerodha',
  })
  expect(t.rt.held()).toBe(200)

  t.sub(3, 'EXTRA', 1)
  expect(t.reply(3)).toMatchObject({
    status: 'partial',
    subscriptions: [expect.objectContaining({ message: 'At most 200 symbols per page' })],
  })
  expect(t.rt.held()).toBe(200)
  // Another mode on a symbol the page holds is no new symbol.
  t.sub(4, 'P4X0', 3)
  expect(t.reply(4).status).toBe('success')

  // A symbol let go on one socket frees a page place; the full socket still counts its own.
  t.send(1, { action: 'unsubscribe', symbol: 'P1X0', exchange: 'NSE', mode: 1 })
  t.replies(1)
  t.sub(4, 'EXTRA', 1)
  expect((t.reply(4).subscriptions as Reply[])[0]?.message).toBe(
    'At most 50 symbols per connection',
  )
  t.sub(1, 'EXTRA', 1)
  expect(t.reply(1).status).toBe('success')
  expect(t.rt.held()).toBe(201) // 200 symbols, one of them at two modes
})

test('subscribe_orders forwards order updates', () => {
  const t = setup()
  t.authed(1)
  t.authed(2)
  t.send(1, { action: 'subscribe_orders' })
  t.send(1, { action: 'subscribe_orders' })
  expect(t.replies(1)).toEqual(
    Array(2).fill({
      type: 'subscribe_orders',
      status: 'success',
      message: 'Subscribed to order updates',
    }),
  )
  expect(t.bus.listeners()).toBe(1)

  const update: OrderUpdate = {
    t: 'order_update',
    user_id: 'trader1',
    mode: 'analyze',
    broker: 'zerodha',
    orderid: '250101000001',
    symbol: 'RELIANCE',
    exchange: 'NSE',
    action: 'BUY',
    quantity: 1,
    price: 0,
    pricetype: 'MARKET',
    product: 'MIS',
    order_status: 'complete',
    filled_quantity: 1,
    pending_quantity: 0,
    average_price: 2500,
  }
  t.bus.emit(update)
  // The server's field names, without the parser's tag or the user (conflict 15).
  expect(t.replies(1)).toEqual([
    {
      type: 'order_update',
      mode: 'analyze',
      broker: 'zerodha',
      orderid: '250101000001',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      action: 'BUY',
      quantity: 1,
      price: 0,
      pricetype: 'MARKET',
      product: 'MIS',
      order_status: 'complete',
      filled_quantity: 1,
      pending_quantity: 0,
      average_price: 2500,
    },
  ])
  expect(t.replies(2)).toEqual([])

  t.send(1, { action: 'unsubscribe_orders' })
  expect(t.replies(1)).toEqual([
    { type: 'unsubscribe_orders', status: 'success', message: 'Unsubscribed from order updates' },
  ])
  expect(t.bus.listeners()).toBe(0)
  t.bus.emit(update)
  expect(t.replies(1)).toEqual([])
})

test("'fail': polling closes at once, and a live feed that drops to polling closes the socket", () => {
  const t = setup({ whenPolling: 'fail', feedMode: 'polling' })
  t.open(1)
  expect(t.replies(1)).toEqual([{ event: 'close' }])
  expect(t.em.openSockets()).toBe(0)

  t.setFeedMode('live')
  t.rt.set({ state: 'live' })
  t.authed(2)
  t.sub(2, 'RELIANCE', 1)
  t.replies(2)
  expect(t.polling.register).not.toHaveBeenCalled()

  t.rt.set({ state: 'reconnecting' })
  expect(t.replies(2)).toEqual([])
  t.rt.set({ state: 'polling' })
  expect(t.replies(2)).toEqual([{ event: 'close' }])
  expect(t.rt.held()).toBe(0)
  expect(t.em.openSockets()).toBe(0)
  expect(t.rt.watchers()).toBe(0)

  t.send(2, { action: 'ping' })
  expect(t.posts).toEqual([])
})

test("'fail': either the feed's state or feedMode() saying polling refuses an open", () => {
  // The app socket's state says polling while feedMode() still says live.
  const t = setup({ whenPolling: 'fail' })
  t.rt.set({ state: 'polling' })
  t.open(1)
  expect(t.replies(1)).toEqual([{ event: 'close' }])
  expect(t.em.openSockets()).toBe(0)

  // feedMode() says polling while the state still says live.
  const u = setup({ whenPolling: 'fail' })
  u.setFeedMode('polling')
  u.open(1)
  expect(u.replies(1)).toEqual([{ event: 'close' }])
  expect(u.em.openSockets()).toBe(0)
})

test("'relay': polling registers a quotes consumer with active, and polled quotes reach the socket", () => {
  const t = setup({ feedMode: 'polling' })
  t.open(1)
  expect(t.replies(1)).toEqual([{ event: 'open' }])
  t.send(1, { action: 'authenticate', api_key: '__native__' })
  t.sub(1, 'RELIANCE', 1)
  t.replies(1)
  expect(t.polling.register).toHaveBeenCalledWith(
    { kind: 'quotes', keys: expect.any(Function) },
    t.active,
  )
  const consumer = t.polling.register.mock.calls[0]?.[0]
  expect(consumer?.kind === 'quotes' && consumer.keys()).toEqual([KEY])

  t.store.put(KEY, { ltp: 2500, close: 2470 }, 'poll')
  t.flush()
  expect(t.replies(1)).toEqual([tick('RELIANCE', 1, { ltp: 2500 })])
  expect(t.rt.watchers()).toBe(0)
})

test.each(['relay', 'fail'] as const)(
  "a lock, a 1012 or a reconnect never closes the DOM socket, and ticks resume (RF 4, '%s')",
  (whenPolling) => {
    const t = setup({ whenPolling })
    t.authed(1)
    t.sub(1, 'RELIANCE', 1)
    t.sub(1, 'RELIANCE', 3)
    t.replies(1)

    t.rt.set({ state: 'stopped' }) // the vault locked
    t.rt.set({ state: 'reconnecting', lastCloseCode: 1012 })
    t.rt.set({ state: 'live', lastCloseCode: 1012 })
    expect(t.replies(1)).toEqual([])
    expect(t.em.openSockets()).toBe(1)
    expect(t.rt.acquire).toHaveBeenCalledTimes(2)
    expect(t.rt.held()).toBe(2)

    t.store.put(KEY, { ltp: 2510 }, 'ws')
    t.flush()
    expect(t.replies(1)).toEqual([
      tick('RELIANCE', 1, { ltp: 2510 }),
      tick('RELIANCE', 3, { ltp: 2510, depth: { buy: [], sell: [] } }),
    ])
  },
)

test('unknown actions and non-JSON frames get the server error codes', () => {
  const t = setup()
  t.open(1)
  t.replies(1)
  // Before authenticating too: the server checks the action first (conflict 15).
  t.send(1, { action: 'subscribe_depth' })
  t.send(1, 'not json')
  t.send(1, '[1,2]')
  expect(t.replies(1)).toEqual([
    { status: 'error', code: 'INVALID_ACTION', message: 'Invalid action: subscribe_depth' },
    { status: 'error', code: 'INVALID_JSON', message: 'Invalid JSON message' },
    { status: 'error', code: 'INVALID_JSON', message: 'Invalid JSON message' },
  ])

  t.send(1, { action: 'authenticate', api_key: '__native__' })
  t.replies(1)
  t.send(1, { action: 'get_quotes' })
  t.send(1, '{')
  expect(t.replies(1)).toEqual([
    { status: 'error', code: 'INVALID_ACTION', message: 'Invalid action: get_quotes' },
    { status: 'error', code: 'INVALID_JSON', message: 'Invalid JSON message' },
  ])
})

test('modes and missing symbols follow the server (conflict 15)', () => {
  const t = setup()
  t.authed(1)
  const invalidMode = expect.objectContaining({ status: 'error', code: 'INVALID_MODE' })

  // No mode means Quote.
  t.send(1, { action: 'subscribe', symbol: 'RELIANCE', exchange: 'NSE' })
  expect(t.rt.acquire).toHaveBeenLastCalledWith({ exchange: 'NSE', symbol: 'RELIANCE', mode: 2 })
  expect(t.reply(1).subscriptions).toEqual([expect.objectContaining({ mode: 'Quote' })])

  for (const mode of [0, 4, '3', 'full', true, null]) {
    t.send(1, { action: 'subscribe', symbol: 'INFY', exchange: 'NSE', mode })
  }
  expect(t.replies(1)).toEqual(Array(6).fill(invalidMode))

  t.send(1, { action: 'subscribe', mode: 1 })
  t.send(1, { action: 'subscribe', symbols: [], mode: 1 })
  expect(t.replies(1)).toEqual(
    Array(2).fill({
      status: 'error',
      code: 'INVALID_PARAMETERS',
      message: 'At least one symbol must be specified',
    }),
  )
  expect(t.rt.acquire).toHaveBeenCalledTimes(1)

  // An unsubscribe with no mode means Quote too, so the LTP hold stays.
  t.sub(1, 'RELIANCE', 1)
  t.replies(1)
  t.send(1, { action: 'unsubscribe', symbol: 'RELIANCE', exchange: 'NSE' })
  expect(t.reply(1).successful).toEqual([expect.objectContaining({ mode: 'Quote' })])
  expect(t.rt.held()).toBe(1)

  t.send(1, { action: 'unsubscribe', symbol: 'RELIANCE', exchange: 'NSE', mode: 9 })
  t.send(1, { action: 'unsubscribe', mode: 1 })
  t.send(1, {
    action: 'unsubscribe',
    symbols: [{ symbol: 'RELIANCE', exchange: 'NSE', mode: 'x' }],
  })
  expect(t.replies(1)).toEqual([
    invalidMode,
    {
      status: 'error',
      code: 'INVALID_PARAMETERS',
      message: 'Either symbols or unsubscribe_all is required',
    },
    expect.objectContaining({
      type: 'unsubscribe',
      status: 'error',
      successful: [],
      failed: [expect.objectContaining({ symbol: 'RELIANCE', mode: null, status: 'error' })],
    }),
  ])
  expect(t.rt.held()).toBe(1)

  // A symbol's own mode beats the request's.
  t.send(1, {
    action: 'unsubscribe',
    symbols: [{ symbol: 'RELIANCE', exchange: 'NSE', mode: 1 }],
    mode: 2,
  })
  expect(t.rt.held()).toBe(0)
  t.replies(1)

  // An item without both a symbol and an exchange is skipped, after its mode is read.
  t.send(1, {
    action: 'unsubscribe',
    symbols: [{ exchange: 'NSE' }, { symbol: '', exchange: 'NSE' }, { symbol: 'TCS' }, 'TCS'],
    mode: 1,
  })
  expect(t.reply(1)).toMatchObject({ type: 'unsubscribe', status: 'success', successful: [] })
})
