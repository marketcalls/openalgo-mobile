// The order book's writes (design 7.10): cancel one and cancel all from the Orders tab, each behind
// a confirm that names the server's mode, sent once through the order safety of T10 and one at a
// time (`market/orders/useConfirmedWrite`, which the GTT segment shares). An outcome that may hide
// the write is checked against the order book, never sent again (`market/orders/outcome`, which
// the modify sheet shares). A write the server took LIVE after the confirm said ANALYZE is told as
// a danger notice, never as a success.
import type { OrderRow } from '~/market/books/schemas'
import { checkOrder, NOT_CHECKED, sandboxed, sleep } from '~/market/orders/outcome'
import { onOrder } from '~/market/orders/pending'
import { reconcileCancelAll } from '~/market/orders/reconcile'
import { useConfirmedWrite } from '~/market/orders/useConfirmedWrite'
import { useFreshBook } from '~/market/orders/useFreshBook'
import { useTrading } from '~/market/trading'
import type { Strategy } from '~/market/types'

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

/**
 * Cancel and cancel all, one write at a time on the screen (`useConfirmedWrite`); `busy` disables
 * the order buttons meanwhile. A cancel is also held on its order for the session until its
 * outcome is known, so a modify sheet for that order waits for it, even after this screen
 * remounts. `semiBlocked`, `liveSurprise` and `outcome` are the last write's notices.
 */
export function useOrderWrites() {
  const trading = useTrading()
  const readBook = useFreshBook()
  const { run: write, ...notices } = useConfirmedWrite({ scopeOut: ROW_OUT })

  /** `summary` is the row's one line, the confirm's body; a cancel from the chart is 'mobile-chart'. */
  const cancel = (row: OrderRow, summary: string, o?: { strategy?: Strategy }) =>
    write({
      kind: 'cancel',
      endpoint: 'cancelorder',
      scope: onOrder(row.orderid),
      confirm: {
        title: 'Cancel this order?',
        body: summary,
        ok: 'Cancel order',
        cancel: 'Keep order',
      },
      send: () => trading.orders.cancel(row.orderid, { strategy: o?.strategy }),
      unknown: (reply) => reply.kind === 'no_id',
      done: (reply) => ({
        line: sandboxed(CANCELLED, reply.kind === 'ok' && reply.analyze),
        ok: true,
      }),
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
        cancel: 'Keep orders',
      },
      send: () => trading.orders.cancelAll(),
      done: (reply) => ({
        line: sandboxed(
          `Cancelled ${reply.canceled.length}. Failed ${reply.failed.length}.`,
          reply.analyze,
        ),
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

  return { cancel, cancelAll, ...notices }
}
