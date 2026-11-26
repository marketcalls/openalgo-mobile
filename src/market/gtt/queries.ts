// The GTT book as a query, and GTT support as screens see it. The book is read on demand only
// (design 12): a screen that lists it, the app's own writes and pokes, and one detection read
// while support is unknown. It never runs on a timer.
import { useQuery } from '@tanstack/react-query'
import { useMemo, useSyncExternalStore } from 'react'
import { qk } from '~/core/query/keys'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { useBroker, useBrokerBlocked } from '../session'
import { useTrading } from '../trading'
import { type GttSupport, gttSupport } from './support'

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
    gcTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * GTT support for the server's broker in the badge's mode, and for `exchange` when given. While
 * the answer is unknown and a read can settle it, the GTT book is read once: its reply (or its
 * refusal) is recorded in the caps, which answers here. Screens that ask together share the read.
 */
export function useGttSupport(exchange?: string): GttSupport {
  const { caps } = useServices()
  const c = useSyncExternalStore(caps.subscribe, caps.get)
  const mode = useConnection((s) => s.analyzer)
  const broker = useBroker()
  const support = useMemo(
    () => gttSupport(c, { mode, broker, exchange }),
    [c, mode, broker, exchange],
  )
  useGttBook({ enabled: support.detect })
  return support
}
