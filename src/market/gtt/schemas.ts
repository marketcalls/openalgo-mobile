// The GTT endpoints' wire format: the request bodies (G2), the write replies (G3) and the book
// (G4). The client adds the apikey to every body, and a reply reaches these schemas only after
// the client has classified it a success.
import { z } from 'zod'
import { num } from '~/core/http/coerce'
import { lenientRows, optText, optValue, orderId, side } from '../books/schemas'
import { NoIdReply, QueuedReply, STRATEGY } from '../orders/schemas'
import type { Side } from '../types'

export type GttType = 'SINGLE' | 'OCO'

// --- Requests --------------------------------------------------------------------------

/**
 * A GTT to place, or the full replacement a modify sends (G2). The limit order each trigger
 * places is a LIMIT at `price`. An OCO's stop-loss trigger is below its target's.
 */
export type GttSpec = {
  exchange: string
  symbol: string
  action: Side
  /** G2: MIS is refused, since a GTT outlives the day. */
  product: 'CNC' | 'NRML'
  /** In units. */
  quantity: number
} & (
  | {
      type: 'SINGLE'
      trigger: number
      price: number
      /** The trigger is above the LTP, so it must fire on a rise (RF 6). */
      above: boolean
    }
  | {
      type: 'OCO'
      sl: { trigger: number; price: number }
      tg: { trigger: number; price: number }
    }
)

export function gttPlaceBody(s: GttSpec) {
  const common = {
    strategy: STRATEGY,
    trigger_type: s.type,
    exchange: s.exchange,
    symbol: s.symbol,
    action: s.action,
    product: s.product,
    quantity: s.quantity,
    pricetype: 'LIMIT',
  }
  if (s.type === 'SINGLE') {
    // The sandbox fires `triggerprice_sl` on a fall and `triggerprice_tg` on a rise (G2), so a
    // trigger in the wrong field would fire on the next tick. The other one is 0.
    return {
      ...common,
      price: s.price,
      triggerprice_sl: s.above ? 0 : s.trigger,
      triggerprice_tg: s.above ? s.trigger : 0,
    }
  }
  // The broker mappers ignore `price` for an OCO, but the schema requires it.
  return {
    ...common,
    price: s.sl.price,
    triggerprice_sl: s.sl.trigger,
    stoploss: s.sl.price,
    triggerprice_tg: s.tg.trigger,
    target: s.tg.price,
  }
}

export const gttModifyBody = (triggerId: string, s: GttSpec) => ({
  trigger_id: triggerId,
  ...gttPlaceBody(s),
})

export const gttCancelBody = (triggerId: string) => ({ strategy: STRATEGY, trigger_id: triggerId })

// --- Replies ---------------------------------------------------------------------------

/** Place, modify and cancel echo the trigger id; the sandbox adds `mode:'analyze'` (G3). */
const Ok = z
  .object({ status: z.literal('success'), trigger_id: orderId, mode: z.unknown().optional() })
  .transform((r) => ({
    kind: 'ok' as const,
    triggerId: r.trigger_id,
    analyze: r.mode === 'analyze',
  }))

/** A Semi-Auto place is queued (G3); a success without a readable id is no_id. */
export const GttReplySchema = z.union([QueuedReply, Ok, NoIdReply])

export type GttReply = z.output<typeof GttReplySchema>

// --- The book --------------------------------------------------------------------------

export type GttLeg = {
  action: Side
  quantity: number
  price: number
  pricetype: string
  product: string
  /** The leg's own trigger, when the row lists one trigger per leg. */
  trigger?: number
  /** The order the leg placed when it fired (the sandbox's `triggered_order_id`). */
  orderId?: string
}

export type GttRow = {
  triggerId: string
  type: GttType
  /** Lower-cased: active, triggered, cancelled, …, or the broker's own word. */
  status: string
  symbol: string
  exchange: string
  /** Ascending. */
  triggers: number[]
  lastPrice?: number
  /** With their triggers, in ascending trigger order, so an OCO's stop-loss leg is first. */
  legs: GttLeg[]
  createdAt: string
  expiresAt: string
}

const GttLegSchema = z.object({
  action: side,
  quantity: num,
  price: num,
  pricetype: optText,
  product: optText,
  triggered_order_id: orderId.optional().catch(undefined),
})

/** Kite's (and the sandbox's) `two-leg`, or another broker's `OCO`; anything else is SINGLE. */
const OCO_TYPE = /^(two-leg|oco)$/i

