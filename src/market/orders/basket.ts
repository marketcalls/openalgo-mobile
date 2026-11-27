// A multi-leg basket (design 7.10): the basketorder body a tool page holds for review, read
// strictly; the body that goes; the reply; and what came of each leg. The server places the legs
// one by one and answers per leg, so a basket can partly fail. Nothing here sends.
import { z } from 'zod'
import { isRecord } from '~/core/http/errors'
import { quoteKey } from '~/core/realtime/protocol'
import type { JSONValue } from '~/dom/bridge/protocol'
import { orderId, side } from '../books/schemas'
import { ALL_EXCHANGES, isQuoteOnly } from '../instruments/exchanges'
import type { Side } from '../types'
import { NoIdReply, priceFields, QueuedReply } from './schemas'

/**
 * Bounds memory only: the server has no maximum (restx_api/schemas.py:162-176). A tool page's
 * basket is stopped sooner, at about 90 legs, by the bridge's 1,000-node body cap
 * (dom/bridge/schemas.ts).
 */
export const MAX_BASKET_LEGS = 200
/** The app's bound on the strategy name; the server has none. The builder sends a saved name. */
const MAX_STRATEGY = 256
const MAX_SYMBOL = 64

/** The review's warning for 2 or more legs (design 7.10). */
export const LEGGING_RISK =
  'The legs are sent together but fill on their own: one can fill without the other.'

export type BasketLeg = {
  symbol: string
  exchange: string
  action: Side
  /** In units. */
  quantity: number
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  product: 'MIS' | 'NRML' | 'CNC'
  price: number
  trigger_price: number
  disclosed_quantity: number
}

export type BasketSpec = { endpoint: 'basketorder'; strategy: string; legs: BasketLeg[] }

/** utils/constants.py CRYPTO_EXCHANGES: the only exchanges a fractional quantity may go to. */
const CRYPTO_EXCHANGES: ReadonlySet<string> = new Set(['CRYPTO'])
/** The actions BasketOrderItemSchema takes, upper-cased as validate_order does. */
const ACTION = { BUY: 'BUY', buy: 'BUY', SELL: 'SELL', sell: 'SELL' } as const

const nonNegative = z.number().min(0)

/**
 * One leg as BasketOrderItemSchema takes it (restx_api/schemas.py:134-159), with no unknown field
 * (marshmallow refuses one too). The quantity is positive and, outside CRYPTO, whole
 * (`_coerce_quantity_to_int`). The prices and the disclosed quantity default to 0 as there; the
 * type and product never default, so the review shows what the page chose. An index is never
 * traded, whatever VALID_EXCHANGES lists (as a held placeorder).
 */
const LegSchema = z
  .strictObject({
    exchange: z.string().refine((e) => ALL_EXCHANGES.includes(e) && !isQuoteOnly(e)),
    symbol: z.string().min(1).max(MAX_SYMBOL),
    action: z.enum(['BUY', 'SELL', 'buy', 'sell']).transform((a): Side => ACTION[a]),
    quantity: z.number().positive().max(Number.MAX_SAFE_INTEGER),
    pricetype: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']),
    product: z.enum(['MIS', 'NRML', 'CNC']),
    price: nonNegative.default(0),
    trigger_price: nonNegative.default(0),
    disclosed_quantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .refine((l) => CRYPTO_EXCHANGES.has(l.exchange) || Number.isInteger(l.quantity))

/** BasketOrderSchema (restx_api/schemas.py:162-176) without its apikey. */
const HeldBasketSchema = z.strictObject({
  strategy: z.string().min(1).max(MAX_STRATEGY),
  orders: z.array(LegSchema).min(1).max(MAX_BASKET_LEGS),
})

/**
 * The basket a held basketorder carries, or null when it cannot be read: then it is answered
 * without a send. The page's `apikey` placeholder is dropped (the HTTP client adds the real key).
 */
export function parseHeldBasket(body: unknown): BasketSpec | null {
  if (!isRecord(body)) return null
  const { apikey: _placeholder, ...rest } = body
  const r = HeldBasketSchema.safeParse(rest)
  if (!r.success) return null
  return { endpoint: 'basketorder', strategy: r.data.strategy, legs: r.data.orders }
}

/** The body sent, the apikey aside: each leg carries the prices its type does (C9). */
export function basketBody(s: BasketSpec): Record<string, JSONValue> {
  return {
    strategy: s.strategy,
    orders: s.legs.map((l) => ({
      symbol: l.symbol,
      exchange: l.exchange,
      action: l.action,
      quantity: l.quantity,
      pricetype: l.pricetype,
      product: l.product,
      ...priceFields(l.pricetype, l.price, l.trigger_price),
      disclosed_quantity: l.disclosed_quantity,
    })),
  }
}

// --- The reply ---------------------------------------------------------------------------

/**
 * One leg's result. The stock server sends `{symbol, exchange, product, status: 'success',
 * orderid}` or `{symbol, status: 'error', message}`: no action, and no exchange on a failure
 * (basket_order_service.py:144-185, 266-307). `ok` is that status.
 */
export type LegResult = {
  symbol?: string
  exchange?: string
  action?: Side
  ok: boolean
  orderid?: string
  message?: string
}

/** A result without a status it can tell is unreadable: its leg is then missing. */
const LegResultSchema = z
  .object({
    symbol: z.string().optional().catch(undefined),
    exchange: z.string().min(1).optional().catch(undefined),
    action: side.optional().catch(undefined),
    status: z.enum(['success', 'error']),
    orderid: orderId.optional().catch(undefined),
    message: z.string().optional().catch(undefined),
  })
  .transform(({ status, ...r }): LegResult => ({ ...r, ok: status === 'success' }))

const BasketShape = z.object({
  status: z.literal('success'),
  results: z.array(z.unknown()),
  mode: z.unknown().optional(),
})

/**
 * A reply with results: each one read (an unreadable one is skipped), `analyze` from the sandbox
 * tag (C4), and the body as it came, which a held basket answers the page with.
 */
const WithResults = z.unknown().transform((raw, ctx) => {
  const r = BasketShape.safeParse(raw)
  const results = r.success
    ? r.data.results.flatMap((x) => {
        const leg = LegResultSchema.safeParse(x)
        return leg.success ? [leg.data] : []
      })
    : []
  if (!r.success || results.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'no readable result' })
    return z.NEVER
  }
  return {
    kind: 'basket' as const,
    results,
    analyze: r.data.mode === 'analyze',
    raw: raw as JSONValue,
  }
})

