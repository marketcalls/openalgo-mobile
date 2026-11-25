// The order endpoints' wire format: the request bodies (contract C3) and the replies (C4).
// The client adds the apikey to every body, and a reply reaches these schemas only after the
// client has classified it a success.
import { z } from 'zod'
import { int, num } from '~/core/http/coerce'
import { envelope } from '~/core/http/schemas'
import { type OrderRow, orderId, type PositionRow } from '../books/schemas'
import type { PriceType, Product, Side } from '../types'

// --- Requests --------------------------------------------------------------------------

/** The strategy label on every order write (design 7.10). */
const STRATEGY = 'mobile'

export type OrderSpec = {
  exchange: string
  symbol: string
  action: Side
  /** In units, and whole: 2.0.0.0 types it Int (C3). */
  quantity: number
  pricetype: PriceType
  product: Product
  price: number
  trigger_price: number
}

/** What modify can change; every other field is the row's own. */
export type ModifyChange = Partial<
  Pick<OrderSpec, 'quantity' | 'pricetype' | 'price' | 'trigger_price'>
>

/** C9: MARKET carries no price and SL-M only the trigger; LIMIT the price; SL both. Unsent is 0. */
function priceFields(pricetype: string, price: number, trigger: number) {
  return {
    price: pricetype === 'MARKET' || pricetype === 'SL-M' ? 0 : price,
    trigger_price: pricetype === 'SL' || pricetype === 'SL-M' ? trigger : 0,
  }
}

export function placeBody(o: OrderSpec) {
  return {
    strategy: STRATEGY,
    exchange: o.exchange,
    symbol: o.symbol,
    action: o.action,
    quantity: o.quantity,
    pricetype: o.pricetype,
    product: o.product,
    ...priceFields(o.pricetype, o.price, o.trigger_price),
    disclosed_quantity: 0,
  }
}

/** The server splits the order into children of `size` units, the last one smaller. */
export const splitBody = (o: OrderSpec, size: number) => ({ ...placeBody(o), splitsize: size })

export type PositionToClose = Pick<PositionRow, 'symbol' | 'exchange' | 'product' | 'quantity'>

/** Closes one net position at market: position_size 0 for the row's own product. */
export function smartCloseBody(row: PositionToClose) {
  return {
    strategy: STRATEGY,
    exchange: row.exchange,
    symbol: row.symbol,
    product: row.product,
    // The closing side. The server works the side out from position_size and ignores this.
    action: row.quantity > 0 ? 'SELL' : 'BUY',
    quantity: '0',
    position_size: '0',
    pricetype: 'MARKET',
    price: '0',
    trigger_price: '0',
    disclosed_quantity: '0',
  }
}

/** All twelve fields are required (with the apikey); the row has no disclosed quantity, so 0. */
export function modifyBody(row: OrderRow, change: ModifyChange) {
  const pricetype = change.pricetype ?? row.pricetype
  return {
    orderid: row.orderid,
    strategy: STRATEGY,
    symbol: row.symbol,
    action: row.action,
    exchange: row.exchange,
    pricetype,
    product: row.product,
    quantity: change.quantity ?? row.quantity,
    ...priceFields(
      pricetype,
      change.price ?? row.price ?? 0,
      change.trigger_price ?? row.trigger_price ?? 0,
    ),
    disclosed_quantity: 0,
  }
}

export const cancelBody = (orderid: string) => ({ orderid, strategy: STRATEGY })

/** Cancel all and close all take the strategy only; any other field gets a 400. */
export const cancelAllBody = () => ({ strategy: STRATEGY })
export const closeAllBody = () => ({ strategy: STRATEGY })

/** One position. Quantity and the prices are fields.Str, so a number gets a 400. */
export function marginBody(o: OrderSpec) {
  const { price, trigger_price } = priceFields(o.pricetype, o.price, o.trigger_price)
  return {
    positions: [
      {
        symbol: o.symbol,
        exchange: o.exchange,
        action: o.action,
        quantity: String(o.quantity),
        product: o.product,
        pricetype: o.pricetype,
        price: String(price),
        trigger_price: String(trigger_price),
      },
    ],
  }
}

// --- Replies ---------------------------------------------------------------------------

