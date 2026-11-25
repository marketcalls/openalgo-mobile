// The order book's writes (design 7.10): cancel one and cancel all from the Orders tab, each behind
// a confirm that names the server's mode, sent once through the order safety of T10 and one at a
// time. An outcome that may hide the write is checked against the order book, never sent again.
// The modify sheet shares the outcome reading and the check.
import { useCallback, useState } from 'react'
import type { EndpointId } from '~/core/http/endpoints'
import { ApiError, userMessage } from '~/core/http/errors'
import { notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import { isWorking, type Orderbook, type OrderRow } from '~/market/books/schemas'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { confirmInMode, MODE_LABEL } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import { holdOrder, onOrder, otherOrderOut, type PendingScope } from '~/market/orders/pending'
import { RECONCILE_DELAYS_MS, reconcileRow } from '~/market/orders/reconcile'
import { type ActionKind, type Outcome, submitOrderAction } from '~/market/orders/submit'
import { useTrading } from '~/market/trading'
import { toast } from '~/ui/Toast'

/** A-T7's copy for MaybePlaced, verbatim (ruling 3). */
export const CHECKING = userMessage(
  new ApiError({ kind: 'MaybePlaced', status: 0, endpoint: 'cancelorder' }),
)
export const NOT_CHECKED = "Couldn't check the order book. Check it before trying again."
export const NOT_READ = "The order book can't be read right now."
export const MODIFIED = 'Order modified'
const CANCELLED = 'Order cancelled'
const NOT_IN_BOOK = 'The order is no longer in the order book.'
export const CANCEL_ALL_BODY =
  'This cancels every open order in the account, including ones placed by strategies or the web.'

export const modeChanged = (now: AnalyzerMode) =>
  `The server is now in ${MODE_LABEL[now]} mode. Nothing was sent.`

/** A modify sheet whose order has a write out (another sheet's, or the tab's): it waits. */
export const ORDER_OUT =
  "An earlier change to this order isn't known yet. This one can be sent once it is."
/** On the tab, under a row whose order has a write out. */
export const ROW_OUT = 'A change to this order is on its way. Modify and Cancel wait for it.'
/** The outcome of an earlier write on this order whose sheet had gone, which only a toast said. */
export const earlierChange = (line: string) => `Your earlier change to this order: ${line}`

const orders = (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`

/** The books lag a write: a check waits this long before it reads (T10's first delay). */
const CHECK_AFTER_MS = RECONCILE_DELAYS_MS[0] ?? 2_000

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const errorText = (e: unknown) =>
  e instanceof ApiError ? userMessage(e) : 'Something went wrong.'

/** What came of a write, as a screen tells it. */
export type Settled<R> =
  | { kind: 'ok'; reply: R }
  /** It may have gone: check the book, never send again. */
  | { kind: 'maybe' }
  | { kind: 'refused'; message: string }
  | { kind: 'semi_auto_blocked'; message: string }
  | { kind: 'mode_changed'; now: AnalyzerMode }
  | { kind: 'cancelled'; message?: string }

/**
 * Rulings 5: besides `maybe`, a Server error from the write's own endpoint and a success without
 * an id (`unknown`) may hide the write, so both are checked like it.
 */
export function settle<R>(
  out: Outcome<R>,
  endpoint: EndpointId,
  unknown: (reply: R) => boolean = () => false,
): Settled<R> {
  switch (out.kind) {
    case 'done':
      return unknown(out.reply) ? { kind: 'maybe' } : { kind: 'ok', reply: out.reply }
    case 'error':
      return out.error.kind === 'Server' && out.error.endpoint === endpoint
        ? { kind: 'maybe' }
        : { kind: 'refused', message: userMessage(out.error) }
    default:
      return out
  }
}

/**
 * Reads the order book now, never joined to a read already out (one sent before the write may
 * not show it), and shows it on the books unless a newer reply landed meanwhile.
 */
export function useFreshBook(): () => Promise<Orderbook> {
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  return useCallback(async () => {
    const key = qk.orderbook(pid)
    const sentAt = Date.now()
    const b = await trading.orders.orderbook({ fresh: true })
    if ((s.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) < sentAt) {
      s.queryClient.setQueryData(key, b)
    }
    return b
  }, [s, trading, pid])
}

/** After a write on one order whose outcome is unknown: its status, once the book can show it. */
export async function checkOrder(
  readBook: () => Promise<Orderbook>,
  orderid: string,
): Promise<string> {
  await sleep(CHECK_AFTER_MS)
  try {
    const row = await reconcileRow({ fetchOrders: readBook, orderid })
    return row ? `Order status: ${row.status || '--'}` : NOT_IN_BOOK
  } catch {
    return NOT_CHECKED
  }
}

type Write<R> = {
  kind: ActionKind
  endpoint: EndpointId
  /** The order it is on, which the session holds until its outcome is known. */
  scope?: PendingScope
  confirm: { title: string; body: string; ok: string }
  send: () => Promise<R>
  unknown?: (reply: R) => boolean
  done: (reply: R) => void
  /** The line to show after an unknown outcome, once the book says. */
  check: () => Promise<string>
}

/**
 * Cancel and cancel all. One write at a time on the screen, its confirm included, then the
 * cooldown; `busy` disables the order buttons meanwhile. A cancel is also held on its order for
 * the session (`market/orders/pending`) until its outcome is known, so a modify sheet for that
 * order waits for it, even after this screen remounts. `semiBlocked` is the reason of a write
 * Semi-Auto refused, until the next write starts.
 */
export function useOrderWrites() {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const readBook = useFreshBook()
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  /** This screen, as the session's writes still out know it. */
  const [me] = useState(() => ({}))

  const write = <R>(w: Write<R>) =>
    void guard.run(async () => {
      setSemiBlocked(null)
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
          case 'ok':
            w.done(r.reply)
            return
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
      done: () => {
        notifySuccess()
        toast(CANCELLED)
      },
      check: () => checkOrder(readBook, row.orderid),
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
      done: (reply) => {
        if (reply.failed.length > 0) notifyWarning()
        else notifySuccess()
        toast(`Cancelled ${reply.canceled.length}. Failed ${reply.failed.length}.`)
      },
      check: async () => {
        await sleep(CHECK_AFTER_MS)
        try {
          const b = await readBook()
          return `Status unknown. ${orders(b.orders.filter(isWorking).length)} still open.`
        } catch {
          return `Status unknown. ${NOT_CHECKED}`
        }
      },
    })

  return { cancel, cancelAll, busy: guard.busy(), semiBlocked }
}
