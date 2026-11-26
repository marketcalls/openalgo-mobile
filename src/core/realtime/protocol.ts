import { z } from 'zod'

export type Mode = 1 | 2 | 3
export type DepthLevels = 5 | 20 | 30

export const quoteKey = (exchange: string, symbol: string): string => `${exchange}:${symbol}`

/** Numbers may arrive as strings; anything unreadable becomes absent rather than failing the frame. */
const num = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number().finite(),
  )
  .optional()
  .catch(undefined)

const str = z
  .preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string())
  .optional()
  .catch(undefined)

const reqNum = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().finite(),
)

const LevelSchema = z.object({ price: reqNum, quantity: reqNum.catch(0), orders: num })
const levels = z
  .array(LevelSchema.nullable().catch(null))
  .catch([])
  .transform((a) => a.filter((l) => l !== null))

const TickDataSchema = z.object({
  ltp: num,
  open: num,
  high: num,
  low: num,
  close: num,
  volume: num,
  oi: num,
  average_price: num,
  bid: num,
  ask: num,
  total_buy_quantity: num,
  total_sell_quantity: num,
  depth: z.object({ buy: levels, sell: levels }).optional().catch(undefined),
})
export type TickData = z.infer<typeof TickDataSchema>

const OrderUpdateSchema = z.object({
  user_id: str,
  mode: str,
  broker: str,
  orderid: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string()),
  symbol: str,
  exchange: str,
  action: str,
  quantity: num,
  price: num,
  trigger_price: num,
  pricetype: str,
  product: str,
  order_status: str,
  filled_quantity: num,
  pending_quantity: num,
  average_price: num,
  rejection_reason: str,
})

const Frame = z.looseObject({ type: z.string().optional(), status: z.string().optional() })

const Entry = z.looseObject({
  symbol: z.string(),
  exchange: z.string(),
  status: z.string().optional(),
  depth: num,
})

export type Inbound =
  | { t: 'auth_ok'; broker?: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'sub_ack'; entries: { symbol: string; exchange: string; ok: boolean; depth?: number }[] }
  | { t: 'unsub_ack'; status: string }
  | { t: 'tick'; symbol: string; exchange: string; mode: number; data: TickData }
  | { t: 'orders_ack' }
  | ({ t: 'order_update' } & z.infer<typeof OrderUpdateSchema>)
  | { t: 'pong' }
export type OrderUpdate = Extract<Inbound, { t: 'order_update' }>

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Parses one server frame. Anything unknown or malformed gives null. */
export const parseInbound = (raw: string): Inbound | null => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const f = Frame.safeParse(json)
  if (!f.success) return null
  const m = f.data
  switch (m.type) {
    case 'auth':
      return m.status === 'success' || m.status === undefined
        ? { t: 'auth_ok', ...(typeof m.broker === 'string' ? { broker: m.broker } : {}) }
        : { t: 'error', code: asString(m.code), message: asString(m.message) }
    case 'subscribe': {
      const list = Array.isArray(m.subscriptions) ? m.subscriptions : []
      const entries: Extract<Inbound, { t: 'sub_ack' }>['entries'] = []
      for (const e of list) {
        const p = Entry.safeParse(e)
        if (!p.success) continue
        entries.push({
          symbol: p.data.symbol,
          exchange: p.data.exchange,
          ok: p.data.status === 'success',
          ...(p.data.depth !== undefined ? { depth: p.data.depth } : {}),
        })
      }
      return { t: 'sub_ack', entries }
    }
    case 'unsubscribe':
      return { t: 'unsub_ack', status: m.status ?? '' }
    case 'subscribe_orders':
      return { t: 'orders_ack' }
    case 'pong':
      return { t: 'pong' }
    case 'market_data': {
      if (typeof m.symbol !== 'string' || typeof m.exchange !== 'string') return null
      const data = TickDataSchema.safeParse(m.data)
      if (!data.success) return null
      const mode = typeof m.mode === 'number' ? m.mode : Number(m.mode)
      return {
        t: 'tick',
        symbol: m.symbol,
        exchange: m.exchange,
        mode: Number.isFinite(mode) ? mode : 0,
        data: data.data,
      }
    }
    case 'order_update': {
      const o = OrderUpdateSchema.safeParse(m)
      return o.success ? { t: 'order_update', ...o.data } : null
    }
    case undefined:
      return m.status === 'error'
        ? { t: 'error', code: asString(m.code), message: asString(m.message) }
        : null
    default:
      return null
  }
}

// --- Outbound builders (S11, byte for byte) ---

export type SymbolPair = { symbol: string; exchange: string }

export const authMsg = (apiKey: string): string =>
  JSON.stringify({ action: 'authenticate', api_key: apiKey })

