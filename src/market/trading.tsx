// The trading layer's container: shared logic built from the services, given to hooks through
// context. Later tasks add fields. It imports no feature.
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { istDate } from '~/core/realtime/marketHours'
import { useConnection } from '~/core/services/connection'
import { type Services, useServices } from '~/core/services/services'
import { createInstrumentCache, type InstrumentCache } from './instruments/cache'
import { type AnalyzerGate, createAnalyzerGate } from './orders/analyzerGate'
import { createOrderApi, type OrderApi } from './orders/api'
import type { Watchlists } from './watchlists/model'
import { createWatchlistsStore, type WatchlistsStore } from './watchlists/store'

/**
 * Quote keys (`EX:SYM`) the server refused this session: a multiquotes entry carrying the
 * server's own validation refusal, or a 400's `invalid_symbols` (ruling 8). Such keys take no
 * feed slot and no poll. The set is forgotten when the broker session turns active (the server
 * may have downloaded its master contracts since) and on a new IST day.
 */
export type UnknownKeys = StoreApi<{
  keys: ReadonlySet<string>
  /** Moves on when a clear forgets keys, so the seed asks again for the ones it skipped. */
  epoch: number
  add(keys: readonly string[]): void
  /** Forgets every key. */
  clear(): void
  /** Clears the set once the IST day has changed; true when that forgot keys. */
  rollover(): boolean
}>

function createUnknownKeys(now: () => number): UnknownKeys {
  let day = istDate(now())
  return createStore((set, get) => ({
    keys: new Set<string>(),
    epoch: 0,
    add(keys) {
      const fresh = keys.filter((k) => !get().keys.has(k))
      if (fresh.length) set({ keys: new Set([...get().keys, ...fresh]) })
    },
    clear() {
      if (get().keys.size) set({ keys: new Set<string>(), epoch: get().epoch + 1 })
    },
    rollover() {
      const today = istDate(now())
      if (today === day) return false
      day = today
      const had = get().keys.size > 0
      get().clear()
      return had
    },
  }))
}

/** Clears `unknown` when the broker session turns active, and rolls it over at each foreground. */
function forgetRefusals(unknown: UnknownKeys): () => void {
  const offConn = useConnection.subscribe((st, prev) => {
    if (st.brokerSession === 'active' && prev.brokerSession !== 'active') unknown.getState().clear()
  })
  const app = AppState.addEventListener('change', (st) => {
    if (st === 'active') unknown.getState().rollover()
  })
  return () => {
    offConn()
    app.remove()
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
  /** The analyzer mode each order write is checked against, on useAnalyzer's query. */
  analyzer: AnalyzerGate
}

export function createTrading(
  s: Pick<Services, 'api' | 'storage' | 'queryClient' | 'profile'>,
  o: { now: () => number },
): Trading {
  return {
    instruments: createInstrumentCache({ api: s.api, storage: s.storage, now: o.now }),
    watchlists: createWatchlistsStore(s.storage),
    unknown: createUnknownKeys(o.now),
    depthDowngrades: createDepthDowngrades(),
    orders: createOrderApi(s.api),
    analyzer: createAnalyzerGate({
      queryClient: s.queryClient,
      pid: s.profile.get().id,
      api: s.api,
    }),
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
  useEffect(() => forgetRefusals(trading.unknown), [trading])
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
