// What the chart draws from the books (design 7.9.4), as the web terminal keeps its lines
// (frontend/src/lib/trading/terminal.ts:2143-2183, 7964-8000 at c8b2896), with native's reads:
// - the order book is polled while the chart is in front, at the books' own rate (fast only
//   while orders are working and no order events come), and read again on every order event,
//   which pokes the books;
// - the positionbook is read on mount, on those events, and when an order of this instrument
//   changes status between two order book reads, so a fill shows on the position line. It is
//   never polled (preflight conflict 31).
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import type { ChartOrder, ChartPosition, Inst } from '~/dom/bridge/protocol'
import {
  type BookName,
  useBookPolling,
  useOrderbook,
  usePositionbook,
} from '~/market/books/queries'
import { isWorking, type OrderRow } from '~/market/books/schemas'
import { chartOrders, chartPositions } from '~/market/chart/lines'

const BOOKS: readonly BookName[] = ['orderbook']
/** Only a read sets the positions: an event invalidates them, and nothing else does. */
const KEPT = Number.POSITIVE_INFINITY

/** The status of each of the instrument's orders in one read of the book. */
function statusesOf(rows: readonly OrderRow[], inst: Inst): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.exchange === inst.exchange && r.symbol === inst.symbol) out.set(r.orderid, r.status)
  }
  return out
}

/**
 * An order changed status between the two reads: one in both with another status, or one new
 * in the later read that is already done (it was placed and filled, or refused, in between).
 */
function changed(before: Map<string, string>, rows: readonly OrderRow[], inst: Inst): boolean {
  for (const r of rows) {
    if (r.exchange !== inst.exchange || r.symbol !== inst.symbol) continue
    const was = before.get(r.orderid)
    if (was === undefined ? !isWorking(r) : was !== r.status) return true
  }
  return false
}

export function useChartBooks(inst: Inst): { orders: ChartOrder[]; positions: ChartPosition[] } {
  const s = useServices()
  const pid = s.profile.get().id
  useBookPolling(true, BOOKS)
  const orderbook = useOrderbook()
  const positionbook = usePositionbook({ staleTime: KEPT })
  const { exchange, symbol } = inst

  /** Reads the positions now, joining a read already out. */
  const readPositions = useCallback(() => {
    void s.queryClient.invalidateQueries(
      { queryKey: qk.positionbook(pid) },
      { cancelRefetch: false },
    )
  }, [s, pid])
  // what another screen read before may be old: the chart reads its own once
  useEffect(() => readPositions(), [readPositions])

  const rows = orderbook.data?.orders
  /** The last read's statuses, for the instrument they were taken for. */
  const seen = useRef<{ key: string; statuses: Map<string, string> } | null>(null)
  useEffect(() => {
    if (!rows) return
    const shown = { exchange, symbol }
    const key = `${exchange}:${symbol}`
    const last = seen.current
    seen.current = { key, statuses: statusesOf(rows, shown) }
    if (last?.key === key && changed(last.statuses, rows, shown)) readPositions()
  }, [rows, exchange, symbol, readPositions])

  const positionRows = positionbook.data?.rows
  const orders = useMemo(
    () => chartOrders(rows ?? [], { exchange, symbol }),
    [rows, exchange, symbol],
  )
  const positions = useMemo(
    () => chartPositions(positionRows ?? [], { exchange, symbol }),
    [positionRows, exchange, symbol],
  )
  return { orders, positions }
}
