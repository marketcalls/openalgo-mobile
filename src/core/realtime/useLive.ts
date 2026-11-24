// Hooks for live prices: while the screen is active they hold a socket subscription and a polling
// consumer; the polling engine only calls REST for symbols the socket is not carrying.
import { createContext, useContext, useEffect } from 'react'
import type { PollingEngine } from './polling'
import type { DepthLevel, Quote } from './protocol'
import { quoteKey } from './protocol'
import type { TickStore } from './tickStore'
import { useQuoteFrom } from './useQuote'
import { useScreenActive } from './useScreenActive'
import type { Realtime } from './wsClient'

export type LiveServices = {
  realtime: Pick<Realtime, 'acquire' | 'confirmedDepth'>
  polling: PollingEngine
  store: TickStore
}

/** Provided by the app shell. */
export const LiveContext = createContext<LiveServices | null>(null)

const useLive = (): LiveServices => {
  const live = useContext(LiveContext)
  if (!live) throw new Error('LiveContext is not provided')
  return live
}

export type LiveDepth = {
  buy: DepthLevel[]
  sell: DepthLevel[]
  levels: number
  /** Levels the feed really delivers (S12); undefined until the first depth tick. */
  confirmedDepth?: number
  source: Quote['source']
}

/** Live quote of a symbol; mode 1 is LTP only, 2 adds the day's range and volume. */
export const useLiveQuote = (
  exchange: string,
  symbol: string,
  mode: 1 | 2 = 2,
): Quote | undefined => {
  const { realtime, polling, store } = useLive()
  const active = useScreenActive()
  const key = quoteKey(exchange, symbol)
  useEffect(() => {
    if (!active) return
    const release = realtime.acquire({ exchange, symbol, mode })
    const unregister = polling.register({ kind: 'quotes', keys: () => [key] }, true)
    return () => {
      release()
      unregister()
    }
  }, [active, realtime, polling, exchange, symbol, mode, key])
  return useQuoteFrom(store, key, active)
}

/** Live depth book, or undefined before the first depth tick or poll. */
export const useLiveDepth = (
  exchange: string,
  symbol: string,
  levels: 5 | 20 | 30 = 5,
): LiveDepth | undefined => {
  const { realtime, polling, store } = useLive()
  const active = useScreenActive()
  const key = quoteKey(exchange, symbol)
  useEffect(() => {
    if (!active) return
    const release = realtime.acquire({ exchange, symbol, mode: 3, depth: levels })
    const unregister = polling.register({ kind: 'depth', key: () => key }, true)
    return () => {
      release()
      unregister()
    }
  }, [active, realtime, polling, exchange, symbol, levels, key])
  const q = useQuoteFrom(store, key, active)
  if (!q?.depth) return undefined
  const confirmedDepth = realtime.confirmedDepth(exchange, symbol)
  return {
    buy: q.depth.buy,
    sell: q.depth.sell,
    levels: q.depth.levels,
    ...(confirmedDepth !== undefined ? { confirmedDepth } : {}),
    source: q.source,
  }
}
