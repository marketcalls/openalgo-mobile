// The trading layer's container: shared logic built from the services, given to hooks through
// context. Later tasks add fields. It imports no feature.
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { type Services, useServices } from '~/core/services/services'
import { createInstrumentCache, type InstrumentCache } from './instruments/cache'

export type Trading = {
  instruments: InstrumentCache
}

export function createTrading(
  s: Pick<Services, 'api' | 'storage'>,
  o: { now: () => number },
): Trading {
  return { instruments: createInstrumentCache({ api: s.api, storage: s.storage, now: o.now }) }
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
