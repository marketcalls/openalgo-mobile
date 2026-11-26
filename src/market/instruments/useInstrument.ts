import { useQuery } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { qk } from '~/core/query/keys'
import { quoteKey } from '~/core/realtime/protocol'
import { useServices } from '~/core/services/services'
import { useTrading } from '../trading'
import type { InstrumentMeta } from './meta'

const TEN_MINUTES = 600_000

/**
 * Metadata for one contract, from the day's cache (one `/symbol` call per symbol per day).
 * `unknown` is an expired or mistyped contract: show it as such, and do not subscribe to it.
 */
export function useInstrument(
  exchange: string,
  symbol: string,
): { meta?: InstrumentMeta; unknown: boolean; loading: boolean } {
  const pid = useServices().profile.get().id
  const { instruments } = useTrading()
  const q = useQuery({
    queryKey: qk.symbol(pid, exchange, symbol),
    queryFn: () => instruments.get(exchange, symbol),
    initialData: () => instruments.peek(exchange, symbol),
    // 'unknown' is asked of the cache again at each mount: it answers from memory while its mark
    // stands, and asks the server once the mark is old or dropped (the broker session turned
    // active, when the server may have reloaded its symbol table)
    staleTime: (q) => (q.state.data === 'unknown' ? 0 : TEN_MINUTES),
    enabled: exchange !== '' && symbol !== '',
  })
  const d = q.data
  return {
    meta: d === undefined || d === 'unknown' ? undefined : d,
    unknown: d === 'unknown',
    loading: d === undefined && q.isPending,
  }
}

/**
 * An expired or mistyped contract (ruling 8): the server refused its quote this session, or
 * today's metadata cache marks it unknown. It never fetches `/symbol`; callers show "Expired or
 * unknown" and call no live hook for it.
 */
export function useIsUnknown(exchange: string, symbol: string): boolean {
  const { instruments, unknown } = useTrading()
  const refused = useStore(unknown, (st) => st.keys.has(quoteKey(exchange, symbol)))
  return refused || instruments.peek(exchange, symbol) === 'unknown'
}
