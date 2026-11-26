// What the chart draws from the books (design 7.9.4), as the web terminal's pollBook picks it
// (frontend/src/lib/trading/terminal.ts:2143-2183 at c8b2896): the working orders of the
// instrument on screen, and its open position. The web draws one position line; the chart draws
// one per product, since native closes a position per product. The page turns these into lines
// (src/dom/chart/trading/lines.ts): an order at its price, a stop at its trigger.
import type { ChartOrder, ChartPosition, Inst } from '~/dom/bridge/protocol'
import { isWorking, type OrderRow, type PositionRow } from '../books/schemas'
import { PRODUCTS } from '../types'

const isInst = (r: Inst, inst: Inst) => r.exchange === inst.exchange && r.symbol === inst.symbol

/** C9: SL and SL-M carry a trigger, which is where their line sits. */
export const isStop = (pricetype: string) => {
  const pt = pricetype.trim().toUpperCase()
  return pt === 'SL' || pt === 'SL-M'
}

/**
 * The instrument's working orders, each with the price its line sits at: a stop's trigger, any
 * other order's price. A row with neither (a working MARKET order, a price the book could not
 * read) has nowhere to be drawn and is left out.
 */
export function chartOrders(rows: readonly OrderRow[], inst: Inst): ChartOrder[] {
  const out: ChartOrder[] = []
  for (const r of rows) {
    if (!isWorking(r) || !isInst(r, inst)) continue
    const stop = isStop(r.pricetype)
    const trigger =
      stop && r.trigger_price !== undefined && r.trigger_price > 0 ? r.trigger_price : null
    const price = r.price ?? 0
    if ((trigger ?? price) <= 0) continue
    out.push({
      id: r.orderid,
      side: r.action,
      type: r.pricetype.trim().toUpperCase(),
      qty: r.quantity,
      price,
      trigger,
    })
  }
  return out
}

/**
 * The instrument's open positions, one per product the chart can close (MIS, CNC, NRML), each at
 * its average. A flat row, or one whose average the book could not read, draws nothing; a second
 * row of a product never replaces the first.
 */
export function chartPositions(rows: readonly PositionRow[], inst: Inst): ChartPosition[] {
  const out = new Map<ChartPosition['product'], ChartPosition>()
  for (const r of rows) {
    const product = PRODUCTS.find((p) => p === r.product)
    if (product === undefined || out.has(product) || !isInst(r, inst) || r.quantity === 0) continue
    const avg = r.average_price
    if (avg === undefined || !(avg > 0)) continue
    out.set(product, { product, net: r.quantity, avg })
  }
  return [...out.values()]
}
