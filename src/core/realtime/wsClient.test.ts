import type { WsCaps } from '~/core/capabilities/gates'
import { clearLogs, getLogLines } from '~/core/log/logger'
import type { BrokerSession } from '~/core/services/connection'
import {
  AUTH_OK,
  type FakeSocket,
  fakeSockets,
  PONG,
  wsError,
} from '../../../test/helpers/fakeSocket'
import { authMsg, quoteKey } from './protocol'
import { createTickStore } from './tickStore'
import { createRealtime, type FeedStatus, type RealtimeDeps } from './wsClient'

const KEY = 'ab'.repeat(32)
const URL = 'ws://192.168.1.5:8765'
const MIN = 60_000

type Profile = { feedMode: 'live' | 'polling'; lastFeedRetryAt: number | null }

const consoles = ['debug', 'info', 'warn', 'error'] as const

beforeEach(() => {
  jest.useFakeTimers({ now: 0 })
  for (const m of consoles) jest.spyOn(console, m).mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

function setup(
  o: {
    ws?: Partial<WsCaps>
    /** Used as is, so two clients can share one profile (a cold start). */
    profile?: Profile
    f?: ReturnType<typeof fakeSockets>
    deps?: Partial<RealtimeDeps>
  } = {},
) {
  const f = o.f ?? fakeSockets()
  const store = createTickStore((fn) => fn())
  let ws: WsCaps = { orderStream: null, ping: null, close1012: false, authDeadline: true, ...o.ws }
  const caps = {
    ws: () => ws,
    setWs: jest.fn((p: Partial<WsCaps>) => {
      ws = { ...ws, ...p }
    }),
  }
  const profile: Profile = o.profile ?? { feedMode: 'live', lastFeedRetryAt: null }
  const d = {
    url: (): string | null => URL,
    feedMode: () => profile.feedMode,
    getKey: () => KEY,
    WebSocketImpl: f.WebSocketImpl,
    lastFeedRetryAt: () => profile.lastFeedRetryAt,
    store,
    caps,
    isExchangeOpen: jest.fn((_exchange: string, _now: number) => true),
    onBrokerError: jest.fn(async (_code: string): Promise<BrokerSession> => 'active'),
    onKeyInvalid: jest.fn(),
    on1012: jest.fn(),
    onSilence: jest.fn(),
    onOrderUpdate: jest.fn(),
    onResync: jest.fn(),
    // Task 18's wiring (ruling 7): every retry, and the handoff, are written to the profile.
    onPollingRetry: jest.fn((ok: boolean) => {
      profile.lastFeedRetryAt = Date.now()
      profile.feedMode = ok ? 'live' : 'polling'
    }),
    ...o.deps,
  }
  const rt = createRealtime(d)
  return { rt, d, f, store, profile, ws: () => ws }
}

/** The server opens the socket and accepts the key. */
const live = (s: FakeSocket, frame: object = AUTH_OK) => {
  s.serverOpen()
  s.serverSend(frame)
}

/** Each socket fails as soon as it is made, `n` times in all. */
const failEach = (f: ReturnType<typeof fakeSockets>, n: number) => {
  for (let i = 0; i < n; i++) {
    if (i > 0) jest.advanceTimersToNextTimer()
    f.last().serverClose(1006)
  }
}

const tick = (symbol = 'RELIANCE') => ({
  type: 'market_data',
  symbol,
  exchange: 'NSE',
  mode: 2,
  broker: 'zerodha',
  data: { ltp: 1424 },
})

const RELIANCE = { exchange: 'NSE', symbol: 'RELIANCE', mode: 2 } as const

describe('createRealtime', () => {
  test('B2 no URL, or the polling feed mode, gives polling and opens no socket', () => {
    const a = setup({ deps: { url: () => null } })
    a.rt.start()
    // a retry 0 ms ago: the next is 10 minutes off (B8)
    const b = setup({ profile: { feedMode: 'polling', lastFeedRetryAt: 0 } })
    b.rt.start()
    jest.advanceTimersByTime(10 * MIN - 1)
    expect(a.rt.status().state).toBe('polling')
    expect(b.rt.status().state).toBe('polling')
    expect(a.f.sockets).toHaveLength(0)
    expect(b.f.sockets).toHaveLength(0)
  })

  test('B3 on open it sends authenticate, which is never logged; frames are logged by type only', () => {
    clearLogs()
    const { rt, f } = setup()
    const states: string[] = []
    rt.onStatus((s) => states.push(s.state))
    rt.start()
    expect(f.last().url).toBe(URL)
    f.last().serverOpen()
    expect(f.last().sent).toEqual([authMsg(KEY)])
    f.last().serverSend(AUTH_OK)
    expect(states).toEqual(['connecting', 'authenticating', 'live'])

    const printed = consoles.flatMap((m) => (console[m] as jest.Mock).mock.calls.flat())
    const logged = [...getLogLines(), ...printed.map(String)].join('\n')
    expect(logged).toContain('→ authenticate')
    expect(logged).toContain('← auth_ok')
    expect(logged).not.toContain(KEY)
    expect(logged).not.toContain('[redacted-key]')
    expect(logged).not.toContain('api_key')
    expect(logged).not.toContain('Authentication successful')
  })

  test('B3 no auth_ok within 15 s closes the socket and counts a failure', () => {
    const { rt, f } = setup()
    rt.start()
    f.last().serverOpen()
    jest.advanceTimersByTime(14_999)
    expect(f.last().closeCode).toBeUndefined()
    jest.advanceTimersByTime(1)
    expect(f.last().closeCode).toBe(1000)
    expect(rt.status()).toMatchObject({ state: 'reconnecting', failures: 1 })
    // The close event of the client's own close changes nothing.
    f.last().serverClose(1000)
    expect(rt.status().failures).toBe(1)
    jest.advanceTimersByTime(1_000)
    expect(f.sockets).toHaveLength(2)
  })

  test('B3 auth_ok: live with failures reset, every subscription resent, then subscribe_orders', () => {
    const { rt, f } = setup()
    rt.acquire(RELIANCE)
    rt.start()
    f.last().serverClose(1006)
    expect(rt.status().failures).toBe(1)
    jest.advanceTimersByTime(1_000)
    expect(rt.isLive('NSE', 'RELIANCE')).toBe(false)
    live(f.last())
    expect(rt.status()).toEqual<FeedStatus>({
      state: 'live',
      lastCloseCode: 1006,
      failures: 0,
      everLive: true,
      broker: 'zerodha',
    })
    expect(f.last().frames()).toEqual([
      { action: 'authenticate', api_key: KEY },
      { action: 'subscribe', symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }], mode: 2 },
      { action: 'subscribe_orders' },
    ])
    expect(rt.isLive('NSE', 'RELIANCE')).toBe(true)
    expect(rt.isLive('NSE', 'TCS')).toBe(false)
  })

  test('B3 the subscribe_orders ack sets orderStream; INVALID_ACTION turns it off for good', () => {
    const a = setup()
    a.rt.start()
    live(a.f.last())
    a.f.last().serverSend({ type: 'subscribe_orders', status: 'success', message: 'Subscribed' })
    expect(a.ws().orderStream).toBe(true)

    const b = setup()
    b.rt.start()
    live(b.f.last())
    b.f.last().serverSend(wsError('INVALID_ACTION', 'Invalid action: subscribe_orders'))
    expect(b.ws().orderStream).toBe(false)
    expect(b.rt.status().state).toBe('live')
    b.f.last().serverClose(1006)
    jest.advanceTimersByTime(1_000)
    live(b.f.last())
    expect(b.f.last().actions()).toEqual(['authenticate'])
  })

  test('B4 a ping every 25 s; a pong marks ping supported, INVALID_ACTION turns it off', () => {
    const { rt, f, ws } = setup()
    rt.start()
    live(f.last())
    const pings = () =>
      f
        .last()
        .actions()
        .filter((a) => a === 'ping').length
    jest.advanceTimersByTime(24_999)
    expect(pings()).toBe(0)
    jest.advanceTimersByTime(1)
    expect(pings()).toBe(1)
    f.last().serverSend(PONG)
    expect(ws().ping).toBe(true)
    jest.advanceTimersByTime(25_000)
    expect(pings()).toBe(2)
    f.last().serverSend(wsError('INVALID_ACTION', 'Invalid action: ping'))
    expect(ws().ping).toBe(false)
    jest.advanceTimersByTime(10 * MIN)
    expect(pings()).toBe(2)
    expect(f.sockets).toHaveLength(1)
    expect(rt.status().state).toBe('live')
  })

  test('B4 no frame within 10 s of a ping reconnects', () => {
    const { rt, f } = setup()
    rt.start()
    live(f.last())
    jest.advanceTimersByTime(30_000)
    f.last().serverSend(tick()) // any frame answers the first ping
    jest.advanceTimersByTime(20_000) // the second ping, at 50 s
    jest.advanceTimersByTime(9_999)
    expect(f.last().closeCode).toBeUndefined()
    jest.advanceTimersByTime(1)
    expect(f.last().closeCode).toBe(1000)
    expect(rt.status()).toMatchObject({ state: 'reconnecting', failures: 1 })
    jest.advanceTimersByTime(1_000)
    expect(f.sockets).toHaveLength(2)
  })

  test('B5 ticks go to the store; a depth tick notes its priced levels', () => {
    const { rt, f, store } = setup()
    const release = rt.acquire({ exchange: 'NSE', symbol: 'RELIANCE', mode: 3, depth: 20 })
    rt.start()
    live(f.last())
    f.last().serverSend({
      type: 'subscribe',
      status: 'success',
      subscriptions: [
        { symbol: 'RELIANCE', exchange: 'NSE', status: 'success', mode: 'Depth', depth: 20 },
      ],
    })
    jest.advanceTimersByTime(1_234)
    f.last().serverSend({
      type: 'market_data',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      mode: 3,
      data: {
        ltp: 1424,
        close: 1418,
        depth: {
          buy: [
            { price: 1423.9, quantity: 10, orders: 2 },
            { price: 1423.8, quantity: 5, orders: 1 },
            { price: 0, quantity: 0, orders: 0 },
          ],
          sell: [
            { price: 1424.1, quantity: 7, orders: 1 },
            { price: 0, quantity: 0, orders: 0 },
          ],
        },
      },
    })
    const key = quoteKey('NSE', 'RELIANCE')
    expect(store.get(key)).toMatchObject({ ltp: 1424, close: 1418, source: 'ws' })
    expect(store.get(key)?.depth).toEqual({
      buy: [
        { price: 1423.9, quantity: 10, orders: 2 },
        { price: 1423.8, quantity: 5, orders: 1 },
      ],
      sell: [{ price: 1424.1, quantity: 7, orders: 1 }],
      levels: 2,
    })
    expect(rt.confirmedDepth('NSE', 'RELIANCE')).toBe(2)
    expect(store.lastWsTickAt()).toBe(1_234)

    release() // no longer Depth: the book goes
    expect(store.get(key)?.depth).toBeUndefined()
    expect(store.get(key)?.ltp).toBe(1424)
  })

  test('B5 order_update is deduplicated on orderid|order_status|filled_quantity over the last 500', () => {
    const { rt, f, d } = setup()
    rt.start()
    live(f.last())
    const update = (orderid: string, order_status: string, filled_quantity: number) => ({
      type: 'order_update',
      user_id: 'u1',
      mode: 'live',
      broker: 'zerodha',
      orderid,
      symbol: 'RELIANCE',
      exchange: 'NSE',
      action: 'BUY',
      quantity: 10,
      price: 0,
      trigger_price: 0,
      pricetype: 'MARKET',
      product: 'MIS',
      order_status,
      filled_quantity,
      pending_quantity: 10 - filled_quantity,
      average_price: 0,
      rejection_reason: '',
    })
    const send = (...a: Parameters<typeof update>) => f.last().serverSend(update(...a))
    send('1', 'open', 0)
    send('1', 'open', 0)
    expect(d.onOrderUpdate).toHaveBeenCalledTimes(1)
    expect(d.onOrderUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderid: '1', order_status: 'open', filled_quantity: 0 }),
    )
    send('1', 'open', 4)
    send('1', 'complete', 10)
    expect(d.onOrderUpdate).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 497; i++) send(`x${i}`, 'open', 0)
    expect(d.onOrderUpdate).toHaveBeenCalledTimes(500)
    send('1', 'open', 0) // still among the last 500
    expect(d.onOrderUpdate).toHaveBeenCalledTimes(500)
    send('x497', 'open', 0) // the 501st pushes the first out
    send('1', 'open', 0)
    expect(d.onOrderUpdate).toHaveBeenCalledTimes(502)
  })

  test('B6 AUTHENTICATION_ERROR: key_invalid, onKeyInvalid and no reconnect', () => {
    const { rt, f, d } = setup()
    rt.start()
    f.last().serverOpen()
    f.last().serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    expect(rt.status().state).toBe('key_invalid')
    expect(d.onKeyInvalid).toHaveBeenCalledTimes(1)
    expect(f.last().closeCode).toBe(1000)
    jest.advanceTimersByTime(30 * MIN)
    expect(f.sockets).toHaveLength(1)
  })

  test('B6 a BROKER_* error closes 1000 and awaits onBrokerError; logged_out stays down until start()', async () => {
    const onBrokerError = jest.fn(async (): Promise<BrokerSession> => 'logged_out')
    const { rt, f } = setup({ deps: { onBrokerError } })
    rt.start()
    f.last().serverOpen()
    f.last().serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    expect(f.last().closeCode).toBe(1000)
    expect(onBrokerError).toHaveBeenCalledWith('BROKER_ERROR')
    await jest.advanceTimersByTimeAsync(30 * MIN)
    expect(rt.status().state).toBe('broker_logged_out')
    expect(f.sockets).toHaveLength(1)
    rt.start()
    expect(f.sockets).toHaveLength(2)
  })

  test.each(['active', 'unknown'] as const)(
    'B6 a BROKER_* error with the session %s counts a failure and reconnects on the B7 schedule',
    async (session) => {
      const { rt, f } = setup({ deps: { onBrokerError: async () => session } })
      rt.start()
      f.last().serverOpen()
      f.last().serverSend(wsError('BROKER_CONNECTION_ERROR', 'Failed to connect to broker'))
      expect(f.last().closeCode).toBe(1000)
      await jest.advanceTimersByTimeAsync(0)
      expect(rt.status()).toMatchObject({ state: 'reconnecting', failures: 1 })
      await jest.advanceTimersByTimeAsync(999)
      expect(f.sockets).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(f.sockets).toHaveLength(2)
    },
  )

  test('B6 NOT_AUTHENTICATED reconnects', () => {
    const { rt, f } = setup()
    rt.start()
    live(f.last())
    f.last().serverSend(wsError('NOT_AUTHENTICATED', 'You must authenticate first'))
    expect(f.last().closeCode).toBe(1000)
    jest.advanceTimersByTime(1_000)
    expect(f.sockets).toHaveLength(2)
  })

  test('B6 a SERVER_ERROR answering a subscribe leaves those symbols to polling, still live', () => {
    const { rt, f } = setup()
    rt.acquire(RELIANCE)
    rt.acquire({ exchange: 'NSE', symbol: 'TCS', mode: 2 })
    rt.start()
    live(f.last())
    expect(rt.isLive('NSE', 'RELIANCE')).toBe(true)
    // the proxy's adapter threw inside its per-symbol loop: one error, no ack (S11)
    f.last().serverSend(wsError('SERVER_ERROR', "'NoneType' object has no attribute 'get'"))
    expect(rt.status().state).toBe('live')
    expect(rt.isLive('NSE', 'RELIANCE')).toBe(false)
    expect(rt.isLive('NSE', 'TCS')).toBe(false)
    expect(f.sockets).toHaveLength(1)
  })

  test('B6 an INVALID_ACTION answering subscribe_orders does not touch the subscriptions', () => {
    const { rt, f } = setup()
    rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    f.last().serverSend(wsError('INVALID_ACTION', 'Invalid action: subscribe_orders'))
    expect(rt.isLive('NSE', 'RELIANCE')).toBe(true)
  })

  test('B6 an error answering an unsubscribe is not taken for the subscribe after it', () => {
    const { rt, f } = setup()
    const release = rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    f.last().serverSend({
      type: 'subscribe',
      status: 'success',
      subscriptions: [{ symbol: 'RELIANCE', exchange: 'NSE', status: 'success', mode: 'Quote' }],
    })
    release()
    rt.acquire({ exchange: 'NSE', symbol: 'TCS', mode: 2 })
    jest.advanceTimersByTime(100) // unsubscribe RELIANCE, then subscribe TCS
    f.last().serverSend(
      wsError('INVALID_PARAMETERS', 'Either symbols or unsubscribe_all is required'),
    )
    expect(rt.isLive('NSE', 'TCS')).toBe(true)
    f.last().serverSend({
      type: 'subscribe',
      status: 'success',
      subscriptions: [{ symbol: 'TCS', exchange: 'NSE', status: 'success', mode: 'Quote' }],
    })
    f.last().serverSend(wsError('SERVER_ERROR', 'unrelated')) // nothing is waiting for it
    expect(rt.isLive('NSE', 'TCS')).toBe(true)
  })

  test('B7 1012 calls on1012, reconnects at once and resets failures', () => {
    const { rt, f, d } = setup()
    rt.start()
    failEach(f, 2)
    expect(rt.status().failures).toBe(2)
    jest.advanceTimersToNextTimer()
    f.last().serverOpen()
    f.last().serverClose(1012, 'Broker credentials changed')
    expect(d.on1012).toHaveBeenCalledTimes(1)
    expect(f.sockets).toHaveLength(4)
    expect(rt.status()).toMatchObject({ state: 'connecting', failures: 0, lastCloseCode: 1012 })
  })

  test('B7 other closes back off 1000, 2000, 4000, 8000, 16000, then 30000 and 30000', () => {
    const { rt, f } = setup()
    rt.start()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      const closedAt = Date.now()
      f.last().serverClose(i % 2 ? 4401 : 1006)
      jest.advanceTimersToNextTimer()
      delays.push(Date.now() - closedAt)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(f.sockets).toHaveLength(8)
  })

  test('B7 after 10 consecutive failures the state is polling; start() does not reconnect', () => {
    const { rt, f, d } = setup()
    rt.start()
    failEach(f, 10)
    expect(f.sockets).toHaveLength(10)
    expect(rt.status()).toMatchObject({ state: 'polling', failures: 10 })
    expect(d.onPollingRetry).toHaveBeenCalledTimes(1)
    expect(d.onPollingRetry).toHaveBeenCalledWith(false) // ruling 7
    jest.advanceTimersByTime(9 * MIN)
    rt.start()
    expect(f.sockets).toHaveLength(10)
    expect(rt.status().state).toBe('polling')
  })

  test('B7 a feed that was live this session never hands off: it waits out the outage at 30 s', () => {
    const { rt, f, d } = setup()
    rt.start()
    live(f.last())
    f.last().serverClose(1006) // the server restarts for an update
    for (let i = 0; i < 12; i++) {
      jest.advanceTimersToNextTimer()
      f.last().serverClose(1006)
    }
    expect(rt.status()).toMatchObject({ state: 'reconnecting', failures: 13 })
    expect(d.onPollingRetry).not.toHaveBeenCalled()
    const at = Date.now()
    jest.advanceTimersToNextTimer()
    expect(Date.now() - at).toBe(30_000)
    live(f.last())
    expect(rt.status()).toMatchObject({ state: 'live', failures: 0 })
  })

  test('B7 a socket that fails while the phone is offline is not counted; the network back reconnects at once', () => {
    const net = { online: true }
    const { rt, f, d } = setup({ deps: { isOnline: () => net.online } })
    rt.start()
    net.online = false // a lift, a train, a Wi-Fi handover
    failEach(f, 15)
    expect(rt.status()).toMatchObject({ state: 'reconnecting', failures: 0 })
    expect(d.onPollingRetry).not.toHaveBeenCalled()
    net.online = true
    const sockets = f.sockets.length
    rt.networkBack()
    expect(f.sockets).toHaveLength(sockets + 1)
    live(f.last())
    expect(rt.status().state).toBe('live')
  })

  test('B7 while REST gets no reply either, the reconnects do not hand off to polling', () => {
    const reach = { v: false as boolean | null }
    const { rt, f, d } = setup({ deps: { serverReachable: () => reach.v } })
    rt.start()
    failEach(f, 12) // the home server is out of reach, not its feed
    expect(rt.status().state).toBe('reconnecting')
    expect(d.onPollingRetry).not.toHaveBeenCalled()
    reach.v = null // nothing to go on: RF 4 applies
    jest.advanceTimersToNextTimer()
    f.last().serverClose(1006)
    expect(rt.status().state).toBe('polling')
    expect(d.onPollingRetry).toHaveBeenCalledWith(false)
  })

  test('B8 polling in the foreground retries on its own every 10 min (RF 4), and not in the background', async () => {
    const { rt, f, d } = setup()
    rt.start()
    failEach(f, 10)
    expect(rt.status().state).toBe('polling')
    await jest.advanceTimersByTimeAsync(10 * MIN - 1)
    expect(f.sockets).toHaveLength(10)
    await jest.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(11)
    f.last().serverClose(1006)
    await jest.advanceTimersByTimeAsync(0)
    expect(d.onPollingRetry).toHaveBeenLastCalledWith(false)
    rt.setAppState('background')
    await jest.advanceTimersByTimeAsync(60 * MIN)
    expect(f.sockets).toHaveLength(11)
    rt.setAppState('active') // overdue: it retries at once
    expect(f.sockets).toHaveLength(12)
  })

  test('B8 the network back retries from polling only once the 10 minutes are up', async () => {
    const { rt, f } = setup()
    rt.start()
    failEach(f, 10)
    rt.networkBack()
    expect(f.sockets).toHaveLength(10)
    rt.setAppState('background')
    await jest.advanceTimersByTimeAsync(10 * MIN)
    rt.networkBack()
    expect(f.sockets).toHaveLength(11)
  })

  test('B8 (ruling 188) a retry answered with BROKER_* proves the feed: stored live, and it connects', async () => {
    const onBrokerError = jest.fn(async (): Promise<BrokerSession> => 'logged_out')
    const { rt, f, d, profile } = setup({
      profile: { feedMode: 'polling', lastFeedRetryAt: null },
      deps: { onBrokerError },
    })
    rt.start()
    rt.setAppState('background')
    rt.setAppState('active')
    const probe = f.last()
    probe.serverOpen()
    probe.serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    await jest.advanceTimersByTimeAsync(0)
    expect(d.onPollingRetry).toHaveBeenCalledWith(true)
    expect(profile.feedMode).toBe('live')
    expect(f.sockets).toHaveLength(2)
    f.last().serverOpen()
    f.last().serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    await jest.advanceTimersByTimeAsync(0)
    expect(rt.status().state).toBe('broker_logged_out')
    rt.start() // the broker login: the feed comes back at once, not 10 minutes later
    expect(f.sockets).toHaveLength(3)
    live(f.last())
    expect(rt.status().state).toBe('live')
  })

  test('B8 (RF 4) 10 sockets, then polling; one retry per 10 min on foreground, counted across cold starts', async () => {
    const f = fakeSockets()
    const a = setup({ f })
    a.rt.start()
    failEach(f, 10)
    expect(a.rt.status().state).toBe('polling')
    const handoff = Date.now()

    const foreground = async (rt: typeof a.rt, awayMs: number) => {
      rt.setAppState('background')
      await jest.advanceTimersByTimeAsync(awayMs)
      rt.setAppState('active')
    }
    for (let i = 0; i < 20; i++) await foreground(a.rt, 27_000)
    expect(Date.now() - handoff).toBe(9 * MIN)
    expect(f.sockets).toHaveLength(10)

    await foreground(a.rt, MIN)
    expect(f.sockets).toHaveLength(11)
    f.last().serverClose(1006) // the retry fails too
    await jest.advanceTimersByTimeAsync(0)
    expect(a.d.onPollingRetry).toHaveBeenLastCalledWith(false)
    const retriedAt = Date.now()
    expect(a.profile.lastFeedRetryAt).toBe(retriedAt)
    await foreground(a.rt, 1_000)
    expect(f.sockets).toHaveLength(11)
    expect(a.rt.status().state).toBe('polling')
    a.rt.stop()

    // A cold start 5 min after the failed retry reads the window from the profile.
    await jest.advanceTimersByTimeAsync(5 * MIN - 1_000)
    const b = setup({ f, profile: a.profile })
    b.rt.start()
    await foreground(b.rt, 1_000)
    expect(b.rt.status().state).toBe('polling')
    expect(f.sockets).toHaveLength(11)
    await foreground(b.rt, 5 * MIN - 1_000)
    expect(Date.now() - retriedAt).toBe(10 * MIN)
    expect(f.sockets).toHaveLength(12)
  })

  test('B8 a successful retry reports ok and connects', async () => {
    const { rt, f, d } = setup({ profile: { feedMode: 'polling', lastFeedRetryAt: null } })
    rt.start()
    expect(f.sockets).toHaveLength(0)
    rt.setAppState('background')
    rt.setAppState('active')
    expect(f.sockets).toHaveLength(1)
    const probe = f.last()
    live(probe)
    probe.serverSend(PONG)
    await jest.advanceTimersByTimeAsync(0)
    expect(probe.closeCode).toBe(1000)
    expect(d.onPollingRetry).toHaveBeenCalledWith(true)
    expect(f.sockets).toHaveLength(2)
    live(f.last())
    expect(rt.status().state).toBe('live')
  })

  test('B8 a retry that succeeds after stop() is recorded but does not connect', async () => {
    const { rt, f, d } = setup({ profile: { feedMode: 'polling', lastFeedRetryAt: null } })
    rt.start()
    rt.setAppState('background')
    rt.setAppState('active')
    rt.stop()
    live(f.last())
    f.last().serverSend(PONG)
    await jest.advanceTimersByTimeAsync(0)
    expect(d.onPollingRetry).toHaveBeenCalledWith(true)
    expect(f.sockets).toHaveLength(1)
    expect(rt.status().state).toBe('stopped')
  })

  test('B9 silence on an open exchange: the first fire reconnects, the second calls onSilence once, then quiet until a tick', () => {
    const { rt, f, d } = setup({ ws: { ping: false } })
    rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    f.last().serverSend(tick())
    jest.advanceTimersByTime(60_000) // checks at 15, 30, 45 and 60 s: not more than 60 s old
    expect(f.sockets).toHaveLength(1)
    jest.advanceTimersByTime(15_000)
    expect(f.sockets[0]?.closeCode).toBe(1000)
    expect(f.sockets).toHaveLength(2)
    expect(d.onSilence).not.toHaveBeenCalled()
    expect(d.isExchangeOpen).toHaveBeenCalledWith('NSE', 75_000)

    live(f.last())
    jest.advanceTimersByTime(75_000) // still silent, 60 s after the new auth
    expect(d.onSilence).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(10 * MIN)
    expect(d.onSilence).toHaveBeenCalledTimes(1)
    expect(f.sockets).toHaveLength(2)

    f.last().serverSend(tick()) // a tick re-arms it
    jest.advanceTimersByTime(75_000)
    expect(f.sockets).toHaveLength(3)
  })

  test('B9 with no tick yet, silence counts from the auth', () => {
    jest.setSystemTime(1_732_421_234_000) // a real clock: lastWsTickAt() is 0, ages ago
    const { rt, f } = setup({ ws: { ping: false } })
    rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    jest.advanceTimersByTime(60_000)
    expect(f.sockets).toHaveLength(1)
    jest.advanceTimersByTime(15_000)
    expect(f.sockets).toHaveLength(2)
  })

  test('B9 a closed exchange never fires', () => {
    const { rt, f, d } = setup({ ws: { ping: false }, deps: { isExchangeOpen: () => false } })
    rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    jest.advanceTimersByTime(60 * MIN)
    expect(f.sockets).toHaveLength(1)
    expect(d.onSilence).not.toHaveBeenCalled()
  })

  test('B9 the watchdog does not run when the server closes 1012', () => {
    const { rt, f, d } = setup({ ws: { ping: false, close1012: true } })
    rt.acquire(RELIANCE)
    rt.start()
    live(f.last())
    jest.advanceTimersByTime(60 * MIN)
    expect(f.sockets).toHaveLength(1)
    expect(d.onSilence).not.toHaveBeenCalled()
  })

  test('B10 after 30 s in the background the socket closes 1000; on active it reconnects and resyncs', () => {
    const { rt, f, d } = setup({ ws: { ping: false } })
    rt.start()
    live(f.last())
    rt.setAppState('background')
    jest.advanceTimersByTime(29_000)
    expect(f.last().closeCode).toBeUndefined()
    jest.advanceTimersByTime(1_000)
    expect(f.last().closeCode).toBe(1000)
    jest.advanceTimersByTime(30 * MIN)
    expect(f.sockets).toHaveLength(1)
    expect(d.onResync).not.toHaveBeenCalled()

    rt.setAppState('active')
    expect(f.sockets).toHaveLength(2)
    expect(d.onResync).toHaveBeenCalledTimes(1)
    live(f.last())
    expect(rt.status().state).toBe('live')
  })

  test('B10 back before 30 s cancels the pending close', () => {
    const { rt, f, d } = setup({ ws: { ping: false } })
    rt.start()
    live(f.last())
    rt.setAppState('background')
    jest.advanceTimersByTime(20_000)
    rt.setAppState('active')
    jest.advanceTimersByTime(30 * MIN)
    expect(f.last().closeCode).toBeUndefined()
    expect(f.sockets).toHaveLength(1)
    expect(d.onResync).not.toHaveBeenCalled()
  })

  test('stop closes 1000, cancels every timer, and a later start connects afresh', () => {
    const { rt, f } = setup()
    rt.start()
    f.last().serverClose(1006)
    rt.stop()
    expect(rt.status()).toMatchObject({ state: 'stopped', failures: 0 })
    jest.advanceTimersByTime(30 * MIN)
    expect(f.sockets).toHaveLength(1)

    rt.start()
    expect(f.sockets).toHaveLength(2)
    live(f.last())
    rt.start() // already running: nothing changes
    expect(f.sockets).toHaveLength(2)
    expect(rt.status().state).toBe('live')
    rt.stop()
    expect(f.last().closeCode).toBe(1000)
    jest.advanceTimersByTime(30 * MIN)
    expect(f.sockets).toHaveLength(2)
  })

  test('a key that cannot be read (app locked) stops the feed instead of retrying', () => {
    const { rt, f } = setup({
      deps: {
        getKey: () => {
          throw new Error('locked')
        },
      },
    })
    rt.start()
    f.last().serverOpen()
    expect(f.last().sent).toEqual([])
    expect(f.last().closeCode).toBe(1000)
    expect(rt.status().state).toBe('stopped')
    jest.advanceTimersByTime(30 * MIN)
    expect(f.sockets).toHaveLength(1)
  })
})