/**
 * Whether two legs priced `p0`, `p1` sit nearer the triggers `t0`, `t1` swapped than as listed:
 * |p0 - t1| + |p1 - t0| < |p0 - t0| + |p1 - t1|.
 *
 * Summing doubles can split a tie by a rounding error. Limits 1175.95 and 1020.35 against
 * triggers 1183.75 and 2222.25 total 1209.70 both ways, but the doubles give 1209.6999999999998
 * swapped and 1209.7 as listed. So the inequality is decided by comparisons alone:
 * - Take limits a < b and triggers c < d. The crossed pairing (a with d, b with c) totals more
 *   than the sorted one (a with c, b with d) by f(b) - f(a), where f(x) = |x - c| - |x - d|.
 * - f is flat at or below c, flat at or above d, and strictly rising between.
 * - So the swap is strictly nearer exactly when the row's own pairing crosses (the higher limit on
 *   the lower trigger) and the two limits do not both lie at or beyond the same end of the
 *   triggers' span.
 * - Equal limits, or equal triggers, tie.
 */
function swapIsNearer(p0: number, p1: number, t0: number, t1: number) {
  const crossed = (p0 < p1 && t0 > t1) || (p0 > p1 && t0 < t1)
  const sameEnd = Math.max(p0, p1) <= Math.min(t0, t1) || Math.min(p0, p1) >= Math.max(t0, t1)
  return crossed && !sameEnd
}

/**
 * The trigger each leg goes with, when the row lists one trigger per leg (RF 3).
 * - Leg i takes trigger i, except on a two-leg row, which takes whichever pairing (as listed, or
 *   swapped) puts the limits nearer their triggers in total (`swapIsNearer`). On a tie it keeps
 *   the row's order.
 * - That holds for every broker, and it is what Fyers needs: its mapper lists the target leg first
 *   but sorts the triggers on their own (c8b2896 broker/fyers/mapping/gtt_data.py:215-226). Read
 *   as listed, that would put the target's limit on the stop-loss trigger.
 * - Brokers that list the legs in trigger order (Zerodha, and every other mapper) keep their rows
 *   as listed whenever the limits can fill, a SELL at or below its trigger and a BUY at or above.
 *   Such a pairing either does not cross, or has both limits beyond the same end, which ties.
 */
function legTriggers(prices: readonly number[], triggers: readonly number[]) {
  if (prices.length !== triggers.length) return prices.map(() => undefined)
  if (prices.length !== 2) return [...triggers]
  const [p0 = 0, p1 = 0] = prices
  const [t0 = 0, t1 = 0] = triggers
  return swapIsNearer(p0, p1, t0, t1) ? [t1, t0] : [t0, t1]
}

/**
 * One row in any broker's shape (RF 3): the trigger id is the only field it cannot do without.
 * Each leg takes its own trigger (`legTriggers`), so an OCO whose legs come in another order
 * still pairs each leg with its own trigger; then both sort by trigger.
 */
const GttRowSchema = z
  .object({
    trigger_id: orderId,
    trigger_type: optText,
    status: optText,
    symbol: optText,
    exchange: optText,
    trigger_prices: z.array(num).nullish(),
    last_price: optValue,
    legs: z.array(GttLegSchema).nullish(),
    created_at: optText,
    expires_at: optText,
  })
  .transform((r): GttRow => {
    const triggers = r.trigger_prices ?? []
    const given = r.legs ?? []
    const paired = given.length === triggers.length
    const own = legTriggers(
      given.map((l) => l.price),
      triggers,
    )
    const legs = given.map(
      (l, i): GttLeg => ({
        action: l.action,
        quantity: l.quantity,
        price: l.price,
        pricetype: l.pricetype,
        product: l.product,
        trigger: own[i],
        orderId: l.triggered_order_id,
      }),
    )
    if (paired) legs.sort((a, b) => (a.trigger ?? 0) - (b.trigger ?? 0))
    return {
      triggerId: r.trigger_id,
      type: OCO_TYPE.test(r.trigger_type.trim()) ? 'OCO' : 'SINGLE',
      status: r.status.trim().toLowerCase(),
      symbol: r.symbol,
      exchange: r.exchange,
      triggers: [...triggers].sort((a, b) => a - b),
      lastPrice: r.last_price,
      legs,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }
  })

/** The book row by row; the sandbox tags the envelope, not the rows, with `mode` (G3). */
export const GttBookSchema = z
  .object({
    status: z.literal('success'),
    data: lenientRows(GttRowSchema),
    mode: z.unknown().optional(),
  })
  .transform((b) => ({ ...b.data, analyze: b.mode === 'analyze' }))

export type GttBook = z.output<typeof GttBookSchema>
