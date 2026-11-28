// A basket's send, behind its review (design 7.10), with the ticket's order safety
// (useConfirmedReview): the review reads the server's mode and, afresh, the order book; confirm
// goes inside the submit guard, holds the new-order scope until the outcome is known (the check
// after an unknown one included), re-reads the mode, asks for biometrics for a live basket when
// that is on, and sends the basket once, never again. The server places the legs one by one and
// answers per leg, so the outcome is per leg: a reply that may hide placed legs (no reply, a
// basketorder Server error, a success with no result) is checked against the order book, leg by
// leg, ignoring every order the book held at the review (Review Focus 1). A reply without the
// sandbox tag after an ANALYZE review is the LIVE danger notice.
import { useCallback, useEffect, useRef, useState } from 'react'
import { log } from '~/core/log/logger'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import type { JSONValue } from '~/dom/bridge/protocol'
import type { Orderbook, OrderRow } from '~/market/books/schemas'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import {
  type BasketReply,
  BasketReplySchema,
  type BasketSpec,
  basketBody,
  type LegOutcome,
  matchBasketResults,
} from '~/market/orders/basket'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { CHECKING, modeChanged, sandboxed, settle, sleep } from '~/market/orders/outcome'
import { noReplyDelays, reconcileBasket } from '~/market/orders/reconcile'
import type { Sent } from '~/market/orders/result'
import { type Outcome, submitOrderAction } from '~/market/orders/submit'
import { useConfirmedReview } from '~/market/orders/useConfirmedReview'
import { useFreshBook } from '~/market/orders/useFreshBook'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'

/** The toast when the review goes while its basket is on its way. */
export const BASKET_STILL_SENDING = 'Your basket is still being sent. Its outcome will show here.'
const NOT_SENT = 'The basket was not sent.'
/** After the LIVE kind of a basket the review showed as ANALYZE, the toast's reason. */
const SWITCHED = 'The server switched to LIVE after your review.'

export type BasketOutcome =
  /** The server answered per leg: each leg's outcome in the legs' order, and its reply as it came. */
  | { kind: 'placed'; legs: LegOutcome[]; analyze: boolean; liveSurprise?: true; raw: JSONValue }
  /** Semi-Auto queued the whole basket for the web Action Center. */
  | { kind: 'queued'; pendingId: string; message: string }
  /**
   * It may have placed legs: the order book is being read for them. `found` is null until the
   * check ends, then one row or null per leg. `checked` false: the book could not be read, so a
   * leg not found may still be there. `earlier`: the book could not be read at the review, so a
   * row found may be an earlier identical order (ruling 26). `waitSec` while no reply came: how
   * long the check may read, as the server may still be sending the legs.
   */
  | {
      kind: 'checking'
      found: Array<OrderRow | null> | null
      checked: boolean
      earlier: boolean
      waitSec?: number
    }
  /** Nothing went (`status` is the server's, 0 without one), or Semi-Auto refused it (403). */
  | { kind: 'refused' | 'semi_auto_blocked'; message: string; status: number }
  /** The live confirm said no (`message` when the check failed rather than the trader). */
  | { kind: 'cancelled'; message?: string }
  /** The server's mode changed after the review: nothing went, and the review shows again. */
  | { kind: 'mode_changed'; now: AnalyzerMode }

type Step =
  | { kind: 'review'; mode: AnalyzerMode | null; readError?: unknown; notice?: string }
  | { kind: 'sending'; mode: AnalyzerMode }
  /** An outcome shows; the review is over. */
  | { kind: 'done'; mode: AnalyzerMode }

const orderIds = (b: Orderbook | undefined): string[] => b?.orders.map((o) => o.orderid) ?? []

/** How many of a placed basket's legs went, or of a checked one's the book shows. */
const placedCount = (o: BasketOutcome): number =>
  o.kind === 'placed'
    ? o.legs.filter((l) => l.state === 'placed').length
    : o.kind === 'checking'
      ? (o.found ?? []).filter((r) => r !== null).length
      : 0

/**
 * The outcome in one short line, for the toast once the review has gone while the basket was out
 * (the toast shows one line). It says no more than the review would, and never less: a match
 * that may be an earlier order says so, and a basket that went LIVE says LIVE first.
 */
