import { useQuery } from '@tanstack/react-query'
import { qk } from '~/core/query/keys'
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
    staleTime: TEN_MINUTES,
    enabled: exchange !== '' && symbol !== '',
  })
  const d = q.data
  return {
    meta: d === undefined || d === 'unknown' ? undefined : d,
    unknown: d === 'unknown',
    loading: d === undefined && q.isPending,
  }
}
