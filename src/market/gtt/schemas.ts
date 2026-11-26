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
 * One row in any broker's shape (RF 3): the trigger id is the only field it cannot do without.
 * Leg i takes the i-th trigger when there is one per leg, so an OCO whose legs come in another
 * order still pairs each leg with its own trigger; then both sort by trigger.
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
    const paired = r.legs?.length === triggers.length
    const legs = (r.legs ?? []).map(
      (l, i): GttLeg => ({
        action: l.action,
        quantity: l.quantity,
        price: l.price,
        pricetype: l.pricetype,
        product: l.product,
        trigger: paired ? triggers[i] : undefined,
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
