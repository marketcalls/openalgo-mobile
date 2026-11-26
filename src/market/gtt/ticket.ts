// The GTT ticket's rules (design 17.3): a SINGLE trigger or an OCO pair, each placing a LIMIT
// order when it fires, with the order ticket's quantity rule (lots on a derivative) and prices on
// the tick. A SINGLE's direction comes from the LTP (RF 6), so it is planned only with one.
import { fmtQty } from '~/ui/format'
import { isQuoteOnly, usesLots } from '../instruments/exchanges'
import type { InstrumentMeta } from '../instruments/meta'
import { fmtTick, snapTick } from '../instruments/tick'
import type { GttParams } from '../links'
import type { OrderMeta } from '../orders/outcome'
import type { Side } from '../types'
import type { GttRow, GttSpec, GttType } from './schemas'

export type GttTicketState = {
  exchange: string
  symbol: string
  action: Side
  type: GttType
  /** Lots on a derivative exchange, units elsewhere. */
  qty: number
  /** A modify's own product, which it keeps; a new GTT takes its segment's (`gttProduct`). */
  product?: GttSpec['product']
  /** SINGLE: the trigger and the limit price of the order it places. */
  trigger?: number
  price?: number
  /** OCO: the stop-loss leg, below the target leg. */
  slTrigger?: number
  slPrice?: number
  tgTrigger?: number
  tgPrice?: number
}

export type GttIssue =
  | 'quote_only'
  | 'unknown_instrument'
  | 'qty'
  | 'over_freeze'
  | 'trigger_missing'
  | 'price_missing'
  | 'trigger_at_ltp'
  | 'ltp_unknown'
  | 'oco_missing'
  | 'oco_order'
  | 'oco_ltp'

/** G2: CNC on cash, NRML on a derivative; MIS is refused, since a GTT outlives the day. */
export const gttProduct = (exchange: string): GttSpec['product'] =>
  usesLots(exchange) ? 'NRML' : 'CNC'

/** The products a GTT is sent with (G2), as a book row lists them. */
const GTT_PRODUCTS: Record<string, GttSpec['product']> = { CNC: 'CNC', NRML: 'NRML' }

const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0

/** On the tick, with the price itself as the reference for the tick's 1% guard. */
const snap = (n: number, meta: InstrumentMeta) => snapTick(n, meta.tick, n)

/** A price as the GTT sends it: on the tick, or 0 when there is none (below half a tick too). */
const sent = (n: number | undefined, meta: InstrumentMeta) => (positive(n) ? snap(n, meta) : 0)

/** The quantity the GTT carries, in units: lots × lot size on a derivative. */
const unitsOf = (t: GttTicketState, meta: InstrumentMeta) =>
  usesLots(t.exchange) ? t.qty * meta.lotsize : t.qty

/**
 * A ticket from a link's presets: SINGLE, BUY unless the link names a side, and 1 lot (or 1 unit).
 * A derivative's quantity, given in units, becomes the nearest whole number of lots, as the order
 * ticket presets it (`initialTicket`).
 */
export function initialGttTicket(p: GttParams, meta: InstrumentMeta): GttTicketState {
  return {
    exchange: p.exchange,
    symbol: p.symbol,
    action: p.action ?? 'BUY',
    type: 'SINGLE',
    qty:
      p.quantity === undefined
        ? 1
        : usesLots(p.exchange)
          ? Math.max(1, Math.round(p.quantity / meta.lotsize))
          : p.quantity,
  }
}

/**
 * Why a book row can't be modified here. A modify replaces the GTT whole (G2), so it sends the
 * row's own values: a row whose side, product or order type the ticket can't send as listed would
 * go back changed.
 */
export type GttRowRefusal =
  | { refused: 'legs' }
  | { refused: 'product'; product: string }
  | { refused: 'pricetype'; pricetype: string }

