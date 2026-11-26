// What came of an order placement (design 7.10), for the order ticket and the chart's one-tap
// (preflight conflict 9): placed with its id and the sandbox mark, queued for the web Action
// Center, a split's children, or an outcome that may hide a placed order. That one is checked
// against the order book and never sent again (rulings 5); a match the review's book could not
// rule out may be an earlier identical order, and is never reported as this one (ruling 26).
import type { Orderbook } from '../books/schemas'
import type { AnalyzerMode } from './analyzerGate'
import { CHECKING, NOT_CHECKED, settle, sleep } from './outcome'
import { noReplyDelays, reconcilePlacement, reconcileSplit } from './reconcile'
import type { PlaceReply, SplitReply } from './schemas'
import type { Outcome } from './submit'
import type { OrderPlan } from './ticket'
import type { BookSnapshot } from './useReviewBook'

export type SplitPlaced = Extract<SplitReply, { kind: 'split' }>

/**
 * What the order book showed after an unknown outcome; `checked` false when it could not be read.
 * `earlier` when the book could not be read at the review, so a match found may be an earlier
 * identical order rather than this one (ruling 26): it is then never reported as this order.
 */
export type Reconcile =
  | { kind: 'single'; checked: boolean; status: string | null; earlier: boolean }
  | { kind: 'split'; checked: boolean; found: number; of: number; earlier: boolean }

/** `liveSurprise`: the review showed ANALYZE, but the server placed it LIVE (`Outcome`). */
export type TicketResult =
  | { kind: 'placed'; orderid: string; analyze: boolean; liveSurprise?: true }
  | { kind: 'queued' }
  | { kind: 'split'; reply: SplitPlaced; liveSurprise?: true }
  /**
   * It may have gone (MaybePlaced, a 5xx, a success without an id); `check` once the book says.
   * `waitSec`: how long the check may read, when the server may still be sending the order.
   */
  | { kind: 'maybe'; check: Reconcile | null; waitSec?: number }

/** Never "not placed": the server may still be sending it to the broker (design 7.10). */
const NOT_YET =
  'Not in the order book yet. The server may still be sending it, so check the order book before placing it again.'
const MAYBE_EARLIER =
  'A matching order is in the order book, but it may be an earlier one. Check the order book before trying again.'

/** How long the check after no reply reads the book, `sec` seconds in all. */
export const waitText = (sec: number) =>
  `The server may still be sending it to the broker, so this reads the order book for up to ${
    sec >= 90 ? `${Math.round(sec / 60)} minutes` : `${sec} s`
  }.`

/** What the book said after an unknown outcome, in full. */
export function reconcileText(r: Reconcile): string {
  if (!r.checked) return NOT_CHECKED
  if (r.kind === 'split') {
    if (r.earlier && r.found > 0) {
      return `Found ${r.found} of ${r.of} matching orders in the order book, but they may be earlier ones. Check the order book before trying again.`
    }
    return r.found < r.of
      ? `Found ${r.found} of ${r.of} child orders in the order book. The server may still be sending the rest, so check the order book before placing any again.`
      : `Found ${r.found} of ${r.of} child orders in the order book.`
  }
  if (r.status === null) return NOT_YET
  return r.earlier ? MAYBE_EARLIER : `Found in the order book: ${r.status || '--'}`
}

/** After a LIVE order the review showed as ANALYZE, the toast's reason, after what it names. */
const SWITCHED = 'The server switched to LIVE after your review.'

/**
 * The result in one short line, for the toast once the sheet has gone while the order was out
 * (the toast shows one line). It says no more than the sheet would, and never less: a match that
 * may be an earlier order says so, and an order that went LIVE says LIVE first.
 */
