// The services container (design 7.4): one per server profile, built when the app group mounts
// and disposed when it unmounts. It owns the wiring between the layers: bans and a bad key stop
// all traffic, lock and unlock start and stop the feed, and the feed reports to the connection
// store. It imports no native module, so the compat suite builds it with Node's fetch and `ws`.
import { onlineManager, type QueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'
import { create } from 'zustand'
import { probeServer, readAppVersion } from '~/core/capabilities/probe'
import { type CapabilityStore, createCapabilityStore } from '~/core/capabilities/store'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { type KV, type ProfileStorage, profileStorage } from '~/core/config/storage'
import { pollNetwork } from '~/core/config/urlRules'
import { createKeyStore, type SecureKV } from '~/core/credentials/keyStore'
import {
  type AppStateName,
  createLockController,
  type LockController,
  type LockDeps,
  type PromptResult,
} from '~/core/credentials/lock'
import { type BrokerStatus, createBrokerStatus } from '~/core/credentials/status'
import { createKeyVault, type KeyVault } from '~/core/credentials/vault'
import { type Api, createApi, type FieldGate } from '~/core/http/api'
import { createHttpClient, type HttpClient } from '~/core/http/client'
import { ApiError, userMessage } from '~/core/http/errors'
import { createScheduler, type Scheduler } from '~/core/http/scheduler'
import { log } from '~/core/log/logger'
import {
  type BookInvalidator,
  createBookInvalidator,
  resetBooksOnModeChange,
} from '~/core/query/invalidate'
import { qk } from '~/core/query/keys'
import { createQueryClient } from '~/core/query/queryClient'
import { isExchangeOpen } from '~/core/realtime/marketHours'
import { createOrderEventBus, type OrderEventBus } from '~/core/realtime/orderEvents'
import { createPollingEngine, type PollingEngine } from '~/core/realtime/polling'
import { pricesStale } from '~/core/realtime/staleness'
import { createTickStore, type TickStore } from '~/core/realtime/tickStore'
import { createRealtime, type Realtime, type WebSocketCtor } from '~/core/realtime/wsClient'
import {
  CONNECTION_DEFAULTS,
  type ConnectionState,
  markSemiAuto,
  transportOf,
  useConnection,
} from './connection'

const TAG = 'services'

/** Everything the app takes from the platform. `defaultDeps` (deps.ts) binds the native ones. */
export type AppDeps = {
  fetch: typeof fetch
  WebSocketImpl: WebSocketCtor
  secureKV: SecureKV
  kv: KV
  now: () => number
  uuid: () => string
  allowDevHosts: boolean
  /** The app lock's prompt, device check, settings and clock (ruling 6: the lock lives in Services). */
  lock: Pick<LockDeps, 'settings' | 'authenticate' | 'available' | 'monotonicNow'> & {
    /** The live-write prompt (ruling 5), titled with what it confirms. */
    confirm: (promptMessage: string) => Promise<PromptResult>
  }
}

/** The active profile in memory (ruling 26); `update` applies at once and stores after. */
export type ProfileHandle = {
  get(): ServerProfile
  update(patch: Partial<Omit<ServerProfile, 'id'>>): Promise<void>
}

export type Lifecycle = {
  /** On mount: the stored caps, then the app-info check and a re-probe when needed. Keyless. */
  coldStart(): Promise<void>
  /** An AppState change, for the lock, the feed, polling and the scheduler. */
  appState(next: AppStateName): Promise<void>
  /**
   * The banned banner's "Try again": unhalt, re-probe, then restart the feed. When the ban has
   * lifted it also checks the broker and refetches this profile's queries.
   */
  retryAfterBan(): Promise<void>
  /** The lock overlay's way out when the stored key cannot be read; see `forgetStoredKey`. */
  forgetKey(): Promise<void>
}

export type Services = {
  profile: ProfileHandle
  vault: KeyVault
  lock: LockController
  http: HttpClient
  scheduler: Scheduler
  api: Api
  caps: CapabilityStore & FieldGate
  broker: BrokerStatus
  realtime: Realtime
  polling: PollingEngine
  store: TickStore
  storage: ProfileStorage
  queryClient: QueryClient
  books: BookInvalidator
  /** Every `order_update` the feed delivers, once each (design 7.6); each one refreshes the books. */
  orderEvents: OrderEventBus
  lifecycle: Lifecycle
}

type SessionStatus = 'loading' | 'onboarding' | 'ready'
type SessionState = {
  status: SessionStatus
  profileId: string | null
  set: (patch: Partial<Pick<SessionState, 'status' | 'profileId'>>) => void
}

/** Which group the root stack shows. Never holds the key. */
export const useSession = create<SessionState>()((set) => ({
  status: 'loading',
  profileId: null,
  set: (patch) => set(patch),
}))

/**
 * `ready` when a profile exists and its key marker is set, else `onboarding`. It reads only the
 * marker: the key itself is read by `vault.unlock()`, after the lock.
 */
export async function bootSession(d: Pick<AppDeps, 'kv' | 'secureKV'>): Promise<void> {
  let profile: ServerProfile | null = null
  let ready = false
  try {
    profile = await createProfileRepo(d.kv).load()
    ready = profile !== null && (await createKeyStore(d.secureKV, d.kv, profile.id).hasKey())
  } catch (e) {
    log.warn(TAG, 'could not read the saved profile', e)
  }
  useSession
    .getState()
    .set({ status: ready ? 'ready' : 'onboarding', profileId: profile?.id ?? null })
}

/**
 * The way out when the stored key cannot be used: deletes the key and its marker, each whether
 * or not the other delete works (a broken keystore must not keep the marker, or every start
 * would come back to the lock), then goes to onboarding. Never rejects.
 */
export async function forgetStoredKey(
  d: Pick<AppDeps, 'kv' | 'secureKV'>,
  pid: string,
): Promise<void> {
  try {
    await createKeyStore(d.secureKV, d.kv, pid).forget()
  } catch (e) {
    log.warn(TAG, 'could not delete the stored key', e)
  }
  useSession.getState().set({ status: 'onboarding' })
}

function createProfileHandle(kv: KV, initial: ServerProfile): ProfileHandle {
  const repo = createProfileRepo(kv)
  let current = initial
  // Writes land in the order they were made.
  let writes: Promise<unknown> = Promise.resolve()
  return {
    get: () => current,
    update(patch) {
      current = { ...current, ...patch, id: current.id }
      const done = writes.then(() => repo.update(patch))
      writes = done.catch((e) => log.warn(TAG, 'could not store the profile', e))
      return writes.then(() => {})
    },
  }
}

const KEY_INVALID = () => new ApiError({ kind: 'KeyInvalid', status: 403, endpoint: 'search' })

/** How long a REST outcome says whether the server can be reached (the reconnects take ~3 min). */
const REST_EVIDENCE_MS = 300_000

/** A request that got no reply: a dropped connection or a timeout, not a refusal. */
const noReply = (e: unknown) =>
  e instanceof ApiError && e.status === 0 && (e.kind === 'Network' || e.kind === 'MaybePlaced')

// Node (the compat suite) has no requestAnimationFrame; the store then flushes on a timer.
const tickSchedule =
  typeof requestAnimationFrame === 'function'
    ? undefined
    : (flush: () => void) => void setTimeout(flush, 16)

/** Unsubscribes a container's listeners; see `disposeServices`. */
const disposers = new WeakMap<Services, () => void>()

export function createServices(initial: ServerProfile, deps: AppDeps): Services {
  const conn = useConnection
  const profile = createProfileHandle(deps.kv, initial)
  const pid = initial.id
  const storage = profileStorage(deps.kv, pid)
  const keyStore = createKeyStore(deps.secureKV, deps.kv, pid)
  const keys = createKeyVault(keyStore)
  const lock = createLockController({ ...deps.lock, now: deps.now, vault: keys })
  const caps = createCapabilityStore(storage)
  const scheduler = createScheduler({ now: deps.now })
  const store = createTickStore(tickSchedule)
  const queryClient = createQueryClient()
  const books = createBookInvalidator(queryClient, pid)
  const orderEvents = createOrderEventBus()

  let appActive = true
  let probing: Promise<void> | null = null
  /** The last REST exchange: whether the server replied (with anything) or not. */
  let rest: { at: number; replied: boolean } | null = null
  const noteRest = (replied: boolean) => {
    rest = { at: deps.now(), replied }
  }

  /** Neither a ban nor a bad key has stopped all traffic. */
  const talking = () => {
    const c = conn.getState()
    return c.banned === null && c.keyState !== 'invalid'
  }
  const syncPause = () => (appActive && !lock.isLocked() ? scheduler.resume() : scheduler.pause())
  /** Ruling 7: price polls stop in the background and while the broker is logged out. */
  const syncPolling = () =>
    polling.setAppActive(appActive && conn.getState().brokerSession !== 'logged_out')
  const startFeed = () => {
    if (!lock.isLocked() && talking()) realtime.start()
  }

  /** Design 7.5: a ban stops all traffic to the server until "Try again". */
  function guard(e: unknown): never {
    if (e instanceof ApiError && e.kind === 'IpBanned') {
      scheduler.halt(e)
      realtime.stop()
      conn.getState().set({ banned: e.banForm ?? 'text' })
    }
    throw e
  }

  const raw = createHttpClient({
    origin: initial.restOrigin,
    getKey: () => keys.get(),
    fetch: deps.fetch,
    resolveAuth403: () => broker.resolveAuth403(),
    onResponse: (_id, res) => {
      noteRest(true)
      markSemiAuto(res.json)
    },
  })
  const http: HttpClient = {
    request: (id, body, schema, o) =>
      raw.request(id, body, schema, o).catch((e: unknown) => {
        // A caller's abort says nothing about the server.
        if (noReply(e) && !o?.signal?.aborted) noteRest(false)
        return guard(e)
      }),
    getPublic: (path) =>
      raw.getPublic(path).then(
        (r) => {
          noteRest(true)
          return r
        },
        (e: unknown) => {
          if (noReply(e)) noteRest(false)
          return guard(e)
        },
      ),
    probe: (id) => raw.probe(id).catch(guard),
  }
  const api = createApi({ http, scheduler, fields: caps })
  const broker = createBrokerStatus({ api, http, conn, now: deps.now })

  /** The broker's name while one ping for it is out. */
  let naming: Promise<void> | null = null
  /**
   * Ruling 11's residue: the feed's auth reply names the broker, and else only onboarding's ping,
   * which needs a logged-in broker (c8b2896 services/ping_service.py:47-50 answers 403 otherwise).
   * A profile onboarded while the broker was logged out and run in polling mode (a v0.1.0 one
   * too) would never learn it, and GTT would stay "the broker is not known yet". So when the
   * broker session turns active with no broker named, one ping names it (the connection's, at
   * once), and the profile keeps it, as onboarding would have. A failed ping waits for the next
   * time the session turns active.
   */
  function learnBroker(): void {
    if (naming || realtime.status().broker || conn.getState().broker || profile.get().broker) {
      return
    }
    naming = broker
      .fetchBrokerName()
      .then(async (name) => {
        if (name && profile.get().broker === null) await profile.update({ broker: name })
      })
      .finally(() => {
        naming = null
      })
  }

  /** One probe at a time; a probe that does not come back ok keeps the caps there are. */
  function reprobe(): Promise<void> {
    probing ??= (async () => {
      const out = await probeServer({ http, host: profile.get().restOrigin, now: deps.now() })
      if (out.kind !== 'ok') {
        log.warn(TAG, `re-probe: ${out.kind}`)
        return
      }
      await caps.save(out.caps)
      if (out.caps.version !== profile.get().serverVersion) {
        await profile.update({ serverVersion: out.caps.version })
      }
    })()
      .catch((e) => log.warn(TAG, 're-probe failed', e))
      .finally(() => {
        probing = null
      })
    return probing
  }

  const realtime: Realtime = createRealtime({
    url: () => profile.get().wsUrl,
    feedMode: () => profile.get().feedMode,
    getKey: () => keys.get(),
    WebSocketImpl: deps.WebSocketImpl,
    lastFeedRetryAt: () => profile.get().lastFeedRetryAt,
    store,
    caps,
    isExchangeOpen,
    onBrokerError: () => broker.check(),
    onKeyInvalid: () => {
      broker.resolveAuth403().catch((e) => log.warn(TAG, 'key check failed', e))
    },
    on1012: () => {
      void reprobe().then(() => (talking() ? broker.check() : undefined))
    },
    onSilence: () => void broker.check(),
    // Ruling 13: the books refresh from the bus (below), so any emit on it refreshes them.
    onOrderUpdate: (u) => orderEvents.emit(u),
    onResync: () => books.poke(),
    // Ruling 7: the in-memory profile reads the new mode at once.
    onPollingRetry: (ok) =>
      void profile.update({ lastFeedRetryAt: deps.now(), feedMode: ok ? 'live' : 'polling' }),
    isOnline: () => onlineManager.isOnline(),
    serverReachable: () => (rest && deps.now() - rest.at < REST_EVIDENCE_MS ? rest.replied : null),
    now: deps.now,
  })

  const polling = createPollingEngine({
    api,
    store,
    isLive: (ex, sym) => realtime.isLive(ex, sym),
    // A quote-only subscription carries no book: depth counts once the socket delivers it.
    isDepthLive: (ex, sym) =>
      realtime.isLive(ex, sym) && realtime.confirmedDepth(ex, sym) !== undefined,
    network: () => pollNetwork(profile.get().restOrigin),
    now: deps.now,
    isExchangeOpen,
  })

  /** B11: stale styling follows the feed, the broker session and how polling is doing. */
  const syncStale = () =>
    store.setStale(
      pricesStale(realtime.status().state, conn.getState().brokerSession, polling.health()),
    )

  /** Ruling 5: the key is in memory again, so everything that needs it starts. */
  function onUnlocked() {
    syncPause()
    if (!talking()) return
    void broker.check()
    realtime.start()
    // re-read the foreground so the 10-minute live-feed retry (B8) runs after an unlock
    realtime.setAppState(appActive ? 'active' : 'background')
    books.poke()
  }

  conn.getState().set({
    ...CONNECTION_DEFAULTS,
    semiAutoSeen: conn.getState().semiAutoSeen,
    transport: transportOf(initial.restOrigin),
    feed: realtime.status().state,
  })
  const unsubs = [
    orderEvents.subscribe(() => books.poke()),
    resetBooksOnModeChange(queryClient, pid),
    realtime.onStatus((st) => {
      conn.getState().set({ feed: st.state })
      syncStale()
    }),
    polling.onHealth(syncStale),
    conn.subscribe((st, prev) => {
      if (st.brokerSession !== prev.brokerSession) {
        syncStale()
        syncPolling()
      }
      if (st.keyState === 'invalid' && prev.keyState !== 'invalid') {
        scheduler.halt(KEY_INVALID())
        realtime.stop()
      }
      if (st.brokerSession === 'active' && prev.brokerSession !== 'active') {
        startFeed()
        learnBroker()
      }
    }),
    onlineManager.subscribe((online) => {
      if (online) realtime.networkBack()
    }),
    lock.subscribe((st) => {
      if (st === 'unlocked') onUnlocked()
      else if (st === 'locked') {
        realtime.stop()
        syncPause()
      } else useSession.getState().set({ status: 'onboarding' })
    }),
  ]
  syncPause()
  syncStale()

  const lifecycle: Lifecycle = {
    async coldStart() {
      let version: string | null
      try {
        await caps.load()
        if (!talking()) return
        version = await readAppVersion(http)
      } catch (e) {
        // unreachable: the next foreground checks again; banned: `guard` has stopped everything
        log.warn(TAG, 'cold-start version check failed', e)
        return
      }
      if (caps.needsReprobe({ now: deps.now(), host: profile.get().restOrigin, version })) {
        await reprobe()
      }
    },

    async appState(next) {
      lock.handleAppState(next)
      if (next !== 'active' && next !== 'background') return
      appActive = next === 'active'
      syncPause()
      realtime.setAppState(next)
      syncPolling()
      // Ruling 6: no traffic at all while banned or with a bad key.
      if (!appActive || !talking()) return
      // The re-probe is keyless, so it runs even when this resume has just locked the app: after
      // a day away it always has (lockAfterMs is at most 15 min), and an unlock never re-probes.
      const version = caps.get()?.version ?? null
      if (caps.needsReprobe({ now: deps.now(), host: profile.get().restOrigin, version })) {
        await reprobe()
      }
      // The broker check needs the key; while locked, the unlock runs it (onUnlocked).
      if (!lock.isLocked() && talking()) await broker.check()
    },

    async retryAfterBan() {
      conn.getState().set({ banned: null })
      if (conn.getState().keyState !== 'invalid') scheduler.unhalt()
      await reprobe()
      // The probe hit the ban again (`guard` has re-halted) or the key is bad: send nothing more.
      if (!talking()) return
      startFeed()
      // The broker check needs the key; while locked, the unlock runs it (onUnlocked).
      if (lock.isLocked()) return
      await broker.check()
      // What failed during the ban is stale: refetch this profile's queries.
      if (talking()) void queryClient.invalidateQueries({ queryKey: qk.root(pid) })
    },

    async forgetKey() {
      keys.lock()
      await forgetStoredKey(deps, pid)
    },
  }

  const vault: KeyVault = {
    ...keys,
    /**
     * The wiring row for a new key: forget the old split, then let traffic go again. As after a
     * ban, what failed with the old key is stale: the broker is checked and this profile's
     * queries (the analyzer badge among them) are fetched again.
     */
    async replace(next) {
      await keys.replace(next)
      broker.reset()
      conn.getState().set({ keyState: 'ok' })
      if (conn.getState().banned === null) scheduler.unhalt()
      startFeed()
      if (!talking() || lock.isLocked()) return
      void broker.check()
      void queryClient.invalidateQueries({ queryKey: qk.root(pid) })
    },
  }

  const s: Services = {
    profile,
    vault,
    lock,
    http,
    scheduler,
    api,
    caps,
    broker,
    realtime,
    polling,
    store,
    storage,
    queryClient,
    books,
    orderEvents,
    lifecycle,
  }
  disposers.set(s, () => {
    for (const off of unsubs.splice(0)) off()
  })
  return s
}

/** Stops the feed and every request, then drops the ticks, the queries and the key. */
export function disposeServices(s: Services): void {
  disposers.get(s)?.()
  s.books.dispose()
  s.polling.setAppActive(false)
  s.realtime.stop()
  s.scheduler.halt(new Error('These services were disposed'))
  s.store.reset()
  s.queryClient.clear()
  s.vault.lock()
}

const ServicesContext = createContext<Services | null>(null)

export function ServicesProvider({ value, children }: { value: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>
}

export function useServices(): Services {
  const s = useContext(ServicesContext)
  if (!s) throw new Error('ServicesProvider is missing')
  return s
}

export type ShellBanner = {
  testID: 'banner-banned' | 'banner-key' | 'banner-polling'
  tone: 'danger' | 'warning'
  text: string
  action: { label: string; onPress: () => void }
}

/** How a banner leaves the shell: a route in the app. */
export type ShellNav = {
  go: (href: '/help' | '/account/key') => void
}

export const POLLING_BANNER = 'Live feed unavailable: prices refresh every few seconds'

const copyOf = (kind: 'IpBanned' | 'KeyInvalid') =>
  userMessage(new ApiError({ kind, status: 0, endpoint: 'app' }))

/**
 * The banners the connection state calls for, most serious first. None can be dismissed. A
 * logged-out broker has its own banner, market's `BrokerBanner` (ruling 9).
 */
export function shellBanners(
  c: ConnectionState,
  s: Pick<Services, 'lifecycle'>,
  nav: ShellNav,
): ShellBanner[] {
  const out: ShellBanner[] = []
  if (c.banned !== null) {
    out.push({
      testID: 'banner-banned',
      tone: 'danger',
      text: copyOf('IpBanned'),
      action: { label: 'Try again', onPress: () => void s.lifecycle.retryAfterBan() },
    })
  }
  if (c.keyState === 'invalid') {
    out.push({
      testID: 'banner-key',
      tone: 'danger',
      text: copyOf('KeyInvalid'),
      action: { label: 'Enter key', onPress: () => nav.go('/account/key') },
    })
  }
  if (c.feed === 'polling') {
    out.push({
      testID: 'banner-polling',
      tone: 'warning',
      text: POLLING_BANNER,
      action: { label: 'Setup help', onPress: () => nav.go('/help') },
    })
  }
  return out
}
