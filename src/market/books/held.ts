// The "held" marker for an instrument (Kite's quantity badge): what the account holds in it,
// read from the holdings and the positions.
import { useMemo } from 'react'
import { quoteKey } from '~/core/realtime/protocol'
import { useHoldings, usePositionbook } from './queries'
import type { HoldingRow, PositionRow } from './schemas'

/**
 * The quantity held per `quoteKey`: the holdings sum when above 0, else the signed sum of the
 * positions across products when not 0, else the key is absent.
 */
export function heldQuantities(
  holdings?: readonly HoldingRow[],
  positions?: readonly PositionRow[],
): ReadonlyMap<string, number> {
  const sum = (rows: readonly (HoldingRow | PositionRow)[] | undefined) => {
    const m = new Map<string, number>()
    for (const r of rows ?? []) {
      const k = quoteKey(r.exchange, r.symbol)
      m.set(k, (m.get(k) ?? 0) + r.quantity)
    }
    return m
  }
  const held = sum(holdings)
  const net = sum(positions)
  const out = new Map<string, number>()
  for (const [k, q] of held) if (q > 0) out.set(k, q)
  for (const [k, q] of net) if (!out.has(k) && q !== 0) out.set(k, q)
  return out
}

/** `heldQuantities` of the live books; focus-gated, read at most once a minute. */
export function useHeldQuantities(): ReadonlyMap<string, number> {
  const holdings = useHoldings({ staleTime: 60_000 }).data?.rows
  const positions = usePositionbook({ staleTime: 60_000 }).data?.rows
  return useMemo(() => heldQuantities(holdings, positions), [holdings, positions])
}
