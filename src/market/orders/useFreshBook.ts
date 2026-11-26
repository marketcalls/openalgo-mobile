// The books read after a write, for the check of its outcome and for a form that must start from
// the order as it is now. The ticket, the Orders tab, the modify sheet, the portfolio's closes and
// the chart's intents share them.
import { useCallback } from 'react'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import type { Orderbook, Positionbook } from '../books/schemas'
import { useTrading } from '../trading'

/**
 * One read of the order book sent now, never joined to a read already out (`fresh`): one sent
 * before the write may not show it, and TanStack's `fetchQuery` or the scheduler's dedupe would
 * join it. What it read is shown on the books unless a reply that landed meanwhile is there.
 */
export function useFreshBook(): () => Promise<Orderbook> {
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  return useCallback(async () => {
    const key = qk.orderbook(pid)
    const sentAt = Date.now()
    const b = await trading.orders.orderbook({ fresh: true })
    if ((s.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) < sentAt) {
      s.queryClient.setQueryData(key, b)
    }
    return b
  }, [s, trading, pid])
}

/**
 * One read of the positionbook sent now, never joined to one already out: a read sent before
 * the write may not show it. What it read is shown on the books unless a newer reply is there.
 */
export function useFreshPositions(): () => Promise<Positionbook> {
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  return useCallback(async () => {
    const key = qk.positionbook(pid)
    const sentAt = Date.now()
    const b = await trading.orders.positionbook({ fresh: true })
    if ((s.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) < sentAt) {
      s.queryClient.setQueryData(key, b)
    }
    return b
  }, [s, trading, pid])
}
