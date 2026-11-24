// Builds the app's layers over the mock server with Node's fetch and `ws`, for the compat suite.
import { WebSocket } from 'ws'
import type { Capabilities } from '~/core/capabilities/gates'
import { createCapabilityStore } from '~/core/capabilities/store'
import type { ServerProfile } from '~/core/config/profile'
import { profileStorage } from '~/core/config/storage'
import { createTickStore } from '~/core/realtime/tickStore'
import {
  createRealtime,
  type RealtimeConfig,
  type RealtimeDeps,
  type WebSocketCtor,
} from '~/core/realtime/wsClient'
import {
  type AppDeps,
  createServices,
  disposeServices,
  type Services,
} from '~/core/services/services'
import { serverStep } from '~/features/onboarding/flow'
import { memoryKV } from './memoryKV'
import type { MockServerProcess } from './mockServer'

export const KEY = 'ab'.repeat(32)
export const WRONG_KEY = 'cd'.repeat(32)
export const PROFILE_IDS = ['2.0.0.0', '2.0.1.6', '2.0.2.0', '2.0.3.5'] as const
const PID = 'p0123456789ab'

/** `ws`'s WebSocket, typed as the client's constructor. */
export const NodeWebSocket = WebSocket as unknown as WebSocketCtor

/** Polls `cond` every 25 ms until it holds; rejects after `ms`. */
export async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** The caps a real probe of the mock gives. */
export async function probeCaps(mock: MockServerProcess): Promise<Capabilities> {
  const r = await serverStep(mock.origin, { fetch, allowDevHosts: true, now: Date.now })
  if (r.kind !== 'ok') throw new Error(`serverStep gave ${r.kind}`)
  return r.caps
}

/** The requests that went to /api/v1 endpoints: not the public GETs (app-info, swagger.json). */
export const apiCalls = (requests: Record<string, number>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(requests).filter(([k]) => !k.startsWith('/') && k !== 'swagger.json'),
  )

export type FeedOptions = {
  key?: string
  wsUrl?: string | null
  WebSocketImpl?: WebSocketCtor
  config?: Partial<RealtimeConfig>
  isExchangeOpen?: () => boolean
}

/** The live feed on its own: a real tick store and capability store, spy callbacks. */
export async function makeFeed(mock: MockServerProcess, o: FeedOptions = {}) {
  const caps = createCapabilityStore(profileStorage(memoryKV(), PID))
  await caps.save(await probeCaps(mock))
  const store = createTickStore((flush) => void setTimeout(flush, 16))
  const spies = {
    onBrokerError: jest.fn(async () => 'unknown' as const),
    onKeyInvalid: jest.fn(),
    on1012: jest.fn(),
    onSilence: jest.fn(),
    onOrderUpdate: jest.fn(),
    onResync: jest.fn(),
    onPollingRetry: jest.fn(),
  }
  const wsUrl = o.wsUrl === undefined ? mock.wsUrl : o.wsUrl
  const deps: RealtimeDeps = {
    url: () => wsUrl,
    feedMode: () => 'live',
    getKey: () => o.key ?? KEY,
    WebSocketImpl: o.WebSocketImpl ?? NodeWebSocket,
    lastFeedRetryAt: () => null,
    store,
    caps,
    isExchangeOpen: o.isExchangeOpen ?? (() => true),
    ...spies,
    ...(o.config ? { config: o.config } : {}),
  }
  const realtime = createRealtime(deps)
  return { realtime, store, caps, ...spies }
}

export type App = Services & { dispose(): void; fetchCalls(): number }

export type AppOptions = {
  key?: string
  /** Null runs the profile in polling mode. */
  wsUrl?: string | null
  now?: () => number
}

/** The services container over the mock, unlocked: cold start, key in memory, feed started. */
export async function makeApp(mock: MockServerProcess, o: AppOptions = {}): Promise<App> {
  const caps = await probeCaps(mock)
  const wsUrl = o.wsUrl === undefined ? mock.wsUrl : o.wsUrl
  const profile: ServerProfile = {
    id: PID,
    restOrigin: mock.origin,
    wsUrl,
    feedMode: wsUrl ? 'live' : 'polling',
    httpWarningAcked: false,
    serverVersion: caps.version,
    broker: null,
    createdAt: Date.now(),
    lastFeedRetryAt: null,
  }
  const kv = memoryKV({
    'oa.profiles.v1': JSON.stringify({ activeId: PID, profiles: [profile] }),
    [`oa.${PID}.hasKey`]: '1',
    [`oa.${PID}.caps`]: JSON.stringify(caps),
  })
  const secureKV = memoryKV({ [`oa.${PID}.apikey`]: o.key ?? KEY })
  let fetches = 0
  const deps: AppDeps = {
    fetch: (input, init) => {
      fetches++
      return fetch(input, init)
    },
    WebSocketImpl: NodeWebSocket,
    secureKV,
    kv,
    now: o.now ?? (() => Date.now()),
    uuid: () => '00000000-0000-4000-8000-000000000000',
    allowDevHosts: true,
    lock: {
      settings: () => ({ enabled: false, lockAfterMs: 300_000 }),
      authenticate: async () => true,
      available: async () => true,
    },
  }
  const s = createServices(profile, deps)
  await s.lifecycle.coldStart()
  await s.lock.unlock()
  return Object.assign(s, { dispose: () => disposeServices(s), fetchCalls: () => fetches })
}
