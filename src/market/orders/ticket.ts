// The order ticket's rules (contract C9), ported from the web terminal (openalgo
// frontend/src/lib/trading/terminal.ts; bare `:n` below is that file): products by segment,
// quantity in lots on derivatives, prices on the tick, a stop on the right side of LTP, and
// orders above the freeze limit split the way services/split_order_service.py splits them.
import { fmtQty } from '~/ui/format'
import { defaultProduct, isQuoteOnly, productOptionsFor, usesLots } from '../instruments/exchanges'
import type { InstrumentMeta } from '../instruments/meta'
import { fmtTick, snapTick } from '../instruments/tick'
import type { PriceType, Product, Side, TicketParams } from '../types'
import type { OrderSpec } from './schemas'

export type TicketState = {
  exchange: string
  symbol: string
  action: Side
  product: Product
  pricetype: PriceType
  /** Lots on a derivative exchange, units elsewhere. */
  qty: number
  price?: number
  trigger?: number
}

export type TicketIssue =
  | 'quote_only'
  | 'unknown_instrument'
  | 'qty'
  | 'price_required'
  | 'trigger_required'
  | 'stop_side'
  | 'product'
  | 'split_too_large'
  | 'split_unavailable'

/** Why a quote-only (index) instrument has no order: the ticket's words, one-tap's too. */
export const QUOTE_ONLY_COPY =
  "Indices can't be traded. Open the futures or options contract instead."

/**
 * How the order goes out. A split names the child size the server is asked for and the
 * children it will make; `orders` counts them. Above 100 the server refuses the split, and
 * `children` is left empty so a mistyped quantity cannot allocate millions of entries.
 */
export type OrderPlan =
  | { kind: 'single'; spec: OrderSpec }
  | { kind: 'split'; spec: OrderSpec; splitsize: number; orders: number; children: number[] }

/** split_order_service.py:209 refuses a split into more children than this. */
const MAX_SPLIT_ORDERS = 100

/** C9: LIMIT and SL carry a price, SL and SL-M a trigger; MARKET carries neither. */
const hasPrice = (pt: PriceType) => pt === 'LIMIT' || pt === 'SL'
const hasTrigger = (pt: PriceType) => pt === 'SL' || pt === 'SL-M'

/** sandbox/order_manager.py:1437-1450: a price or trigger the order carries must be above 0. */
const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0

/** What sizing and pricing an order reads of its contract; the chart's metadata carries it too. */
type PlanMeta = Pick<InstrumentMeta, 'tick' | 'lotsize' | 'freezeQty'>

/** On the tick, with the price itself as the reference for the tick's 1% guard. */
const snap = (n: number, meta: PlanMeta) => snapTick(n, meta.tick, n)

/**
 * A price or trigger as the order sends it: on the tick, or 0 when there is none. A value
 * below half a tick (0.02 on tick 0.05) is sent as 0, so validation reads this, not the input.
 */
const sent = (n: number | undefined, meta: PlanMeta) => (positive(n) ? snap(n, meta) : 0)

/** Whole lots (or shares), at least one, as the web sizes them (:955-958). */
const wholeQty = (qty: number) => Math.max(1, Math.floor(qty || 1))

/**
 * A ticket from link presets. A product the segment doesn't offer becomes its default; a
 * derivative's quantity, given in units, becomes the nearest whole number of lots.
 */
export function initialTicket(p: TicketParams, meta: InstrumentMeta): TicketState {
  const t: TicketState = {
    exchange: p.exchange,
    symbol: p.symbol,
    action: p.action,
    product:
      p.product && productOptionsFor(p.exchange).includes(p.product)
        ? p.product
        : defaultProduct(p.exchange),
    // a stop link names a trigger and no type: it is an SL
    pricetype: p.pricetype ?? (p.trigger === undefined ? 'MARKET' : 'SL'),
    qty:
      p.quantity === undefined
        ? 1
        : usesLots(p.exchange)
          ? Math.max(1, Math.round(p.quantity / meta.lotsize))
          : p.quantity,
  }
  if (p.price !== undefined) t.price = snap(p.price, meta)
  if (p.trigger !== undefined) t.trigger = snap(p.trigger, meta)
  return t
}

/** The quantity the order carries, in units: lots × lot size on a derivative. */
export function ticketUnits(t: TicketState, meta: PlanMeta): number {
  const n = wholeQty(t.qty)
  return usesLots(t.exchange) ? n * meta.lotsize : n
}

/**
 * The order as it would be sent: prices on the tick and only the fields its type carries.
 * Above a freeze limit over 1 (:7080, :2223) it is split into children of the largest whole
 * number of lots within the limit, the last child taking the rest.
 */
