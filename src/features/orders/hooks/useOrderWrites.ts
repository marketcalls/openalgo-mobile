// The order book's writes (design 7.10): cancel one and cancel all from the Orders tab, each behind
// a confirm that names the server's mode, sent once through the order safety of T10 and one at a
// time. An outcome that may hide the write is checked against the order book, never sent again
// (`market/orders/outcome`, which the modify sheet shares). A write the server took LIVE after the
// confirm said ANALYZE is told as a danger notice, never as a success.
import { useState } from 'react'
import type { EndpointId } from '~/core/http/endpoints'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { useServices } from '~/core/services/services'
import type { OrderRow } from '~/market/books/schemas'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { confirmInMode } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import {
  CHECKING,
  checkOrder,
  errorText,
  modeChanged,
  NOT_CHECKED,
  settle,
  sleep,
} from '~/market/orders/outcome'
import { holdOrder, onOrder, otherOrderOut, type PendingScope } from '~/market/orders/pending'
import { reconcileCancelAll } from '~/market/orders/reconcile'
import { type ActionKind, liveSurpriseText, submitOrderAction } from '~/market/orders/submit'
import { useFreshBook } from '~/market/orders/useFreshBook'
import { useTrading } from '~/market/trading'
import { toast } from '~/ui/Toast'

export const NOT_READ = "The order book can't be read right now."
export const MODIFIED = 'Order modified'
const CANCELLED = 'Order cancelled'
export const CANCEL_ALL_BODY =
  'This cancels every open order in the account, including ones placed by strategies or the web.'

/** A modify sheet whose order has a write out (another sheet's, or the tab's): it waits. */
export const ORDER_OUT =
  "An earlier change to this order isn't known yet. This one can be sent once it is."
/** On the tab, under a row whose order has a write out. */
export const ROW_OUT = 'A change to this order is on its way. Modify and Cancel wait for it.'
/** The outcome of an earlier write on this order whose sheet had gone, which only a toast said. */
export const earlierChange = (line: string) => `Your earlier change to this order: ${line}`

const orders = (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`

type Write<R> = {
  kind: ActionKind
  endpoint: EndpointId
  /** The order it is on, which the session holds until its outcome is known. */
  scope?: PendingScope
  confirm: { title: string; body: string; ok: string }
  send: () => Promise<R>
  unknown?: (reply: R) => boolean
  /** What the toast says once it went, and whether all of it went (else a warning). */
  done: (reply: R) => { line: string; ok: boolean }
  /** The line to show after an unknown outcome, once the book says. */
  check: () => Promise<string>
}

/**
 * Cancel and cancel all. One write at a time on the screen, its confirm included, then the
 * cooldown; `busy` disables the order buttons meanwhile. A cancel is also held on its order for
 * the session (`market/orders/pending`) until its outcome is known, so a modify sheet for that
 * order waits for it, even after this screen remounts. `semiBlocked` is the reason of a write
 * Semi-Auto refused, until the next write starts. `liveSurprise` is the notice for a write the
 * server took LIVE after an ANALYZE confirm, until it is dismissed or the next write starts.
 */
export function useOrderWrites() {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const readBook = useFreshBook()
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  const [liveSurprise, setLiveSurprise] = useState<string | null>(null)
  /** This screen, as the session's writes still out know it. */
  const [me] = useState(() => ({}))

  const write = <R>(w: Write<R>) =>
    void guard.run(async () => {
      setSemiBlocked(null)
      setLiveSurprise(null)
      const c = await confirmInMode(trading.analyzer, { ...w.confirm, destructive: true })
      if (c.kind === 'error') {
        notifyWarning()
        toast(errorText(c.error))
        return
      }
      if (c.kind === 'declined') return
      // The row's buttons wait while its order has a write out; this keeps one from ever going.
      if (w.scope !== undefined && otherOrderOut(trading, me, w.scope)) {
        notifyWarning()
        toast(ROW_OUT)
        return
      }
      const release = w.scope === undefined ? null : holdOrder(trading, me, w.scope)
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
            toast(d.line)
            return
          }
          case 'maybe':
            notifyWarning()
            toast(CHECKING)
            toast(await w.check())
            return
          case 'refused':
            notifyWarning()
            toast(r.message)
            return
          case 'semi_auto_blocked':
            notifyWarning()
            setSemiBlocked(r.message)
            return
          case 'mode_changed':
            notifyWarning()
            toast(modeChanged(r.now))
            return
          case 'cancelled':
            if (r.message) toast(r.message)
            return
        }
      } finally {
        // The tab's toasts show on the tab itself, so no line is kept for a later sheet.
        release?.()
      }
    })

  /** `summary` is the row's one line, the confirm's body. */
  const cancel = (row: OrderRow, summary: string) =>
    write({
      kind: 'cancel',
      endpoint: 'cancelorder',
      scope: onOrder(row.orderid),
      confirm: { title: 'Cancel this order?', body: summary, ok: 'Cancel order' },
      send: () => trading.orders.cancel(row.orderid),
      unknown: (reply) => reply.kind === 'no_id',
      done: () => ({ line: CANCELLED, ok: true }),
      check: () => checkOrder({ readBook, before: row }),
    })

  /** `n` is the count of open orders the book shows, which the confirm names. */
  const cancelAll = (n: number) =>
    write({
      kind: 'cancelAll',
      endpoint: 'cancelallorder',
      confirm: {
        title: `Cancel all ${n} open ${n === 1 ? 'order' : 'orders'}?`,
        body: CANCEL_ALL_BODY,
        ok: 'Cancel all',
      },
      send: () => trading.orders.cancelAll(),
      done: (reply) => ({
        line: `Cancelled ${reply.canceled.length}. Failed ${reply.failed.length}.`,
        ok: reply.failed.length === 0,
      }),
      // The book lags the write: it is read after each of T10's delays until none is open.
      check: async () => {
        const r = await reconcileCancelAll({ fetchOrders: readBook, sleep }).catch(() => null)
        return r?.checked
          ? `Status unknown. ${orders(r.found)} still open.`
          : `Status unknown. ${NOT_CHECKED}`
      },
    })

  return {
    cancel,
    cancelAll,
    busy: guard.busy(),
    semiBlocked,
    liveSurprise,
    dismissLiveSurprise: () => setLiveSurprise(null),
  }
}
