// The portfolio's writes (design 7.10): close one position and close all, each behind a native
// confirm that names the server's mode, sent once through the order safety of T10 and one at a
// time. Any 5xx or an unreadable reply on a close may hide it (about 28 adapters answer a flat
// close with "No OpenPosition Found" as a 500), so it is checked against the positionbook, never
// sent again. A write the server took LIVE after an ANALYZE confirm is told as a danger notice.
//
// A close the positionbook still shows open is not an invitation to close again (rulings 5): a
// closing order may be working unfilled (a circuit, an illiquid option, a queued order), and the
// server sizes a second close from the position the first has not yet closed, so both would fill
// and reverse it. The check then reads the orderbook for a working closing order, and the line
// points to the order book. The position's Close waits (`onPosition`) until the check ends, here
// and on any other screen: a close the session holds elsewhere (the Positions tab's, the chart's,
// close all) is never sent again from this one.
import { useState } from 'react'
import type { EndpointId } from '~/core/http/endpoints'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { useServices } from '~/core/services/services'
import { isWorking, type PositionRow } from '~/market/books/schemas'
import type { WriteOutcome } from '~/market/components/OutcomeLine'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { confirmInMode } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import { CHECKING, errorText, modeChanged, sandboxed, settle, sleep } from '~/market/orders/outcome'
import {
  ALL_POSITIONS,
  holdOrder,
  isPositionScope,
  onPosition,
  otherOrderOut,
  otherScopeOut,
  type PendingScope,
} from '~/market/orders/pending'
import {
  findWorkingExit,
  noReplyDelays,
  RECONCILE_DELAYS_MS,
  reconcileClose,
} from '~/market/orders/reconcile'
import { type ActionKind, liveSurpriseText, submitOrderAction } from '~/market/orders/submit'
import { useFreshBook, useFreshPositions } from '~/market/orders/useFreshBook'
import { useTrading } from '~/market/trading'
import type { Strategy } from '~/market/types'
import { toast } from '~/ui/Toast'

export const NOT_READ = "The positions can't be read right now."
export const CLOSE_SENT = 'Close order sent'
export const ALREADY_FLAT = 'Already flat'
export const CLOSE_CHECKING = 'Close may have gone through: checking positions.'
export const POSITION_CLOSED = 'Position is closed'
export const ALL_CLOSED = 'All positions are closed'
export const CLOSE_UNCHECKED =
  "Couldn't check the positions. Check the order book before closing again."
/** Another screen's close of this position, or close all, is not settled yet. */
export const CLOSE_OUT = 'A close of this position is on its way. Close waits for it.'
/** Another screen's close of a position is not settled yet. */
export const CLOSE_ALL_OUT = 'A close is on its way. Close all waits for it.'
export const CLOSE_ALL_BODY =
  'This closes every open position in the account at market, across all strategies and the web.'
export const closeOneBody = (row: Pick<PositionRow, 'symbol' | 'product' | 'quantity'>) =>
  `This closes the whole net position (${row.quantity}) for ${row.symbol} ${row.product} at market, including quantity opened by strategies or the web.`
/** The book shows an order working to close it: closing again would close twice. */
export const exitWorking = (status: string) =>
  `A closing order is working (${status || '--'}). Check the order book before closing again.`
/** Still open, and the orderbook could not say whether a closing order is working. */
export const stillOpen = (qty: number) =>
  `Still open: ${qty}. A closing order may still be working. Check the order book before closing again.`
/** Still open, and the orderbook shows no closing order working. */
export const stillOpenNoExit = (qty: number) =>
  `Still open: ${qty}. No closing order is working in the order book. Check it before closing again.`
/** The close order the server placed is in the book, no longer working (rejected, cancelled). */
export const exitEnded = (status: string, qty: number) =>
  `The closing order was ${status}. Still open: ${qty}.`
const positions = (n: number) => `${n} ${n === 1 ? 'position' : 'positions'}`

type Line = WriteOutcome

type Write<R> = {
  kind: ActionKind
  endpoint: EndpointId
  /** What the write is on, which the session holds until its outcome is known. */
  scope: PendingScope
  /** `cancel`: the dismiss button, named for what it keeps ("Keep position"). */
  confirm: { title: string; body: string; ok: string; cancel: string }
  send: () => Promise<R>
  unknown?: (reply: R) => boolean
  /** What it says once it went; `follow` is a check to run next, whose line replaces it. */
  done: (reply: R) => { line: Line; ok: boolean; follow?: () => Promise<Line> }
  /**
   * The line after an unknown outcome, once the books say. `noReply`: the server may still be
   * sending it, so the check reads on longer.
   */
  check: (o: { noReply: boolean }) => Promise<Line>
}

