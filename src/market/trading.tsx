// The trading layer's container: shared logic built from the services, given to hooks through
// context. Later tasks add fields. It imports no feature.
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { istDate } from '~/core/realtime/marketHours'
import { useConnection } from '~/core/services/connection'
import { type Services, useServices } from '~/core/services/services'
import { createEventWatch, type EventWatch } from './books/eventWatch'
import { createGttApi, type GttApi, type GttSeen } from './gtt/api'
import { gttFeatureKey } from './gtt/support'
import { createInstrumentCache, type InstrumentCache, UNKNOWN_TTL_MS } from './instruments/cache'
import { type AnalyzerGate, createAnalyzerGate } from './orders/analyzerGate'
import { createOrderApi, type OrderApi } from './orders/api'
import { currentBroker } from './session'
import type { Watchlists } from './watchlists/model'
import { createWatchlistsStore, type WatchlistsStore } from './watchlists/store'

/**
 * How long a refusal stands: the server's "not found" is not only an expired contract. At the
 * first broker login of the day the stock server deletes its symbol table and fills it again
 * (e.g. broker/zerodha/database/master_contract_db.py), and meanwhile it refuses every symbol
 * ("...ensure master contracts are downloaded", quotes_service.py). So a refusal is asked again
 * after `UNKNOWN_TTL_MS`, and one that lands within `TENTATIVE_WINDOW_MS` of the broker session
 * turning active, while that reload may be running, after `TENTATIVE_TTL_MS`.
 */
export { UNKNOWN_TTL_MS }
export const TENTATIVE_WINDOW_MS = 2 * 60_000
export const TENTATIVE_TTL_MS = 2 * 60_000

/**
 * Quote keys (`EX:SYM`) the server refused this session: a multiquotes entry carrying the
 * server's own validation refusal, or a 400's `invalid_symbols` (ruling 8). Such keys take no
 * feed slot and no poll. A key is forgotten once its refusal is old (`UNKNOWN_TTL_MS`), and the
 * whole set when the broker session turns active (the server may have downloaded its master
 * contracts since) and on a new IST day.
 */
export type UnknownKeys = StoreApi<{
  keys: ReadonlySet<string>
  /**
   * Moves on at every clear, and when old refusals are forgotten, so the seed asks again for
   * the keys it skipped, and a reply sent before it cannot bring its refusals back.
   */
  epoch: number
  /** `tentative`: the refusal may be the server's symbol-table reload, so it stands briefly. */
  add(keys: readonly string[], o?: { tentative?: boolean }): void
  /** Forgets every key. */
  clear(): void
  /** The broker session turned active: forgets every key, and refusals that follow soon are tentative. */
  activated(): void
  /**
   * Forgets the refusals whose time is up, and the whole set once the IST day has changed; true
   * when that forgot keys.
   */
  rollover(): boolean
}>

function createUnknownKeys(now: () => number): UnknownKeys {
  let day = istDate(now())
  let activatedAt = Number.NEGATIVE_INFINITY
  /** When each key's refusal is up. */
  const until = new Map<string, number>()
  return createStore((set, get) => ({
    keys: new Set<string>(),
    epoch: 0,
    add(keys, o = {}) {
      const fresh = keys.filter((k) => !get().keys.has(k))
      if (!fresh.length) return
      const t = now()
      const ttl =
        o.tentative || t - activatedAt < TENTATIVE_WINDOW_MS ? TENTATIVE_TTL_MS : UNKNOWN_TTL_MS
      for (const k of fresh) until.set(k, t + ttl)
      set({ keys: new Set([...get().keys, ...fresh]) })
    },
    clear() {
      until.clear()
      set({ keys: new Set<string>(), epoch: get().epoch + 1 })
    },
    activated() {
      activatedAt = now()
      get().clear()
    },
    rollover() {
      const t = now()
      const today = istDate(t)
      if (today !== day) {
        day = today
        const had = get().keys.size > 0
        get().clear()
        return had
      }
      const up = [...get().keys].filter((k) => (until.get(k) ?? 0) <= t)
      if (!up.length) return false
      for (const k of up) until.delete(k)
      set({
        keys: new Set([...get().keys].filter((k) => !up.includes(k))),
        epoch: get().epoch + 1,
      })
      return true
    },
  }))
}

/** How often old refusals are looked for while the app runs. */
const EXPIRE_EVERY_MS = 60_000

/**
 * Clears `unknown` and the instrument cache's unknown marks when the broker session turns active,
 * and forgets old refusals at each foreground and every minute.
 */
