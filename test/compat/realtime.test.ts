// The live feed (wsClient) against the stock-server mock over a real socket.
import { WebSocket } from 'ws'
import type { FeedStatus } from '~/core/realtime/wsClient'
import {
  KEY,
  makeFeed,
  type NodeWebSocket,
  PROFILE_IDS,
  sleep,
  until,
  WRONG_KEY,
} from '../helpers/compatApp'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'

const RELIANCE = 'NSE:RELIANCE'
const R = { exchange: 'NSE', symbol: 'RELIANCE' }

let mock: MockServerProcess | null = null
let stopFeed: (() => void) | null = null
afterEach(async () => {
  stopFeed?.()
  stopFeed = null
  await mock?.stop()
  mock = null
})

async function start(env: Record<string, string>, o: Parameters<typeof makeFeed>[1] = {}) {
  mock = await startMockServerProcess(env)
  const feed = await makeFeed(mock, o)
  stopFeed = () => feed.realtime.stop()
  return { mock, feed }
}

describe('ticks', () => {
  test.each(PROFILE_IDS)('%s: a Quote tick arrives within 2 s', async (p) => {
    const { feed } = await start({ PROFILE: p })
    feed.realtime.start()
    feed.realtime.acquire({ ...R, mode: 2 })
    await until(() => feed.store.get(RELIANCE)?.ltp !== undefined, 2000, 'a Quote tick')
    expect(feed.store.get(RELIANCE)).toMatchObject({ source: 'ws' })
    expect(feed.realtime.isLive('NSE', 'RELIANCE')).toBe(true)
  })

  test.each(PROFILE_IDS)('%s: Depth 20 with maxDepth 20 confirms 20 levels', async (p) => {
    const { mock, feed } = await start({ PROFILE: p })
    await mock.control({ maxDepth: 20 })
    feed.realtime.start()
    feed.realtime.acquire({ ...R, mode: 3, depth: 20 })
    await until(() => feed.realtime.confirmedDepth('NSE', 'RELIANCE') !== undefined, 3000, 'depth')
    expect(feed.realtime.confirmedDepth('NSE', 'RELIANCE')).toBe(20)
    expect(feed.store.get(RELIANCE)?.depth?.levels).toBe(20)
  })

  test.each(PROFILE_IDS)(
    '%s: an ack that echoes 20 on a 5-level feed still confirms 5',
    async (p) => {
      const { mock, feed } = await start({ PROFILE: p })
      await mock.control({ maxDepth: 5, ackEchoesDepth: true })
      feed.realtime.start()
      feed.realtime.acquire({ ...R, mode: 3, depth: 20 })
      await until(
        () => feed.realtime.confirmedDepth('NSE', 'RELIANCE') !== undefined,
        3000,
        'depth',
      )
      expect(feed.realtime.confirmedDepth('NSE', 'RELIANCE')).toBe(5)
      expect(feed.store.get(RELIANCE)?.depth?.levels).toBe(5)
    },
  )

  test('2.0.2.0: a tick with close 0 keeps the seeded close', async () => {
    const { mock, feed } = await start({ PROFILE: '2.0.2.0' })
    await mock.control({ absentFields: ['close'] })
    feed.store.seed(RELIANCE, { close: 1400.5, ltp: 1401 }, Date.now() - 5000)
    feed.realtime.start()
    feed.realtime.acquire({ ...R, mode: 2 })
    await until(() => feed.store.get(RELIANCE)?.source === 'ws', 3000, 'a tick over the seed')
    expect(feed.store.get(RELIANCE)?.close).toBe(1400.5)
  })
})