export function planOrder(t: TicketState, meta: PlanMeta): OrderPlan {
  const spec: OrderSpec = {
    exchange: t.exchange,
    symbol: t.symbol,
    action: t.action,
    quantity: ticketUnits(t, meta),
    pricetype: t.pricetype,
    product: t.product,
    price: hasPrice(t.pricetype) ? sent(t.price, meta) : 0,
    trigger_price: hasTrigger(t.pricetype) ? sent(t.trigger, meta) : 0,
  }
  const freeze = meta.freezeQty
  if (!(freeze > 1 && spec.quantity > freeze)) return { kind: 'single', spec }

  const splitsize = Math.max(meta.lotsize, Math.floor(freeze / meta.lotsize) * meta.lotsize)
  // split_order_service.py:203-205: full children, then the remainder.
  const full = Math.floor(spec.quantity / splitsize)
  const rest = spec.quantity - full * splitsize
  const orders = full + (rest > 0 ? 1 : 0)
  const children: number[] = []
  if (orders <= MAX_SPLIT_ORDERS) {
    for (let i = 0; i < full; i++) children.push(splitsize)
    if (rest > 0) children.push(rest)
  }
  return { kind: 'split', spec, splitsize, orders, children }
}

/** :2229-2233: a BUY stop must trigger above LTP, a SELL stop below it. */
const wrongSide = (action: Side, trigger: number, ltp: number) =>
  action === 'BUY' ? trigger <= ltp : trigger >= ltp

/**
 * What stops the ticket going to review. A quote-only or unlisted instrument is reported
 * alone; nothing else about the ticket matters then. Prices are checked as `planOrder` sends
 * them, on the tick, so one that snaps to 0 is refused. The stop side is checked only with a
 * known LTP, and a split only when the quantity is valid.
 */
export function validateTicket(
  t: TicketState,
  meta: InstrumentMeta | 'unknown',
  ltp: number | undefined,
  { splitAvailable }: { splitAvailable: boolean },
): TicketIssue[] {
  if (isQuoteOnly(t.exchange)) return ['quote_only']
  if (meta === 'unknown') return ['unknown_instrument']

  const issues: TicketIssue[] = []
  if (!productOptionsFor(t.exchange).includes(t.product)) issues.push('product')
  const qtyOk = Number.isInteger(t.qty) && t.qty >= 1
  if (!qtyOk) issues.push('qty')
  if (hasPrice(t.pricetype) && !positive(sent(t.price, meta))) issues.push('price_required')
  if (hasTrigger(t.pricetype)) {
    const trigger = sent(t.trigger, meta)
    if (!positive(trigger)) issues.push('trigger_required')
    else if (positive(ltp) && wrongSide(t.action, trigger, ltp)) issues.push('stop_side')
  }
  if (qtyOk) {
    const plan = planOrder(t, meta)
    if (plan.kind === 'split') {
      if (!splitAvailable) issues.push('split_unavailable')
      else if (plan.orders > MAX_SPLIT_ORDERS) issues.push('split_too_large')
    }
  }
  return issues
}

/** What `issueText` reads: the same ticket, instrument and LTP the issue came from. */
export type IssueContext = { ticket: TicketState; meta: InstrumentMeta | 'unknown'; ltp?: number }

export function issueText(issue: TicketIssue, { ticket, meta, ltp }: IssueContext): string {
  switch (issue) {
    case 'quote_only':
      return QUOTE_ONLY_COPY
    case 'unknown_instrument':
      return "This symbol isn't on the server's list (expired or misspelt)."
    case 'qty':
      return 'Enter a quantity of at least 1.'
    case 'price_required':
      return 'Enter a price above 0.'
    case 'trigger_required':
      return 'Enter a trigger price above 0.'
    case 'stop_side': {
      const px = fmtTick(ltp ?? 0, meta === 'unknown' ? undefined : meta.tick, ltp ?? 0)
      return ticket.action === 'BUY'
        ? `BUY stop must be above LTP ${px}.`
        : `SELL stop must be below LTP ${px}.`
    }
    case 'product':
      return `${ticket.product} isn't available on ${ticket.exchange}.`
    case 'split_too_large': {
      const plan = meta === 'unknown' ? undefined : planOrder(ticket, meta)
      const n = plan?.kind === 'split' ? plan.orders : 1
      return `This needs ${fmtQty(n)} orders; OpenAlgo splits into 100 at most. Reduce the quantity.`
    }
    case 'split_unavailable': {
      const freeze = meta === 'unknown' ? 0 : meta.freezeQty
      return `Above the freeze limit of ${fmtQty(freeze)}. Reduce the quantity.`
    }
  }
}

/**
 * The one-line order, in the web's format (:2263-2264), built from what `planOrder` sends:
 * `BUY LIMIT 2L (130) NIFTY30DEC26FUT @ 24,117.30 · NRML`. SL also shows its trigger, which the
 * web's single stop price leaves implicit; SL-M's price is its trigger.
 */
export function ticketSummary(t: TicketState, meta: InstrumentMeta): string {
  const { spec } = planOrder(t, meta)
  const units = fmtQty(spec.quantity)
  const size = usesLots(t.exchange) ? `${fmtQty(wholeQty(t.qty))}L (${units})` : units
  const px = (n: number) => fmtTick(n, meta.tick, n)
  const at =
    spec.pricetype === 'LIMIT'
      ? ` @ ${px(spec.price)}`
      : spec.pricetype === 'SL'
        ? ` @ ${px(spec.price)} trigger ${px(spec.trigger_price)}`
        : spec.pricetype === 'SL-M'
          ? ` @ ${px(spec.trigger_price)}`
          : ''
  return `${spec.action} ${spec.pricetype} ${size} ${spec.symbol}${at} · ${spec.product}`
}