export function basketLine(o: BasketOutcome, legs: number): string {
  const n = placedCount(o)
  switch (o.kind) {
    case 'placed':
      if (o.liveSurprise) return `LIVE basket: ${n} of ${legs} legs placed. ${SWITCHED}`
      return sandboxed(`Basket: ${n} of ${legs} legs placed`, o.analyze)
    case 'queued':
      return 'Basket queued in the web Action Center'
    case 'checking':
      if (o.found === null) return CHECKING
      if (!o.checked) return "Couldn't check the order book"
      if (o.earlier && n > 0) return `Unclear: ${n} of ${legs} matches may be older`
      return `Basket: found ${n} of ${legs} legs in the order book`
    case 'refused':
    case 'semi_auto_blocked':
      return o.message
    case 'cancelled':
    case 'mode_changed':
      return NOT_SENT
  }
}

/**
 * The review of `spec` and its one send. The review opens as this mounts. `onBegin` is the
 * host's go-ahead, asked once confirm has passed the guard and before anything is held or sent
 * (a held basket's `held.begin`): false sends nothing. From then on the host's page gets the
 * basket's real outcome. `onOutcome` hears each outcome as it lands, whether the review is still
 * there or not.
 */
export function useBasketSubmit(o: {
  spec: BasketSpec
  onBegin?: () => boolean
  onOutcome?: (o: BasketOutcome) => void
}): {
  /** The mode the review shows; null while it is read. */
  mode: AnalyzerMode | null
  /** The mode read failed: nothing can be confirmed until `retryRead` works. */
  readError: unknown
  bookPending: boolean
  /** Another write on the new-order scope has an outcome not known yet. */
  otherOut: boolean
  /** The broker is logged out. */
  brokerOut: boolean
  /** The last confirm is still cooling down. */
  busy: boolean
  /** An earlier order's outcome that only a toast carried. */
  earlier: string | null
  /** Why the review shows again: the mode changed, or the live check did not pass. */
  notice: string | undefined
  sending: boolean
  outcome: BasketOutcome | null
  confirm(): void
  retryRead(): void
} {
  const { spec } = o
  const s = useServices()
  const trading = useTrading()
  const brokerOut = useBrokerBlocked()
  const hooks = useRef(o)
  hooks.current = o
  const [step, setStep] = useState<Step>({ kind: 'review', mode: null })
  const [outcome, setOutcome] = useState<BasketOutcome | null>(null)

  const readFresh = useFreshBook()
  const pid = s.profile.get().id
  const readIds = useCallback(async () => orderIds(await readFresh()), [readFresh])
  const cachedIds = useCallback(
    () => orderIds(s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid))),
    [s, pid],
  )
  const shell = useConfirmedReview({
    onReview: step.kind === 'review',
    sending: step.kind === 'sending',
    stillSending: BASKET_STILL_SENDING,
    readIds,
    cachedIds,
  })
  const { book, guard, otherOut, earlierLine } = shell

  const readMode = () =>
    shell.readMode((r) =>
      setStep((st) =>
        st.kind !== 'review'
          ? st
          : 'mode' in r
            ? { ...st, mode: r.mode, readError: undefined }
            : { ...st, readError: r.error },
      ),
    )
  // The review reads the server's mode and, afresh, the order book (ruling 26).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the review opens
  useEffect(() => {
    book.read()
    readMode()
  }, [])

  /**
   * `next` lands: the host hears it at once; the review shows it (`then`, else the outcome), or,
   * once the review has gone, the toast says it.
   */
  const land = (next: BasketOutcome, then: Step) => {
    hooks.current.onOutcome?.(next)
    shell.onSheet(
      () => {
        setOutcome(next)
        setStep(then)
      },
      basketLine(next, spec.legs.length),
    )
  }

  /** It may have placed legs: each is looked for in the book, and nothing is sent again. */
  const check = async (sent: Sent, shownMode: AnalyzerMode, noReply: boolean) => {
    // No reply: the server may still be sending the legs, so the check reads on past its broker
    // timeout.
    const delaysMs = noReply ? noReplyDelays() : undefined
    const earlier = !sent.complete
    notifyWarning()
    shell.checking()
    land(
      {
        kind: 'checking',
        found: null,
        checked: false,
        earlier,
        ...(delaysMs ? { waitSec: Math.round(delaysMs.reduce((a, b) => a + b, 0) / 1000) } : {}),
      },
      { kind: 'done', mode: shownMode },
    )
    const r = await reconcileBasket({
      // each read goes out after the basket, never joined to one sent before it
      fetchOrders: () => trading.orders.orderbook({ fresh: true }),
      legs: spec.legs,
      sentAt: sent.at,
      knownIds: sent.knownIds,
      sleep,
      delaysMs,
    }).catch(() => null)
    land(
      {
        kind: 'checking',
        found: r?.found ?? spec.legs.map(() => null),
        checked: r?.checked ?? false,
        earlier,
      },
      { kind: 'done', mode: shownMode },
    )
  }

  /** What came of the send (`settle`, rulings 5). */
  const tell = async (out: Outcome<BasketReply>, sent: Sent, shownMode: AnalyzerMode) => {
    const done: Step = { kind: 'done', mode: shownMode }
    const r = settle(out, spec.endpoint, (reply) => reply.kind === 'no_id')
    switch (r.kind) {
      case 'ok': {
        const reply = r.reply
        if (reply.kind === 'queued') {
          notifyWarning()
          land({ kind: 'queued', pendingId: reply.pendingId, message: QUEUED_COPY }, done)
          return
        }
        // settle reads a no_id reply as maybe
        if (reply.kind !== 'basket') return check(sent, shownMode, false)
        const legs = matchBasketResults(spec, reply.results)
        // The review showed ANALYZE, but the server placed it LIVE: never told as a success.
        if (r.liveSurprise) notifyError()
        else if (legs.every((l) => l.state === 'placed')) notifySuccess()
        else notifyWarning()
        // No eventWatch.expect: the server emits no order event per basket leg
        // (basket_order_service.py place_single_order), so a wait for one would demote the feed.
        land(
          {
            kind: 'placed',
            legs,
            analyze: reply.analyze,
            raw: reply.raw,
            ...(r.liveSurprise ? { liveSurprise: true as const } : {}),
          },
          done,
        )
        return
      }
      case 'maybe':
        return check(sent, shownMode, r.noReply)
      case 'refused':
        notifyError()
        land(
          {
            kind: 'refused',
            message: r.message,
            status: out.kind === 'error' ? out.error.status : 0,
          },
          done,
        )
        return
      case 'semi_auto_blocked':
        notifyError()
        land({ kind: 'semi_auto_blocked', message: r.message, status: 403 }, done)
        return
      case 'mode_changed': {
        // Nothing went: the review shows again in the new mode, and reads its book.
        const next: BasketOutcome = { kind: 'mode_changed', now: r.now }
        hooks.current.onOutcome?.(next)
        shell.modeChanged(
          r.now,
          () => {
            setOutcome(next)
            setStep({ kind: 'review', mode: r.now, notice: modeChanged(r.now) })
          },
          NOT_SENT,
        )
        return
      }
      case 'cancelled':
        // Back to the review: the live check failed (its message says so), or the trader said no.
        land(r.message === undefined ? { kind: 'cancelled' } : r, {
          kind: 'review',
          mode: shownMode,
          notice: r.message,
        })
        return
    }
  }

  const send = async (shownMode: AnalyzerMode) => {
    setStep({ kind: 'sending', mode: shownMode })
    // `send` takes the snapshot just before the request; until then nothing is known.
    const sent: Sent = { at: Date.now(), knownIds: new Set(), complete: false }
    let went = false
    try {
      const out = await submitOrderAction<BasketReply>({
        kind: 'basket',
        shownMode,
        send: () => {
          went = true
          Object.assign(sent, book.snapshot(), { at: Date.now() })
          return s.api.call(spec.endpoint, basketBody(spec), BasketReplySchema)
        },
        gate: trading.analyzer,
        confirmLive: confirmLiveOrder,
        books: s.books,
      })
      await tell(out, sent, shownMode)
    } catch (e) {
      // A bug, never an outcome: the host and the review still hear one, so neither waits for
      // ever. Before the request nothing went; after it, legs may have, so the book says.
      log.warn('orders', `basket: ${e instanceof Error ? e.message : String(e)}`)
      const done: Step = { kind: 'done', mode: shownMode }
      if (!went) land({ kind: 'refused', message: NOT_SENT, status: 0 }, done)
      else
        land(
          { kind: 'checking', found: spec.legs.map(() => null), checked: false, earlier: false },
          done,
        )
    }
  }

  const mode = step.mode
  return {
    mode,
    readError: step.kind === 'review' ? step.readError : undefined,
    bookPending: book.pending,
    otherOut,
    brokerOut,
    busy: guard.busy(),
    earlier: earlierLine,
    notice: step.kind === 'review' ? step.notice : undefined,
    sending: step.kind === 'sending',
    outcome: step.kind === 'done' ? outcome : null,
    confirm() {
      if (step.kind !== 'review' || step.mode === null) return
      const shownMode = step.mode
      // Never while the app is locked; then the host's go-ahead, before anything is held.
      shell.confirm(
        () => !s.lock.isLocked() && (hooks.current.onBegin?.() ?? true),
        () => send(shownMode),
      )
    },
    retryRead() {
      setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
      readMode()
    },
  }
}
