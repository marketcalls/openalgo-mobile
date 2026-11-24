// The trading layer's container: shared logic built from the services, given to hooks through
// context. Later tasks add fields. It imports no feature.
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useStore } from 'zustand'
import { type Services, useServices } from '~/core/services/services'
import { createInstrumentCache, type InstrumentCache } from './instruments/cache'
import type { Watchlists } from './watchlists/model'
import { createWatchlistsStore, type WatchlistsStore } from './watchlists/store'

export type Trading = {
  instruments: InstrumentCache
  watchlists: WatchlistsStore
}

export function createTrading(
  s: Pick<Services, 'api' | 'storage'>,
  o: { now: () => number },
): Trading {
  return {
    instruments: createInstrumentCache({ api: s.api, storage: s.storage, now: o.now }),
    watchlists: createWatchlistsStore(s.storage),
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