function forgetRefusals(unknown: UnknownKeys, instruments: InstrumentCache): () => void {
  const offConn = useConnection.subscribe((st, prev) => {
    if (st.brokerSession === 'active' && prev.brokerSession !== 'active') {
      unknown.getState().activated()
      instruments.forgetUnknown()
    }
  })
  const app = AppState.addEventListener('change', (st) => {
    if (st === 'active') unknown.getState().rollover()
  })
  const timer = setInterval(() => unknown.getState().rollover(), EXPIRE_EVERY_MS)
  return () => {
    offConn()
    app.remove()
    clearInterval(timer)
  }
}

/**
 * The `broker:exchange` pairs (`downgradeKey`) whose deeper depth levels the feed did not deliver
 * (ruling 10); they show 5 levels for the rest of the session. A session is one services
 * container, so sign-out and a server change, which both build a new one, forget them.
 */
export type DepthDowngrades = StoreApi<{
  keys: ReadonlySet<string>
  add(key: string): void
}>

function createDepthDowngrades(): DepthDowngrades {
  return createStore((set, get) => ({
    keys: new Set<string>(),
    add(key) {
      if (!get().keys.has(key)) set({ keys: new Set([...get().keys, key]) })
    },
  }))
}

export type Trading = {
  instruments: InstrumentCache
  watchlists: WatchlistsStore
  unknown: UnknownKeys
  depthDowngrades: DepthDowngrades
  /** Every order write and book read. */
  orders: OrderApi
  /** Every GTT write and GTT book read; each reply records what it shows about GTT support. */
  gtt: GttApi
  /** The analyzer mode each order write is checked against, on useAnalyzer's query. */
  analyzer: AnalyzerGate
  /** Whether the app's own orders produce order events; the bus feeds it (RF 3). */
  eventWatch: EventWatch
  /**
   * What the session has learned about the server. `marginOff`: margin answered 501 (or is
   * missing), so the ticket's margin preview is hidden until the next session (design 7.10).
   */
  flags: { marginOff: boolean }
}

/**
 * Where a GTT reply's evidence of support goes: into the caps, under the server's broker at the
 * moment of the reply (`currentBroker`) and the reply's own mode; nowhere while no broker is
 * named.
 */
function gttSeen(s: Pick<Services, 'caps' | 'realtime' | 'profile'>): GttSeen {
  return {
    record(ok, mode) {
      const broker = currentBroker(s)
      if (broker) s.caps.setFeature(gttFeatureKey(broker, mode), ok)
    },
  }
}

export function createTrading(
  s: Pick<Services, 'api' | 'storage' | 'queryClient' | 'profile' | 'caps' | 'realtime'>,
  o: { now: () => number },
): Trading {
  return {
    instruments: createInstrumentCache({ api: s.api, storage: s.storage, now: o.now }),
    watchlists: createWatchlistsStore(s.storage),
    unknown: createUnknownKeys(o.now),
    depthDowngrades: createDepthDowngrades(),
    orders: createOrderApi(s.api),
    gtt: createGttApi(s.api, gttSeen(s)),
    analyzer: createAnalyzerGate({
      queryClient: s.queryClient,
      pid: s.profile.get().id,
      api: s.api,
    }),
    eventWatch: createEventWatch({ now: o.now }),
    flags: { marginOff: false },
  }
}

/** Every order event counts as seen; unsubscribing also drops the waits still running. */
function watchOrderEvents(s: Pick<Services, 'orderEvents'>, watch: EventWatch): () => void {
  const off = s.orderEvents.subscribe((u) => watch.seen(u.orderid))
  return () => {
    off()
    watch.reset()
  }
}

const TradingContext = createContext<Trading | null>(null)

/** Inside `ServicesProvider`: one `Trading` per services container. */
export function TradingProvider({
  now = Date.now,
  children,
}: {
  now?: () => number
  children: ReactNode
}) {
  const s = useServices()
  const trading = useMemo(() => createTrading(s, { now }), [s, now])
  useEffect(() => forgetRefusals(trading.unknown, trading.instruments), [trading])
  useEffect(() => watchOrderEvents(s, trading.eventWatch), [s, trading])
  return <TradingContext.Provider value={trading}>{children}</TradingContext.Provider>
}

export function useTrading(): Trading {
  const t = useContext(TradingContext)
  if (!t) throw new Error('TradingProvider is missing')
  return t
}

/** Reads the device-local watchlists; `useTrading().watchlists` is the store for `load` and `apply`. */
export function useWatchlists<T>(select: (w: Watchlists) => T): T {
  return useStore(useTrading().watchlists, (st) => select(st.data))
}
