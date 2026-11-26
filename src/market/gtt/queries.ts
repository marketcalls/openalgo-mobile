// The GTT book as a query, and GTT support as screens see it. The book is read on demand only
// (design 12): a screen that lists it, the app's own writes and pokes, and one detection read
// per broker and mode while support is unknown. It never runs on a timer.
import { useQuery } from '@tanstack/react-query'
import { useMemo, useSyncExternalStore } from 'react'
import { log } from '~/core/log/logger'
import { qk } from '~/core/query/keys'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { useBroker, useBrokerBlocked } from '../session'
import { useTrading } from '../trading'
import { type GttSupport, gttSupport } from './support'

const TAG = 'gtt'
const NEVER = Number.POSITIVE_INFINITY

/**
 * The GTT book, read while `enabled`, nothing is blocked and the screen is focused. Kept after
 * its screen hides, so a blocked screen still shows what it last read, as the other books are.
 */
export function useGttBook({ enabled = true }: { enabled?: boolean } = {}) {
  const { profile } = useServices()
  const trading = useTrading()
  const blocked = useBrokerBlocked()
  const active = useScreenActive()
  return useQuery({
    queryKey: qk.gttbook(profile.get().id),
    queryFn: () => trading.gtt.book(),
    enabled: enabled && !blocked,
    subscribed: active,
    gcTime: NEVER,
  })
}

/**
 * GTT support for the server's broker in the badge's mode, and for `exchange` when given. While
 * the answer is unknown and a read can settle it, the GTT book is read once: its reply (or its
 * refusal) is recorded in the caps, which answers here. Screens that ask together share the read.
 */
export function useGttSupport(exchange?: string): GttSupport {
  const { caps, profile } = useServices()
  const trading = useTrading()
  const blocked = useBrokerBlocked()
  const active = useScreenActive()
  const c = useSyncExternalStore(caps.subscribe, caps.get)
  const mode = useConnection((s) => s.analyzer)
  const broker = useBroker()
  const support = useMemo(
    () => gttSupport(c, { mode, broker, exchange }),
    [c, mode, broker, exchange],
  )
  // The one detection read (design 12), at most once per server, broker, mode and probe: a
  // re-probe (`probedAt`) starts `features` afresh. It is not a book, so a poke or a mode flip's
  // reset leaves it alone, and nothing repeats it: not another screen, a remount, a foreground or
  // a reconnect. A read that settles nothing (no answer, a 429, a reply from the other mode)
  // still counts as made, since a query without data is stale whatever its staleTime: the GTT
  // segment's own reads, a mode or broker change, or the next probe settle it later. A reply from
  // the other mode drops the badge's reading (`createGttApi`'s noteMode), so the badge reads the
  // mode again at once, and with it this key: the reply has already recorded that mode's answer.
  useQuery({
    queryKey: qk.gttdetect(profile.get().id, c?.host ?? null, broker, mode, c?.probedAt ?? null),
    queryFn: () =>
      trading.gtt.book().then(
        () => true,
        (e: unknown) => {
          log.warn(TAG, 'the GTT support read failed', e)
          return false
        },
      ),
    enabled: support.detect && !blocked,
    subscribed: active,
    staleTime: NEVER,
    gcTime: NEVER,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  return support
}