const ok = (text: string): Line => ({ text, tone: 'neutral' })
const warn = (text: string): Line => ({ text, tone: 'warning', orderbook: true })

/**
 * Close one and close all, one write at a time on the screen (its confirm included), then the
 * cooldown; `busy` disables the buttons meanwhile. The session also holds the position (or every
 * position, for close all) until the write's outcome is known, its check included, so a Close for
 * it waits even after this screen remounts. `semiBlocked` is the reason of a write Semi-Auto
 * refused, until the next write starts; `liveSurprise` the notice for a write the server took
 * LIVE after an ANALYZE confirm, until dismissed or the next write starts; `outcome` the last
 * write's line, until dismissed or the next write starts.
 */
export function usePositionWrites() {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const readPositions = useFreshPositions()
  const readOrders = useFreshBook()
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  const [liveSurprise, setLiveSurprise] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Line | null>(null)
  /** This screen, as the session's writes still out know it. */
  const [me] = useState(() => ({}))

  /** The line on the tab, and as a toast (which a screen reader hears). */
  const tell = (line: Line) => {
    setOutcome(line)
    toast(line.text)
  }

  /**
   * Another screen holds a close this write would repeat: the position's own, close all's, or for
   * close all any position's. Said with a toast; true when so.
   */
  const heldElsewhere = (scope: PendingScope): boolean => {
    const all = scope === ALL_POSITIONS
    const out = all
      ? otherScopeOut(trading, me, isPositionScope)
      : otherOrderOut(trading, me, scope) || otherOrderOut(trading, me, ALL_POSITIONS)
    if (!out) return false
    notifyWarning()
    toast(all ? CLOSE_ALL_OUT : CLOSE_OUT)
    return true
  }

  const write = <R>(w: Write<R>) =>
    void guard.run(async () => {
      setSemiBlocked(null)
      setLiveSurprise(null)
      setOutcome(null)
      if (heldElsewhere(w.scope)) return
      const c = await confirmInMode(trading.analyzer, { ...w.confirm, destructive: true })
      if (c.kind === 'error') {
        notifyWarning()
        toast(errorText(c.error))
        return
      }
      if (c.kind === 'mode_changed') {
        notifyWarning()
        tell(warn(modeChanged(c.now)))
        return
      }
      if (c.kind === 'declined') return
      // and once more: another screen's close may have gone while the confirm was up
      if (heldElsewhere(w.scope)) return
      const release = holdOrder(trading, me, w.scope)
      try {
        const out = await submitOrderAction({
          kind: w.kind,
          shownMode: c.mode,
          send: w.send,
          gate: trading.analyzer,
          confirmLive: confirmLiveOrder,
          books: s.books,
        })
        const r = settle(out, w.endpoint, w.unknown)
        switch (r.kind) {
          case 'ok': {
            const d = w.done(r.reply)
            if (r.liveSurprise) {
              notifyError()
              setLiveSurprise(liveSurpriseText(w.kind))
            } else if (d.ok) notifySuccess()
            else notifyWarning()
            tell(d.line)
            if (d.follow) tell(await d.follow())
            return
          }
          case 'maybe':
            notifyWarning()
            tell(warn(w.kind === 'closeOne' ? CLOSE_CHECKING : CHECKING))
            tell(await w.check({ noReply: r.noReply }))
            return
          case 'refused':
            notifyWarning()
            tell({ text: r.message, tone: 'warning' })
            return
          case 'semi_auto_blocked':
            notifyWarning()
            setSemiBlocked(r.message)
            return
          case 'mode_changed':
            notifyWarning()
            tell(warn(modeChanged(r.now)))
            return
          case 'cancelled':
            if (r.message) toast(r.message)
            return
        }
      } finally {
        release()
      }
    })

  /**
   * After a close, the books say what came of it: the positionbook after each delay until it
   * shows the position closed; if it still shows it open, the orderbook, for an order working to
   * close it (the close order itself when its id is known). Never an invitation to close again.
   */
  const closeCheck = async (
    row: PositionRow,
    o: { delaysMs: readonly number[]; sentAt: number; orderid?: string },
  ): Promise<Line> => {
    let qty = row.quantity
    const r = await reconcileClose({
      fetchPositions: async () => {
        const b = await readPositions()
        qty =
          b.rows.find(
            (p) =>
              p.symbol === row.symbol && p.exchange === row.exchange && p.product === row.product,
          )?.quantity ?? 0
        return b
      },
      row,
      sleep,
      delaysMs: o.delaysMs,
    }).catch(() => 'unknown' as const)
    if (r === 'closed') return ok(POSITION_CLOSED)
    if (r === 'unknown') return warn(CLOSE_UNCHECKED)
    if (o.orderid !== undefined) {
      const mine = await readOrders()
        .then((b) => b.orders.find((x) => x.orderid === o.orderid))
        .catch(() => undefined)
      if (mine && isWorking(mine)) return warn(exitWorking(mine.status))
      if (mine && (mine.status === 'rejected' || mine.status === 'cancelled')) {
        return warn(exitEnded(mine.status, qty))
      }
    }
    const exit = await findWorkingExit({
      fetchOrders: readOrders,
      row,
      side: qty > 0 ? 'SELL' : 'BUY',
      sentAt: o.sentAt,
    })
    if (exit.found) return warn(exitWorking(exit.found.status))
    return warn(exit.checked ? stillOpenNoExit(qty) : stillOpen(qty))
  }

  /** A close from the chart is 'mobile-chart'. */
  const closeOne = (row: PositionRow, o?: { strategy?: Strategy }) => {
    let sentAt = Date.now()
    return write({
      kind: 'closeOne',
      endpoint: 'placesmartorder',
      scope: onPosition(row),
      confirm: {
        title: `Close ${row.symbol} ${row.product}?`,
        body: closeOneBody(row),
        ok: 'Close position',
        cancel: 'Keep position',
      },
      send: () => {
        sentAt = Date.now()
        return trading.orders.smartClose(row, { strategy: o?.strategy })
      },
      unknown: (reply) => reply.kind === 'no_id',
      done: (reply) => {
        if (reply.kind === 'queued') return { line: ok(QUEUED_COPY), ok: true }
        if (reply.kind === 'flat') {
          return { line: ok(sandboxed(ALREADY_FLAT, reply.analyze)), ok: true }
        }
        // no_id never gets here (`unknown`): it is checked like a maybe
        if (reply.kind !== 'placed') return { line: ok(CLOSE_SENT), ok: true }
        const mark = (l: Line): Line => ({ ...l, text: sandboxed(l.text, reply.analyze) })
        return {
          line: ok(sandboxed(CLOSE_SENT, reply.analyze)),
          ok: true,
          // The row's Close waits until the positionbook shows it closed or this check ends.
          follow: async () =>
            mark(
              await closeCheck(row, {
                delaysMs: RECONCILE_DELAYS_MS,
                sentAt,
                orderid: reply.orderid,
              }),
            ),
        }
      },
      check: ({ noReply }) =>
        closeCheck(row, {
          delaysMs: noReply ? noReplyDelays() : RECONCILE_DELAYS_MS,
          sentAt,
        }),
    })
  }

  /** `n` is the count of open positions the book shows, which the confirm names. */
  const closeAll = (n: number) =>
    write({
      kind: 'closeAll',
      endpoint: 'closeposition',
      scope: ALL_POSITIONS,
      confirm: {
        title: `Close all ${n} open ${n === 1 ? 'position' : 'positions'}?`,
        body: CLOSE_ALL_BODY,
        ok: 'Close all',
        cancel: 'Keep positions',
      },
      send: () => trading.orders.closeAll(),
      done: (reply) => ({ line: ok(sandboxed(reply.message, reply.analyze)), ok: true }),
      // The book lags the write: it is read after each delay until none is open.
      check: async ({ noReply }) => {
        let open: number | null = null
        let dropped = 0
        for (const ms of noReply ? noReplyDelays() : RECONCILE_DELAYS_MS) {
          await sleep(ms)
          try {
            const b = await readPositions()
            open = b.rows.filter((p) => p.quantity !== 0).length
            dropped = b.dropped
          } catch {
            continue
          }
          if (open === 0 && dropped === 0) break
        }
        if (open === null || (open === 0 && dropped > 0)) {
          return warn(`Status unknown. ${CLOSE_UNCHECKED}`)
        }
        if (open === 0) return ok(ALL_CLOSED)
        return warn(
          `Status unknown. ${positions(open)} still open. Check the order book before closing again.`,
        )
      },
    })

  return {
    closeOne,
    closeAll,
    busy: guard.busy(),
    semiBlocked,
    liveSurprise,
    dismissLiveSurprise: () => setLiveSurprise(null),
    outcome,
    dismissOutcome: () => setOutcome(null),
  }
}
