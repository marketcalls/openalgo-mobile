// Live P&L for the portfolio rows: a port of the web's `useLivePrice.ts` (:248-289). A row is
// recomputed from a live LTP only when it can be (an open position with an average price);
// otherwise the broker's own figures stand. Pure.
import type { HoldingRow, PositionRow } from './schemas'

export type LivePnl = {
  ltp: number | undefined
  pnl: number | undefined
  pnlPct: number | undefined
  /** True when `pnl` was computed from the tick, not read from the book. */
  live: boolean
}

type PositionFields = Pick<
  PositionRow,
  'quantity' | 'average_price' | 'ltp' | 'pnl' | 'pnlpercent' | 'lot_size' | 'today_realized_pnl'
>

/**
 * `(ltp - avg) x qty x lot` for a long, `(avg - ltp) x |qty| x lot` for a short, plus today's
 * realised P&L; the percentage is against `|avg x qty|`. A closed row, a row without an average
 * price (the web's guard, :273) or without a tick keeps the book's `pnl` and `pnlpercent`.
 */
export function livePositionPnl(row: PositionFields, ltp?: number): LivePnl {
  const rest: LivePnl = {
    ltp: ltp ?? row.ltp,
    pnl: row.pnl,
    pnlPct: row.pnlpercent,
    live: false,
  }
  const avg = row.average_price
  if (ltp === undefined || row.quantity === 0 || avg === undefined || !(avg > 0)) return rest
  const lot = row.lot_size ?? 1
  const qty = Math.abs(row.quantity)
  const open = (row.quantity > 0 ? ltp - avg : avg - ltp) * qty * lot
  const pnl = open + (row.today_realized_pnl ?? 0)
  return { ltp, pnl, pnlPct: (pnl / Math.abs(avg * row.quantity)) * 100, live: true }
}

/** A holding is recomputed only when the book gave its average price. */
export function liveHoldingPnl(
  row: Pick<HoldingRow, 'quantity' | 'average_price' | 'ltp' | 'pnl' | 'pnlpercent'>,
  ltp?: number,
): LivePnl {
  const avg = row.average_price
  if (ltp === undefined || avg === undefined || !(avg > 0) || row.quantity === 0) {
    return { ltp: ltp ?? row.ltp, pnl: row.pnl, pnlPct: row.pnlpercent, live: false }
  }
  const pnl = (ltp - avg) * row.quantity
  return { ltp, pnl, pnlPct: (pnl / Math.abs(avg * row.quantity)) * 100, live: true }
}

/** The sum of the rows' P&L; a row without one adds nothing. */
export const totals = (rows: readonly { pnl: number | undefined }[]): number =>
  rows.reduce((sum, r) => sum + (r.pnl ?? 0), 0)