const success = z.literal('success')
/** `'analyze'` when the sandbox answered. */
const mode = z.unknown().optional()

/** Semi-Auto routes place, smart and split orders to the web Action Center, in either mode. */
const Queued = z
  .object({ status: success, mode: z.literal('semi_auto'), pending_order_id: orderId })
  .transform((r) => ({ kind: 'queued' as const, pendingId: r.pending_order_id }))

const Placed = z.object({ status: success, orderid: orderId, mode }).transform((r) => ({
  kind: 'placed' as const,
  orderid: r.orderid,
  analyze: r.mode === 'analyze',
}))

/** A success without an order id: the order may exist, so the caller checks the book. */
const NoId = z.object({ status: success }).transform(() => ({ kind: 'no_id' as const }))

export const PlaceReplySchema = z.union([Queued, Placed, NoId])

const SplitChild = z
  .object({
    order_num: int,
    quantity: num,
    status: z.string(),
    orderid: orderId.optional().catch(undefined),
    message: z.string().optional().catch(undefined),
  })
  .transform((c) => ({
    n: c.order_num,
    qty: c.quantity,
    ok: c.status === 'success',
    orderid: c.orderid,
    message: c.message,
  }))

const Split = z
  .object({
    status: success,
    total_quantity: num,
    split_size: num,
    results: z.array(SplitChild),
    mode,
  })
  .transform((r) => ({
    kind: 'split' as const,
    total: r.total_quantity,
    size: r.split_size,
    children: r.results,
    analyze: r.mode === 'analyze',
  }))

export const SplitReplySchema = z.union([Queued, Split])

/** A close of a position that is already flat (place_smart_order_service.py:227, sandbox:508). */
const Flat = z
  .object({ status: success, message: z.string().regex(/Already Matched|No OpenPosition/i) })
  .transform((r) => ({ kind: 'flat' as const, message: r.message }))

/**
 * The service answers `{status:'success', orderid: null}` when the adapter returns 200 without an
 * id (place_smart_order_service.py:240-241), so a success that is neither placed nor flat is
 * no_id: the close may have gone, and the caller checks the positions.
 */
export const SmartReplySchema = z.union([Queued, Placed, Flat, NoId])

/** Modify and cancel echo the order id. */
const Echoed = z.object({ status: success, orderid: orderId, mode }).transform((r) => ({
  kind: 'ok' as const,
  orderid: r.orderid,
  analyze: r.mode === 'analyze',
}))

/** A success whose id is null, missing or unreadable is no_id: the caller checks the book. */
export const IdReplySchema = z.union([Echoed, NoId])

/**
 * A list the reply always sends (cancel_all_order_service.py:166-172), read item by item: an
 * unreadable item (a null, say) is skipped and the readable ones are kept.
 */
const readable = <T extends z.ZodType>(item: T) =>
  z.array(z.unknown()).transform((items) =>
    items.flatMap((x) => {
      const r = item.safeParse(x)
      return r.success ? [r.data] : []
    }),
  )

/** A failure is a bare id, or (in the sandbox) `{orderid, message}`. */
const FailedCancel = z.union([
  orderId.transform((id) => ({ orderid: id })),
  z.object({ orderid: orderId, message: z.string().optional().catch(undefined) }),
])

export const CancelAllReplySchema = z
  .object({
    status: success,
    canceled_orders: readable(orderId),
    failed_cancellations: readable(FailedCancel),
  })
  .transform((r) => ({ canceled: r.canceled_orders, failed: r.failed_cancellations }))

export const CloseAllReplySchema = z
  .object({ status: success, message: z.string() })
  .transform((r) => ({ message: r.message }))

export const MarginSchema = envelope(z.object({ total_margin_required: num })).transform((d) => ({
  total: d.total_margin_required,
}))

export type PlaceReply = z.output<typeof PlaceReplySchema>
export type SplitReply = z.output<typeof SplitReplySchema>
export type SplitChild = z.output<typeof SplitChild>
export type SmartReply = z.output<typeof SmartReplySchema>
export type IdReply = z.output<typeof IdReplySchema>
export type CancelAllReply = z.output<typeof CancelAllReplySchema>
export type CloseAllReply = z.output<typeof CloseAllReplySchema>
export type Margin = z.output<typeof MarginSchema>