export const subscribeMsg = (pairs: SymbolPair[], mode: Mode, depth?: DepthLevels): string =>
  JSON.stringify({
    action: 'subscribe',
    symbols: pairs.map((p) => ({ symbol: p.symbol, exchange: p.exchange })),
    mode,
    ...(mode === 3 ? { depth: depth ?? 5 } : {}),
  })

/** The numeric mode rides on each symbol: 2.0.0.0 matches on it and defaults to 2. */
export const unsubscribeMsg = (pairs: SymbolPair[], mode: Mode): string =>
  JSON.stringify({
    action: 'unsubscribe',
    symbols: pairs.map((p) => ({ symbol: p.symbol, exchange: p.exchange, mode })),
    mode,
  })

export const subscribeOrdersMsg = (): string => JSON.stringify({ action: 'subscribe_orders' })
export const pingMsg = (): string => JSON.stringify({ action: 'ping' })

// --- Patches and quotes ---

export type DepthLevel = { price: number; quantity: number; orders?: number }
/** `levels` is the larger side's count of priced rows. */
export type DepthBook = { buy: DepthLevel[]; sell: DepthLevel[]; levels: number }

export type QuotePatch = {
  ltp?: number
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  oi?: number
  avgPrice?: number
  bid?: number
  ask?: number
  totalBuyQty?: number
  totalSellQty?: number
  depth?: DepthBook
}

export type Quote = QuotePatch & {
  change?: number
  changePct?: number
  ts: number
  dir: 1 | -1 | 0
  source: 'ws' | 'poll' | 'seed'
}

const price = (v: number | undefined): number | undefined =>
  v !== undefined && v > 0 ? v : undefined

const priced = (a: readonly DepthLevel[] | undefined): DepthLevel[] =>
  (a ?? [])
    .filter((l) => l.price > 0)
    .map((l) => (l.orders === undefined ? { price: l.price, quantity: l.quantity } : l))

const book = (buy: DepthLevel[], sell: DepthLevel[]): DepthBook => ({
  buy,
  sell,
  levels: Math.max(buy.length, sell.length),
})

/** Builds a patch holding only the keys with a defined value. */
const compact = (p: QuotePatch): QuotePatch => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v
  return out as QuotePatch
}

export const tickToPatch = (d: TickData): QuotePatch =>
  compact({
    ltp: price(d.ltp),
    open: price(d.open),
    high: price(d.high),
    low: price(d.low),
    close: price(d.close),
    volume: d.volume,
    oi: d.oi,
    avgPrice: price(d.average_price),
    bid: price(d.bid),
    ask: price(d.ask),
    totalBuyQty: d.total_buy_quantity,
    totalSellQty: d.total_sell_quantity,
    depth: d.depth ? book(priced(d.depth.buy), priced(d.depth.sell)) : undefined,
  })

const RestLevels = z.array(LevelSchema.nullable().catch(null)).catch([])
const RestDepth = z.looseObject({
  ltp: num,
  open: num,
  high: num,
  low: num,
  prev_close: num,
  volume: num,
  oi: num,
  totalbuyqty: num,
  totalsellqty: num,
  bids: RestLevels.optional(),
  asks: RestLevels.optional(),
})

const restLevels = (
  a: ({ price: number; quantity: number; orders?: number | undefined } | null)[] | undefined,
) => priced((a ?? []).filter((l) => l !== null) as DepthLevel[])

/** Maps a `/depth` response's data (S2) to a patch. Padding rows (price 0) are dropped. */
export const depthRestToPatch = (d: unknown): QuotePatch => {
  const p = RestDepth.safeParse(d)
  if (!p.success) return {}
  const x = p.data
  return compact({
    ltp: price(x.ltp),
    open: price(x.open),
    high: price(x.high),
    low: price(x.low),
    close: price(x.prev_close),
    volume: x.volume,
    oi: x.oi,
    totalBuyQty: x.totalbuyqty,
    totalSellQty: x.totalsellqty,
    depth: x.bids || x.asks ? book(restLevels(x.bids), restLevels(x.asks)) : undefined,
  })
}

const MultiQuote = z.looseObject({
  ltp: num,
  prev_close: num,
  open: num,
  high: num,
  low: num,
  volume: num,
  oi: num,
  bid: num,
  ask: num,
})

/** Maps one `multiquotes` result's `data` to a patch. */
export const multiquoteToPatch = (d: unknown): QuotePatch => {
  const p = MultiQuote.safeParse(d)
  if (!p.success) return {}
  const x = p.data
  return compact({
    ltp: price(x.ltp),
    close: price(x.prev_close),
    open: price(x.open),
    high: price(x.high),
    low: price(x.low),
    volume: x.volume,
    oi: x.oi,
    bid: price(x.bid),
    ask: price(x.ask),
  })
}