describe('the auth deadline', () => {
  test('2.0.1.6: a late authenticate is closed 4401 and the client reconnects after 1 s', async () => {
    let sockets = 0
    // The first socket holds its authenticate back past the server's 500 ms grace.
    class SlowAuth extends WebSocket {
      private readonly slow = ++sockets === 1
      override send(data: never, ...rest: never[]) {
        if (!this.slow) return super.send(data, ...rest)
        setTimeout(() => {
          if (this.readyState === WebSocket.OPEN) super.send(data, ...rest)
        }, 600)
      }
    }
    const { feed } = await start(
      { PROFILE: '2.0.1.6', AUTH_GRACE_MS: '500' },
      { WebSocketImpl: SlowAuth as unknown as typeof NodeWebSocket },
    )
    const seen: { at: number; s: FeedStatus }[] = []
    feed.realtime.onStatus((s) => seen.push({ at: Date.now(), s }))
    feed.realtime.start()

    await until(() => feed.realtime.status().state === 'live', 6000, 'live after the reconnect')
    const failed = seen.find((x) => x.s.state === 'reconnecting')
    expect(failed?.s).toMatchObject({ failures: 1, lastCloseCode: 4401 })
    const retried = seen.find((x) => x.s.state === 'connecting' && failed && x.at > failed.at)
    expect((retried?.at ?? 0) - (failed?.at ?? 0)).toBeGreaterThanOrEqual(900)
    expect(feed.realtime.status().failures).toBe(0)
    expect((await mock?.stats())?.wsConnections).toBe(2)
  })
})

describe('order updates', () => {
  test.each(PROFILE_IDS)('%s: subscribe_orders behaves as the version defines', async (p) => {
    const { mock, feed } = await start({ PROFILE: p })
    feed.realtime.start()
    await until(() => feed.caps.ws().orderStream !== null, 5000, 'orderStream known')
    const has = p !== '2.0.0.0'
    expect(feed.caps.ws().orderStream).toBe(has)
    expect(feed.realtime.status().state).toBe('live')
    await mock.control({ emitOrderUpdate: true })
    await sleep(has ? 0 : 300)
    if (has) await until(() => feed.onOrderUpdate.mock.calls.length > 0, 2000, 'order_update')
    expect(feed.onOrderUpdate).toHaveBeenCalledTimes(has ? 1 : 0)
  })
})

describe('broker session changes', () => {
  test('2.0.3.5: a broker logout closes 1012, then on1012 and a reconnect', async () => {
    const { mock, feed } = await start({ PROFILE: '2.0.3.5' })
    feed.realtime.start()
    await until(() => feed.realtime.status().state === 'live', 3000, 'live')
    expect((await mock.stats()).wsConnections).toBe(1)

    await mock.control({ brokerLoggedOut: true })
    await until(() => feed.on1012.mock.calls.length > 0, 3000, 'on1012')
    expect(feed.realtime.status().lastCloseCode).toBe(1012)
    // 1012 reconnects at once, with no backoff: a second connection follows within a moment
    expect(feed.on1012).toHaveBeenCalledTimes(1)
    await sleep(500)
    expect((await mock.stats()).wsConnections).toBeGreaterThanOrEqual(2)
  })

  test('2.0.2.0: a silent feed during market hours reconnects once, then onSilence', async () => {
    const { mock, feed } = await start(
      { PROFILE: '2.0.2.0' },
      { config: { silenceMs: 1000, watchdogEveryMs: 250 } },
    )
    feed.realtime.start()
    feed.realtime.acquire({ ...R, mode: 2 })
    await until(() => feed.store.get(RELIANCE)?.source === 'ws', 3000, 'a first tick')
    expect((await mock.stats()).wsConnections).toBe(1)

    await mock.control({ silenceFeed: true })
    await until(() => feed.onSilence.mock.calls.length > 0, 8000, 'onSilence')
    // the first silence reconnected once; the second asked for the broker check
    expect((await mock.stats()).wsConnections).toBe(2)
    expect(feed.onSilence).toHaveBeenCalledTimes(1)
  })
})

describe('a wrong key', () => {
  test('is key_invalid on the feed and stops it', async () => {
    const { mock, feed } = await start({ PROFILE: '2.0.3.5' }, { key: WRONG_KEY })
    expect(WRONG_KEY).not.toBe(KEY)
    feed.realtime.start()
    await until(() => feed.realtime.status().state === 'key_invalid', 3000, 'key_invalid')
    expect(feed.onKeyInvalid).toHaveBeenCalledTimes(1)
    await sleep(1500)
    expect((await mock.stats()).wsAuthAttempts).toBe(1)
  })
})
