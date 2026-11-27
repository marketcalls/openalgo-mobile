// What became of a placed order (design 7.10): "Order placed" is the server's word that the
// broker took it, but a broker's RMS can reject it a moment later (funds, the price band, a CNC
// sell without holdings), and that comes back only in the order book. The order ticket and the
// chart's one-tap both follow the placed id there, so neither reports a rejected order as placed.
import type { OrderUpdate } from '~/core/realtime/protocol'
import type { Orderbook } from '../books/schemas'

/** The order book reads after "Order placed"; an order event for the order reads at once. */
export const PLACED_STATUS_DELAYS_MS: readonly number[] = [1500, 3000, 6000]

/** The statuses an order cannot leave: the reads stop at one. */
export const FINAL_STATUSES: readonly string[] = ['complete', 'rejected', 'cancelled']

/** A placed order the broker rejected afterwards. */
export const PLACED_REJECTED = 'Rejected by the broker. See the order book for the reason.'

/**
 * Follows `orderid` in the order book, read after each delay and at once on its order event, and
 * tells `seen` each status the book shows, until a final one. A read that fails is skipped. The
 * returned function stops it; nothing is told after that.
 */
export function followPlaced(o: {
  orderid: string
  orderEvents: { subscribe(fn: (u: OrderUpdate) => void): () => void }
  /** A fresh read of the order book, never joined to one sent before the order. */
  readBook: () => Promise<Orderbook>
  seen: (status: string) => void
}): () => void {
  let on = true
  let wake = () => {}
  const off = o.orderEvents.subscribe((u) => {
    if (u.orderid === o.orderid) wake()
  })
  void (async () => {
    for (const ms of PLACED_STATUS_DELAYS_MS) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      if (!on) return
      let status: string | undefined
      try {
        status = (await o.readBook()).orders.find((r) => r.orderid === o.orderid)?.status
      } catch {
        continue
      }
      if (!on) return
      if (status === undefined) continue
      o.seen(status)
      if (FINAL_STATUSES.includes(status)) return
    }
  })()
  return () => {
    on = false
    off()
  }
}
