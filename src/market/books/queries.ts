// The account's books and funds as queries, and how they refresh (design 7.6): order events, the
// app's own writes and a foreground refetch them; while a book screen is focused a poll does too,
// at a rate that follows whether order events can be relied on (policy.ts).
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { FundsSchema } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { type Services, useServices } from '~/core/services/services'
import { useBroker, useBrokerBlocked } from '../session'
import { useTrading } from '../trading'
import type { EventWatch } from './eventWatch'
import { bookPollMs, booksMarketOpen, type EventedInput, isEvented, streamLive } from './policy'
import { isWorking, type Orderbook } from './schemas'

export type BookName = 'orderbook' | 'tradebook' | 'positionbook' | 'holdings'

/**
 * A hidden screen's query has no subscribed observer, so it would be dropped after the default
 * 5 minutes; kept instead, a blocked screen still shows what it last read (Global: cached data
 * with stale styling). Disposing the container clears it.
 */
const KEEP = Number.POSITIVE_INFINITY

/**
 * A book, read while nothing is blocked. A screen that is not focused neither fetches nor
 * refetches on an invalidation (ruling 11: the tabs stay mounted); focus refetches it if stale.
 */
function useBook<T>(name: BookName, read: () => Promise<T>) {
  const { profile } = useServices()
  const blocked = useBrokerBlocked()
  const active = useScreenActive()
  return useQuery({
    queryKey: qk[name](profile.get().id),
    queryFn: read,
    enabled: !blocked,
    subscribed: active,
    gcTime: KEEP,
  })
}

export function useOrderbook() {
  const { orders } = useTrading()
  return useBook('orderbook', () => orders.orderbook())
}

export function useTradebook() {
  const { orders } = useTrading()
  return useBook('tradebook', () => orders.tradebook())
}

export function usePositionbook() {
  const { orders } = useTrading()
  return useBook('positionbook', () => orders.positionbook())
}

export function useHoldings() {
  const { orders } = useTrading()
  return useBook('holdings', () => orders.holdings())
}

/**
 * The funds figures. It fetches only while `enabled` (a screen that shows them is open), its
 * screen is focused, and nothing is blocked (broker logged out, key refused or IP banned).
 */
export function useFunds({ enabled }: { enabled: boolean }) {
  const { api, profile } = useServices()
  const pid = profile.get().id
  const blocked = useBrokerBlocked()
  const active = useScreenActive()
  return useQuery({
    queryKey: qk.funds(pid),
    queryFn: () => api.call('funds', {}, FundsSchema),
    staleTime: 10_000,
    enabled: enabled && !blocked,
    subscribed: active,
    gcTime: KEEP,
  })
}

type RateSources = Pick<Services, 'realtime' | 'caps' | 'queryClient'>

/** `isEvented`'s inputs as they stand: the feed, the caps, the analyzer badge and the watch. */
const eventedNow = (s: RateSources, broker: string | null, watch: EventWatch): EventedInput => ({
  streamLive: streamLive(s.realtime.status().state, s.caps.ws().orderStream),
  broker,
  analyzer: useConnection.getState().analyzer,
  demoted: watch.demoted(),
})

/** Calls `fn` when any of the poll rate's sources changes. */
const onRateSources = (s: RateSources, fn: () => void): (() => void) => {
  const offs = [
    s.realtime.onStatus(fn),
    s.caps.subscribe(fn),
    useConnection.subscribe(fn),
    s.queryClient.getQueryCache().subscribe(fn),
  ]
  return () => {
    for (const off of offs) off()
  }
}

/**
 * Whether order events can be relied on right now, for the ticket: when true, it hands its
 * placed order to `eventWatch.expect`.
 */
export function useIsEvented(): () => boolean {
  const s = useServices()
  const { eventWatch } = useTrading()
  const broker = useBroker()
  return useCallback(() => isEvented(eventedNow(s, broker, eventWatch)), [s, broker, eventWatch])
}

/**
 * Polls `books` while `active`, the screen is focused and nothing is blocked: a `custom`
 * consumer refetches those books (only the screen's own, ruling 11) every `bookPollMs`. The
 * rate is read again before each wait; when the feed, the caps, the analyzer badge or the
 * orderbook change it, a new wait starts at once. A demotion shows at the next wait.
 */
export function useBookPolling(active: boolean, books: readonly BookName[]): void {
  const s = useServices()
  const { eventWatch } = useTrading()
  const broker = useBroker()
  const blocked = useBrokerBlocked()
  const focused = useScreenActive()
  const on = active && focused && !blocked
  const pid = s.profile.get().id

  const rateNow = useCallback(() => {
    const orders = s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid))?.orders ?? []
    return bookPollMs({
      ...eventedNow(s, broker, eventWatch),
      anyWorking: orders.some(isWorking),
      marketOpen: booksMarketOpen(orders, Date.now()),
    })
  }, [s, pid, broker, eventWatch])
  // A hidden screen does not listen, so it does not re-render either.
  const subscribe = useCallback((fn: () => void) => (on ? onRateSources(s, fn) : () => {}), [on, s])
  const rate = useSyncExternalStore(subscribe, rateNow)

  const names = books.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `rate` re-arms the wait; `names` stands for `books`
  useEffect(() => {
    if (!on) return
    const keys = names
      .split(',')
      .filter((n) => n !== '')
      .map((n) => qk[n as BookName](pid))
    return s.polling.register(
      {
        kind: 'custom',
        intervalMs: rateNow,
        run: async () => {
          await Promise.all(keys.map((queryKey) => s.queryClient.invalidateQueries({ queryKey })))
        },
      },
      true,
    )
  }, [on, s, pid, names, rateNow, rate])
}