/**
 * The ticket a modify starts from: the row's own values, the quantity in lots on a derivative.
 * The book pairs each leg with its own trigger and lists them ascending (RF 3), so an OCO's
 * stop-loss is its first leg, never its target.
 * - A row without the legs its type needs has no side to keep.
 * - It keeps the row's product, which need not be its segment's: an NRML GTT on NSE (Angel's
 *   MARGIN) sent back as CNC would fire as a delivery order. A product other than CNC or NRML, or
 *   two legs with different ones, can't be sent (G2).
 * - Each leg places a LIMIT order (design 17.3), so a leg with another order type (a MARKET one)
 *   can't be sent as listed.
 */
export function gttTicketFromRow(
  row: GttRow,
  meta: InstrumentMeta,
): GttTicketState | GttRowRefusal {
  const [first, second] = row.legs
  if (!first || (row.type === 'OCO' && !second)) return { refused: 'legs' }
  const legs = row.type === 'OCO' && second ? [first, second] : [first]
  const products = new Set(legs.map((l) => l.product.trim().toUpperCase()))
  const product = products.size === 1 ? GTT_PRODUCTS[[...products][0] ?? ''] : undefined
  if (!product) {
    return {
      refused: 'product',
      product: [...new Set(legs.map((l) => l.product.trim()))].join(' / '),
    }
  }
  const other = legs.find((l) => l.pricetype.trim().toUpperCase() !== 'LIMIT')
  if (other) return { refused: 'pricetype', pricetype: other.pricetype.trim() }
  const t: GttTicketState = {
    exchange: row.exchange,
    symbol: row.symbol,
    action: first.action,
    type: row.type,
    qty: meta.lots ? first.quantity / meta.lotsize : first.quantity,
    product,
  }
  if (row.type === 'SINGLE') return { ...t, trigger: row.triggers[0], price: first.price }
  return {
    ...t,
    slTrigger: first.trigger ?? row.triggers[0],
    slPrice: first.price,
    tgTrigger: second?.trigger ?? row.triggers[1],
    tgPrice: second?.price,
  }
}

/**
 * What stops the GTT going to review, as `validateTicket` reports the order ticket's. A quote-only
 * or unlisted instrument is reported alone. Prices are checked as `planGtt` sends them, on the
 * tick. A SINGLE needs the LTP, which gives its direction (RF 6), and a trigger apart from it; an
 * OCO's stop-loss must be below its target, with the LTP, when known, between them.
 */
export function validateGtt(
  t: GttTicketState,
  meta: InstrumentMeta | 'unknown',
  ltp?: number,
): GttIssue[] {
  if (isQuoteOnly(t.exchange)) return ['quote_only']
  if (meta === 'unknown') return ['unknown_instrument']

  const issues: GttIssue[] = []
  if (!(Number.isInteger(t.qty) && t.qty >= 1)) issues.push('qty')
  else if (meta.freezeQty > 1 && unitsOf(t, meta) > meta.freezeQty) issues.push('over_freeze')

  if (t.type === 'SINGLE') {
    const trigger = sent(t.trigger, meta)
    if (!positive(trigger)) issues.push('trigger_missing')
    if (!positive(sent(t.price, meta))) issues.push('price_missing')
    if (!positive(ltp)) issues.push('ltp_unknown')
    else if (positive(trigger) && trigger === ltp) issues.push('trigger_at_ltp')
    return issues
  }

  const sl = sent(t.slTrigger, meta)
  const tg = sent(t.tgTrigger, meta)
  if (![sl, sent(t.slPrice, meta), tg, sent(t.tgPrice, meta)].every(positive)) {
    issues.push('oco_missing')
  } else if (sl >= tg) issues.push('oco_order')
  else if (positive(ltp) && !(sl < ltp && ltp < tg)) issues.push('oco_ltp')
  return issues
}

/**
 * The GTT as it is sent: every price on the tick, the modify's own product or else the one its
 * segment takes, the quantity in units. A SINGLE above `ltp` fires on a rise, below it on a fall
 * (RF 6); the review plans it with the LTP of that moment, and confirm again with its own. Only a
 * valid ticket is planned: a SINGLE without an LTP has no direction, and is refused.
 */
