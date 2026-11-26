// The app's order events (design 7.6): every `order_update` the feed delivers, already
// deduplicated by the socket client, goes to whoever listens: the book refresh and the check
// that the app's own orders produce events.
import { log } from '~/core/log/logger'
import type { OrderUpdate } from './protocol'

export type OrderEventBus = {
  emit(u: OrderUpdate): void
  /** Returns the unsubscribe. */
  subscribe(fn: (u: OrderUpdate) => void): () => void
}

const TAG = 'orders'

export function createOrderEventBus(): OrderEventBus {
  const listeners = new Set<(u: OrderUpdate) => void>()
  return {
    emit(u) {
      // A listener that fails must not keep the update from the others, nor break the socket.
      for (const fn of Array.from(listeners)) {
        try {
          fn(u)
        } catch (e) {
          log.warn(TAG, 'an order event listener failed', e)
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
