// The four books (contract C6). A book is read row by row: a row without the fields that
// identify it is dropped and counted, an unreadable optional field is left unset (shown as
// `--`), and the rest of the book still renders (Review Focus 4).
import { z } from 'zod'
import { dmyHms, num, optNum, str } from '~/core/http/coerce'
import { envelope } from '~/core/http/schemas'

/** A field a row cannot do without: a non-blank string, or a number as its digits. */
const text = str.refine((s) => s.trim() !== '', 'blank')
/**
 * An order id. A number becomes a string, since modify and cancel take fields.Str. It must be a
 * safe integer: past 2^53 the JSON parse has already rounded it (9007199254740993 reads as
 * …992), so its digits are another order's, and a cancel or modify would target that one.
 */
export const orderId = z
  .union([z.string(), z.number().refine(Number.isSafeInteger, 'not a safe integer')])
  .pipe(text)
/** A text field the row can do without: absent or unreadable is `''`. */
const optText = str.catch('')
/** A number the row can do without: absent, `''`, null or unreadable is unset. */
const optValue = optNum.catch(undefined).optional()
const side = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(['BUY', 'SELL']))

/** Parses an array row by row: the rows that parse, and how many did not. Absent is empty. */
export const lenientRows = <T extends z.ZodType>(row: T) =>
  z
    .array(z.unknown())
    .nullish()
    .transform((items) => {
      const rows: z.output<T>[] = []
      let dropped = 0
      for (const item of items ?? []) {
        const r = row.safeParse(item)
        if (r.success) rows.push(r.data)
        else dropped++
      }
      return { rows, dropped }
    })

const OrderRow = z
  .object({
    orderid: orderId,
    symbol: text,
    exchange: text,
    action: side,
    product: optText,
    pricetype: optText,
    quantity: num,
    price: optValue,
    trigger_price: optValue,
    order_status: optText,
    timestamp: optText,
  })
  .transform(({ order_status, ...r }) => ({
    ...r,
    /** Lowercased and trimmed, each run of spaces or underscores one space: Firstock sends
     *  `trigger_pending` (stock server broker/firstock/mapping/order_data.py:167-168). */
    status: order_status
      .replace(/[\s_]+/g, ' ')
      .trim()
      .toLowerCase(),
    /** Epoch ms of an `08-Apr-2025 13:58:03` IST timestamp; null for any other format. */
    placedAt: dmyHms(r.timestamp),
  }))

const TradeRow = z.object({
  orderid: orderId,
  symbol: text,
  exchange: text,
  action: side,
  product: optText,
  quantity: num,
  average_price: optValue,
  trade_value: optValue,
  /** `13:58:03`, IST. */
  timestamp: optText,
})

const PositionRow = z.object({
  symbol: text,
  exchange: text,
  product: text,
  quantity: num,
  average_price: optValue,
  ltp: optValue,
  pnl: optValue,
  pnlpercent: optValue,
  lot_size: optValue,
  today_realized_pnl: optValue,
})

const HoldingRow = z.object({
  symbol: text,
  exchange: text,
  product: text,
  quantity: num,
  pnl: optValue,
  pnlpercent: optValue,
  ltp: optValue,
  average_price: optValue,
})

const OrderStats = z
  .object({
    total_buy_orders: optValue,
    total_sell_orders: optValue,
    total_completed_orders: optValue,
    total_open_orders: optValue,
    total_rejected_orders: optValue,
  })
  .catch({})

const HoldingStats = z
  .object({
    totalholdingvalue: optValue,
    totalinvvalue: optValue,
    totalprofitandloss: optValue,
    totalpnlpercentage: optValue,
  })
  .catch({})

export const OrderbookSchema = envelope(
  z.object({ orders: lenientRows(OrderRow), statistics: OrderStats }),
).transform((d) => ({ orders: d.orders.rows, stats: d.statistics, dropped: d.orders.dropped }))

/** The tradebook and positionbook carry no statistics (C6). */
export const TradebookSchema = envelope(lenientRows(TradeRow))
export const PositionbookSchema = envelope(lenientRows(PositionRow))

export const HoldingsSchema = envelope(
  z.object({ holdings: lenientRows(HoldingRow), statistics: HoldingStats }),
).transform((d) => ({
  rows: d.holdings.rows,
  stats: d.statistics,
  dropped: d.holdings.dropped,
}))

/** The statuses an order can still fill or be cancelled from (C6). */
export const WORKING: readonly string[] = ['open', 'pending', 'trigger pending']

export const isWorking = (row: Pick<OrderRow, 'status'>) => WORKING.includes(row.status)

export type OrderRow = z.output<typeof OrderRow>
export type TradeRow = z.output<typeof TradeRow>
export type PositionRow = z.output<typeof PositionRow>
export type HoldingRow = z.output<typeof HoldingRow>
export type OrderStats = z.output<typeof OrderStats>
export type HoldingStats = z.output<typeof HoldingStats>
export type Orderbook = z.output<typeof OrderbookSchema>
export type Tradebook = z.output<typeof TradebookSchema>
export type Positionbook = z.output<typeof PositionbookSchema>
export type Holdings = z.output<typeof HoldingsSchema>
