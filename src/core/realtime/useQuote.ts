import { createContext, useContext, useSyncExternalStore } from 'react'
import type { DepthBook, Quote } from './protocol'
import type { TickStore } from './tickStore'

/** Provided by the app shell with `services.store`. */
export const TickStoreContext = createContext<TickStore | null>(null)

const useStore = (): TickStore => {
  const store = useContext(TickStoreContext)
  if (!store) throw new Error('TickStoreContext is not provided')
  return store
}

const noopUnsubscribe = () => {}

/**
 * One row re-renders only when its own key ticks, and only while `active`. An inactive hook
 * is not subscribed; when it turns active it resubscribes and re-reads, so it catches up.
 */
export const useQuote = (key: string, active: boolean): Quote | undefined => {
  const store = useStore()
  return useSyncExternalStore(
    (fn) => (active ? store.subscribe(key, fn) : noopUnsubscribe),
    () => store.get(key),
  )
}

/** The depth book of a key, or undefined before the first depth tick. */
export const useDepth = (key: string, active: boolean): DepthBook | undefined =>
  useQuote(key, active)?.depth

/** True when the feed is not delivering (see the connection state). */
export const useFeedStale = (): boolean => {
  const store = useStore()
  return useSyncExternalStore(store.subscribeStale, store.isStale)
}
