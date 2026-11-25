// What came of an order write, as a screen tells it (design 7.10). The ticket, the Orders tab and
// the modify sheet share it, and so can Portfolio's closes (features may not import each other).
// An outcome that may hide the write (`maybe`) is checked against the order book: nothing here
// ever sends a write again.
import type { EndpointId } from '~/core/http/endpoints'
import { ApiError, userMessage } from '~/core/http/errors'
import { fmtQty } from '~/ui/format'
import type { Orderbook, OrderRow } from '../books/schemas'
import type { InstrumentMeta } from '../instruments/meta'
import { fmtTick } from '../instruments/tick'
import type { AnalyzerMode } from './analyzerGate'
import { MODE_LABEL } from './confirmWrite'
import { reconcileRowChange } from './reconcile'
import type { ModifyChange } from './schemas'
import type { Outcome } from './submit'

/** A-T7's copy for MaybePlaced, verbatim (ruling 3); the same for every order endpoint. */
export const CHECKING = userMessage(
  new ApiError({ kind: 'MaybePlaced', status: 0, endpoint: 'placeorder' }),
)
export const NOT_CHECKED = "Couldn't check the order book. Check it before trying again."
export const NOT_IN_BOOK = 'The order is no longer in the order book.'

/** A write behind a confirm found the server in another mode at the send: nothing went. */
export const modeChanged = (now: AnalyzerMode) =>
  `The server is now in ${MODE_LABEL[now]} mode. Nothing was sent.`

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Design 7.10: an analyzer reply shows a sandbox mark, on every outcome a screen tells. */
export const sandboxed = (line: string, analyze: boolean | undefined) =>
  analyze ? `Sandbox · ${line}` : line

export const errorText = (e: unknown) =>
  e instanceof ApiError ? userMessage(e) : 'Something went wrong.'

/** What came of a write, as a screen tells it. */
export type Settled<R> =
  /** `liveSurprise`: the confirm said ANALYZE, but the server took it LIVE (`Outcome`). */
  | { kind: 'ok'; reply: R; liveSurprise?: true }
  /**
   * It may have gone: check the book, never send again. `noReply`: no reply came from the
   * server's order logic (a timeout, a 502, an unreadable reply, a send that threw), so the server
   * may still be sending it to the broker and the check reads on longer (`noReplyDelays`).
   */
  | { kind: 'maybe'; noReply: boolean }
  | { kind: 'refused'; message: string }
  | { kind: 'semi_auto_blocked'; message: string }
  | { kind: 'mode_changed'; now: AnalyzerMode }
  | { kind: 'cancelled'; message?: string }

/**
 * Rulings 5: besides `maybe` (MaybePlaced, or a send that threw), a Server error from the write's
 * own `endpoint` and a success without an id (`unknown`) may hide the write, so both are checked
 * like it. Any other error is refused with its user message.
 */
export function settle<R>(
  out: Outcome<R>,
  endpoint: EndpointId,
  unknown: (reply: R) => boolean = () => false,
): Settled<R> {
  switch (out.kind) {
    case 'done':
      if (unknown(out.reply)) return { kind: 'maybe', noReply: false }
      return out.liveSurprise
        ? { kind: 'ok', reply: out.reply, liveSurprise: true }
        : { kind: 'ok', reply: out.reply }
    case 'error':
      return out.error.kind === 'Server' && out.error.endpoint === endpoint
        ? { kind: 'maybe', noReply: false }
        : { kind: 'refused', message: userMessage(out.error) }
    case 'maybe':
      return { kind: 'maybe', noReply: true }
    default:
      return out
  }
}

/** What a price or quantity reads at: the contract's tick, and its lots when it trades in them. */
export type OrderMeta = Pick<InstrumentMeta, 'tick' | 'lots' | 'lotsize'>

type Terms = { pricetype: string; quantity: number; price?: number; trigger_price?: number }

/**
 * An order's type, quantity and the prices its type carries, in the ticket summary's form (C9):
 * `LIMIT 2L (130) @ 17.00`, `SL 1 @ 17.00 trigger 16.90`, `SL-M 1 @ 16.90`, `MARKET 1`. A value
 * the row could not read shows `--`.
 */
export function orderTerms(t: Terms, meta?: OrderMeta): string {
  const pt = t.pricetype.trim().toUpperCase()
  const px = (n: number | undefined) => (n === undefined ? '--' : fmtTick(n, meta?.tick, n))
  const lots = meta?.lots ? t.quantity / meta.lotsize : Number.NaN
  const qty = Number.isInteger(lots)
    ? `${fmtQty(lots)}L (${fmtQty(t.quantity)})`
    : fmtQty(t.quantity)
  const at =
    pt === 'LIMIT'
      ? ` @ ${px(t.price)}`
      : pt === 'SL'
        ? ` @ ${px(t.price)} trigger ${px(t.trigger_price)}`
        : pt === 'SL-M'
          ? ` @ ${px(t.trigger_price)}`
          : ''
  return `${pt || '--'} ${qty}${at}`
}

/**
 * After a write on one order (a cancel, or a modify with its change as `sent`) whose outcome is
 * unknown: the line saying what the book shows of it. `before` is the order as it was when the
 * write went; the book is read after each of T10's delays (`RECONCILE_DELAYS_MS`) until it shows
 * the order changed or gone. A modify's line shows the order's type, quantity and prices now
 * beside what was sent, so it tells whether the change took. It only reads.
 */
export async function checkOrder(o: {
  readBook: () => Promise<Orderbook>
  before: OrderRow
  sent?: ModifyChange
  meta?: OrderMeta
  /** T10's delays by default; tests pass their own. */
  delaysMs?: readonly number[]
}): Promise<string> {
  const { before, sent, meta } = o
  const r = await reconcileRowChange({
    fetchOrders: o.readBook,
    before,
    sleep,
    delaysMs: o.delaysMs,
  }).catch(() => null)
  if (!r?.checked) return NOT_CHECKED
  const now = r.found
  if (now === null) return NOT_IN_BOOK
  const status = `Order status: ${now.status || '--'}`
  if (!sent) return status
  const asSent: Terms = {
    pricetype: sent.pricetype ?? before.pricetype,
    quantity: sent.quantity ?? before.quantity,
    price: sent.price ?? before.price,
    trigger_price: sent.trigger_price ?? before.trigger_price,
  }
  return `${status} · Now ${orderTerms(now, meta)} · Sent ${orderTerms(asSent, meta)}`
}