export function planGtt(t: GttTicketState, meta: InstrumentMeta, ltp?: number): GttSpec {
  const common = {
    exchange: t.exchange,
    symbol: t.symbol,
    action: t.action,
    product: t.product ?? gttProduct(t.exchange),
    quantity: unitsOf(t, meta),
  }
  if (t.type === 'OCO') {
    return {
      ...common,
      type: 'OCO',
      sl: { trigger: sent(t.slTrigger, meta), price: sent(t.slPrice, meta) },
      tg: { trigger: sent(t.tgTrigger, meta), price: sent(t.tgPrice, meta) },
    }
  }
  if (!positive(ltp)) throw new Error('planGtt: a SINGLE GTT needs the LTP for its direction')
  const trigger = sent(t.trigger, meta)
  return {
    ...common,
    type: 'SINGLE',
    trigger,
    price: sent(t.price, meta),
    above: trigger > ltp,
  }
}

/** What `gttIssueText` reads: the instrument (lots or units) and the LTP the issue came from. */
export type GttIssueContext = { meta: InstrumentMeta | 'unknown'; ltp?: number }

export function gttIssueText(issue: GttIssue, { meta }: GttIssueContext): string {
  switch (issue) {
    case 'quote_only':
      return 'Indices are quote-only: GTT is not available.'
    case 'unknown_instrument':
      return 'This contract is expired or unknown.'
    case 'qty':
      return meta !== 'unknown' && meta.lots
        ? 'Enter a quantity of at least 1 lot.'
        : 'Enter a quantity of at least 1.'
    case 'over_freeze':
      return `Above the freeze quantity of ${fmtQty(meta === 'unknown' ? 0 : meta.freezeQty)}. Place a smaller GTT.`
    case 'trigger_missing':
      return 'Enter a trigger price.'
    case 'price_missing':
      return 'Enter a limit price.'
    case 'trigger_at_ltp':
      return 'The trigger must differ from the last price.'
    case 'ltp_unknown':
      return 'Waiting for the last price.'
    case 'oco_missing':
      return 'Enter both triggers and both limit prices.'
    case 'oco_order':
      return 'The stop-loss trigger must be below the target trigger.'
    case 'oco_ltp':
      return 'The last price must sit between the stop-loss and target triggers.'
  }
}

/** A spec with any product in place of the two a GTT is sent with. */
type AnyProduct<T> = T extends unknown ? Omit<T, 'product'> & { product: string } : never

/** What a summary reads: a GTT as it is sent, or a book row's values with the product it lists. */
export type GttShown = AnyProduct<GttSpec>

/**
 * The GTT in one line, from what is sent: `GTT · SELL 1 RELIANCE · trigger 1,500.00 → LIMIT
 * 1,499.00 · CNC`, or `GTT OCO · SELL 1 RELIANCE · SL 1,300.00 → 1,299.00 · target 1,500.00 →
 * 1,501.00 · CNC`. Lots show as the order terms show them: `2L (130)`. A row that lists no
 * product shows none.
 */
export function gttSummary(spec: GttShown, meta: OrderMeta): string {
  const px = (n: number) => fmtTick(n, meta.tick, n)
  const lots = meta.lots ? spec.quantity / meta.lotsize : Number.NaN
  const qty = Number.isInteger(lots)
    ? `${fmtQty(lots)}L (${fmtQty(spec.quantity)})`
    : fmtQty(spec.quantity)
  const what = `${spec.action} ${qty} ${spec.symbol}`
  const product = spec.product ? ` · ${spec.product}` : ''
  if (spec.type === 'SINGLE') {
    return `GTT · ${what} · trigger ${px(spec.trigger)} → LIMIT ${px(spec.price)}${product}`
  }
  const leg = (l: { trigger: number; price: number }) => `${px(l.trigger)} → ${px(l.price)}`
  return `GTT OCO · ${what} · SL ${leg(spec.sl)} · target ${leg(spec.tg)}${product}`
}