export function resultLine(r: TicketResult): string {
  switch (r.kind) {
    case 'placed':
      if (r.liveSurprise) return `LIVE order placed: ${r.orderid}. ${SWITCHED}`
      return `${r.analyze ? 'Sandbox order' : 'Order'} placed: ${r.orderid}`
    case 'queued':
      return 'Order queued in the web Action Center'
    case 'split': {
      const placed = `${r.reply.children.filter((c) => c.ok).length} of ${r.reply.children.length} placed`
      return r.liveSurprise ? `LIVE split order: ${placed}. ${SWITCHED}` : `Split order: ${placed}`
    }
    case 'maybe': {
      const c = r.check
      if (c === null) return CHECKING
      if (!c.checked) return "Couldn't check the order book"
      if (c.kind === 'split') {
        if (c.earlier && c.found > 0) return `Unclear: ${c.found} of ${c.of} matches may be older`
        return c.found < c.of
          ? `Found ${c.found} of ${c.of} child orders; more may follow`
          : `Found ${c.found} of ${c.of} child orders`
      }
      if (c.status === null) return 'Not in the order book yet'
      return c.earlier
        ? 'Unclear: the match may be an older order'
        : `Found in the order book: ${c.status || '--'}`
    }
  }
}

/** When the send went, and what it knew of the book then (`useReviewBook`'s snapshot). */
export type Sent = BookSnapshot & { at: number }

/** What a placement came to, for the screen to tell. */
export type Placement =
  /** It went: placed, queued, or a split's children. */
  | { kind: 'result'; result: Exclude<TicketResult, { kind: 'maybe' }> }
  /**
   * It may have gone: `check` reads the order book (and never rejects); nothing is sent again.
   * `waitSec`: no reply came, so the server may still be sending it and the check reads on longer.
   */
  | { kind: 'unknown'; waitSec?: number; check: () => Promise<Reconcile> }
  | { kind: 'refused'; message: string }
  | { kind: 'semi_auto_blocked'; message: string }
  | { kind: 'mode_changed'; now: AnalyzerMode }
  | { kind: 'cancelled'; message?: string }

/**
 * The send's outcome (`submitOrderAction`) as a placement (`settle`, rulings 5): `maybe`, a
 * Server error from the order endpoint itself and a success without an id may hide a placed
 * order, so the book is checked. `fetchOrders` reads the book with a request of its own, sent
 * after the order and never joined to one sent before it.
 */
export function placementOutcome(
  out: Outcome<PlaceReply | SplitReply>,
  o: {
    plan: OrderPlan
    sent: Sent
    fetchOrders: () => Promise<Orderbook>
    sleep?: (ms: number) => Promise<void>
  },
): Placement {
  const { plan, sent } = o
  const unknown = (noReply: boolean): Placement => {
    // No reply: the server may still be sending it, so the check reads on past its broker timeout.
    const delaysMs = noReply
      ? noReplyDelays(plan.kind === 'split' ? plan.children.length : undefined)
      : undefined
    const check = async (): Promise<Reconcile> => {
      const common = {
        fetchOrders: o.fetchOrders,
        spec: plan.spec,
        sentAt: sent.at,
        knownIds: sent.knownIds,
        sleep: o.sleep ?? sleep,
        delaysMs,
      }
      // Without the review's book, a match may be an earlier identical order (ruling 26).
      const earlier = !sent.complete
      if (plan.kind === 'split') {
        const r = await reconcileSplit({ ...common, children: plan.children }).catch(() => null)
        const found = r?.found.length ?? 0
        return {
          kind: 'split',
          checked: r?.checked ?? false,
          found,
          of: plan.children.length,
          earlier,
        }
      }
      const r = await reconcilePlacement(common).catch(() => null)
      return {
        kind: 'single',
        checked: r?.checked ?? false,
        status: r?.found?.status ?? null,
        earlier,
      }
    }
    if (delaysMs === undefined) return { kind: 'unknown', check }
    return {
      kind: 'unknown',
      waitSec: Math.round(delaysMs.reduce((a, b) => a + b, 0) / 1000),
      check,
    }
  }

  const r = settle(out, plan.kind === 'split' ? 'splitorder' : 'placeorder')
  switch (r.kind) {
    case 'ok': {
      const reply = r.reply
      if (reply.kind === 'no_id') return unknown(false)
      if (reply.kind === 'queued') return { kind: 'result', result: { kind: 'queued' } }
      const live = r.liveSurprise ? { liveSurprise: true as const } : {}
      return {
        kind: 'result',
        result: reply.kind === 'placed' ? { ...reply, ...live } : { kind: 'split', reply, ...live },
      }
    }
    case 'maybe':
      return unknown(r.noReply)
    default:
      return r
  }
}
