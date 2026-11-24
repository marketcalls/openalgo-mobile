// Onboarding's steps (flow.ts) against the stock-server mock, with Node fetch and ws.
import { WebSocket } from 'ws'
import { feedStep, keyStep, saveOnboarding, serverStep } from '~/features/onboarding/flow'
import { memoryKV } from '../helpers/memoryKV'
import { type MockServerProcess, startMockServerProcess } from '../helpers/mockServer'

const KEY = 'ab'.repeat(32)
const UUID = '0123abcd-4567-4890-a123-456789abcdef'
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const PROFILES = ['2.0.0.0', '2.0.1.6', '2.0.2.0', '2.0.3.5']

let mock: MockServerProcess | null = null
afterEach(async () => {
  await mock?.stop()
  mock = null
})

describe('the broker logged out', () => {
  // A BROKER_ERROR on authenticate proves the socket reaches OpenAlgo: the feed is saved live,
  // and goes live once the user logs in to the broker (Task 19 follow-up ruling).
  test.each(PROFILES)('%s: the feed test is live with broker_logged_out, saved live', async (p) => {
    mock = await startMockServerProcess({ PROFILE: p })
    await mock.control({ brokerLoggedOut: true })
    const wsUrl = mock.wsUrl
    if (!wsUrl) throw new Error('the mock runs no WS proxy')
    const now = () => T0

    const server = await serverStep(mock.origin, { fetch, allowDevHosts: true, now })
    if (server.kind !== 'ok') throw new Error(`serverStep gave ${server.kind}`)
    const key = await keyStep(server.url, KEY, { fetch })
    expect(key).toEqual({ kind: 'ok', key: KEY, brokerSession: 'logged_out', broker: null })

    const feed = await feedStep(wsUrl, KEY, { WebSocketImpl: WebSocket })
    expect(feed).toEqual({ mode: 'live', broker: null, reason: 'broker_logged_out' })
    // One handshake: a broker error is not retried.
    expect((await mock.stats()).wsAuthAttempts).toBe(1)

    const kv = memoryKV()
    const secureKV = memoryKV()
    const profile = await saveOnboarding(
      {
        url: server.url,
        caps: server.caps,
        key: KEY,
        broker: null,
        wsUrl,
        feedMode: feed.mode,
        httpWarningAcked: false,
      },
      { kv, secureKV, uuid: () => UUID, now },
    )
    expect(profile).toMatchObject({ restOrigin: mock.origin, wsUrl, feedMode: 'live' })
    const { profiles } = JSON.parse(kv.data.get('oa.profiles.v1') ?? '{}')
    expect(profiles[0]).toMatchObject({ feedMode: 'live', lastFeedRetryAt: null })
    expect(secureKV.data.get(`oa.${profile.id}.apikey`)).toBe(KEY)
  })
})
