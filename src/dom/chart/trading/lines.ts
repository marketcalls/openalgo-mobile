// Order and position lines from native's book pushes (design 7.9.4), ported from the web
// terminal, frontend/src/lib/trading/terminal.ts at c8b2896:
// - makeOrderLine (2084-2101) and pollBook's line sync (2143-2170): one dashed, draggable line per
//   working order, at its trigger for a stop, moved in place and removed once the order is gone;
// - renderPosition and posLabel (2103-2139): the web draws one 'position' line for the
//   instrument. The chart draws one per product, `position:<product>`, since native closes a
//   position per product (the plan's own adaptation, preflight conflict 21).
// The colours are the app's BUY green and SELL red; a long position takes BUY's, a short SELL's.
// A line runs from `lineExtent` of the plot to its right edge, its badges and X from the line's
// left end.
import type { Chart, PriceLine } from 'openalgo-charts'
import type { ChartOrder, ChartPosition } from '~/dom/bridge/protocol'

export type TradeColors = {
  readonly buy: string
  readonly sell: string
  readonly onBuy: string
  readonly onSell: string
}

export type OrderLineRec = {
  line: PriceLine
  order: ChartOrder
  /** The book price a drag started from; null when no drag is under way. */
  dragFrom: number | null
}

type LineChart = Pick<Chart, 'addPriceLine' | 'removePrimitive'>

export const ORDER_PREFIX = 'order:'
export const POSITION_PREFIX = 'position:'
/** What the chart appends to a line's id for a tap on its close segment. */
export const CLOSE_SUFFIX = '::close'

/**
 * The plot a line's badges need, its X included: a position's LONG, quantity, `@ avg ±₹P&L` and X
 * come to about 280 px with a lakh's P&L; an order's (BUY, quantity, type, X) to about 120.
 */
export const BADGE_ROOM_PX = 300

/**
 * How much of the plot a line takes from its right edge: the web's 0.3 on a wide plot, more on a
 * phone, all of it on one under 300 px. The badges start at the line's left end with no clamp, and
 * the chart hit-tests nothing past the plot's edge (a tap there drags the price axis), so with the
 * web's 0.3 a phone's X sat beyond it.
 */
export function lineExtent(plotWidth: number): number {
  return Math.min(1, Math.max(0.3, BADGE_ROOM_PX / plotWidth))
}

/** Where an order's line sits: a stop at its trigger, any other order at its price. */
export function bookPrice(o: ChartOrder): number {
  return o.trigger !== null && o.trigger > 0 ? o.trigger : o.price
}

const orderStyle = (o: ChartOrder, c: TradeColors, extent: number) => ({
  color: o.side === 'BUY' ? c.buy : c.sell,
  badge: o.side,
  qty: o.qty,
  leftLabel: o.type,
  extentFromRight: extent,
})

/**
 * Draws `orders` (the instrument's working orders) and removes the lines of the rest; `extent` is
 * `lineExtent` of the plot's width.
 */
export function syncOrderLines(
  chart: LineChart,
  recs: Map<string, OrderLineRec>,
  orders: ChartOrder[],
  c: TradeColors,
  extent: number,
): void {
  const seen = new Set<string>()
  for (const o of orders) {
    seen.add(o.id)
    const rec = recs.get(o.id)
    if (rec === undefined) {
      const line = chart.addPriceLine({
        ...orderStyle(o, c, extent),
        price: bookPrice(o),
        lineWidth: 1,
        dashed: true,
        id: ORDER_PREFIX + o.id,
        cursor: 'ns-resize',
        closeButton: true,
      })
      recs.set(o.id, { line, order: o, dragFrom: null })
      continue
    }
    rec.order = o
    rec.line.setOptions(orderStyle(o, c, extent))
    // A line under the finger stays there; the drag's end puts it at the book price (RF 6).
    if (rec.dragFrom === null) rec.line.setPrice(bookPrice(o))
  }
  for (const [id, rec] of recs) {
    if (seen.has(id)) continue
    chart.removePrimitive(rec.line)
    recs.delete(id)
  }
}

const RUPEES = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** `@ <avg>  ±₹<P&L>`: the P&L at the LTP, flat while there is none (terminal.ts:2103-2108). */
export function positionLabel(p: ChartPosition, ltp: number | null): string {
  const pnl = ((ltp ?? p.avg) - p.avg) * p.net
  return `@ ${RUPEES.format(p.avg)}  ${pnl >= 0 ? '+' : '-'}₹${RUPEES.format(Math.abs(pnl))}`
}

const positionStyle = (p: ChartPosition, ltp: number | null, c: TradeColors, extent: number) => ({
  color: p.net > 0 ? c.buy : c.sell,
  badge: p.net > 0 ? 'LONG' : 'SHORT',
  qty: Math.abs(p.net),
  leftLabel: positionLabel(p, ltp),
  extentFromRight: extent,
})

/** One line per product with a net position, keyed by product in `recs`. */
export function syncPositionLines(
  chart: LineChart,
  recs: Map<string, PriceLine>,
  positions: ChartPosition[],
  ltp: number | null,
  c: TradeColors,
  extent: number,
): void {
  const seen = new Set<string>()
  for (const p of positions) {
    if (p.net === 0) continue
    seen.add(p.product)
    const line = recs.get(p.product)
    if (line === undefined) {
      const added = chart.addPriceLine({
        ...positionStyle(p, ltp, c, extent),
        price: p.avg,
        lineWidth: 2,
        dashed: false,
        id: POSITION_PREFIX + p.product,
        closeButton: true,
      })
      recs.set(p.product, added)
      continue
    }
    if (line.price !== p.avg) line.setPrice(p.avg)
    line.setOptions(positionStyle(p, ltp, c, extent))
  }
  for (const [product, line] of recs) {
    if (seen.has(product)) continue
    chart.removePrimitive(line)
    recs.delete(product)
  }
}