/**
 * Semi-Auto queues the whole basket (order_router_service.py); a success with no result it can
 * read is no_id, so the caller checks the book for every leg.
 */
export const BasketReplySchema = z.union([QueuedReply, WithResults, NoIdReply])
export type BasketReply = z.output<typeof BasketReplySchema>

// --- Per leg -----------------------------------------------------------------------------

/** What came of the leg at `leg`, its index in the spec's legs. */
export type LegOutcome = {
  leg: number
  state: 'placed' | 'failed' | 'unclear' | 'missing'
  orderid?: string
  message?: string
}

/** A success without an id may have placed the order, so it is unclear, as no_id is. */
const stateOf = (r: LegResult) => (!r.ok ? 'failed' : r.orderid ? 'placed' : 'unclear')

/** A result could be this leg's: its symbol, and its exchange and action when it names them. */
const fits = (leg: BasketLeg, r: LegResult) =>
  r.symbol === leg.symbol &&
  (r.exchange === undefined || r.exchange === leg.exchange) &&
  (r.action === undefined || r.action === leg.action)

/**
 * Each leg's outcome, in the legs' order. A result names no action and comes in completion
 * order, so it is matched by what it names (`fits`). The legs one result fits are one group, and
 * groups that share a result are one; a group's results are those that fit its legs:
 * - no result: each leg is missing;
 * - as many results as legs, all of one outcome: each leg has it. Only a leg alone gets the
 *   order id, and a failed leg of a group tells each of the group's messages once, since whose
 *   is whose cannot be told;
 * - otherwise each leg is unclear.
 */
export function matchBasketResults(s: BasketSpec, results: readonly LegResult[]): LegOutcome[] {
  const parent = s.legs.map((_, i) => i)
  const root = (i: number): number => {
    const p = parent[i] as number
    if (p === i) return i
    const r = root(p)
    parent[i] = r
    return r
  }
  const fitting = results.map((r) => s.legs.flatMap((leg, i) => (fits(leg, r) ? [i] : [])))
  for (const [first, ...rest] of fitting) {
    if (first === undefined) continue
    for (const i of rest) parent[root(i)] = root(first)
  }

  const legsIn = new Map<number, number>()
  for (let i = 0; i < s.legs.length; i++) legsIn.set(root(i), (legsIn.get(root(i)) ?? 0) + 1)
  const resultsIn = new Map<number, LegResult[]>()
  results.forEach((r, k) => {
    const first = fitting[k]?.[0]
    if (first === undefined) return
    const g = root(first)
    resultsIn.set(g, [...(resultsIn.get(g) ?? []), r])
  })

  return s.legs.map((_, leg): LegOutcome => {
    const g = root(leg)
    const legs = legsIn.get(g) ?? 1
    const rs = resultsIn.get(g) ?? []
    const [one] = rs
    if (!one) return { leg, state: 'missing' }
    const state = stateOf(one)
    if (rs.length !== legs || rs.some((r) => stateOf(r) !== state)) return { leg, state: 'unclear' }
    if (state === 'placed' && legs === 1) return { leg, state, orderid: one.orderid }
    if (state !== 'failed') return { leg, state }
    const message = [...new Set(rs.flatMap((r) => (r.message ? [r.message] : [])))].join('; ')
    return message ? { leg, state, message } : { leg, state }
  })
}

/**
 * The basket's net premium: Σ (SELL +, BUY −) price · quantity, to the paisa. LIMIT and SL legs at
 * their price, SL-M at its trigger, MARKET at its LTP (`ltp` takes a `quoteKey`). `value` is the
 * amount, never negative; `kind` says which way it goes. Null when any leg has no price above 0.
 */
export function netPremium(
  s: BasketSpec,
  ltp: (key: string) => number | undefined,
): { value: number; kind: 'credit' | 'debit' | 'flat' } | null {
  let sum = 0
  for (const l of s.legs) {
    const at =
      l.pricetype === 'MARKET'
        ? ltp(quoteKey(l.exchange, l.symbol))
        : l.pricetype === 'SL-M'
          ? l.trigger_price
          : l.price
    if (at === undefined || !Number.isFinite(at) || at <= 0) return null
    sum += (l.action === 'SELL' ? at : -at) * l.quantity
  }
  const value = Math.round(Math.abs(sum) * 100) / 100
  return { value, kind: value === 0 ? 'flat' : sum > 0 ? 'credit' : 'debit' }
}
