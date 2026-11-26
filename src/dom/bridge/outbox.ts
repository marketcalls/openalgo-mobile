// What native sends a DOM page: queued until the page has loaded, then delivered in order, at most
// one batch per animation frame (design 7.7). The queue is bounded, so a page that never loads, or
// a WebView that died, costs at most `maxQueue` messages.
import type { NativeToDom } from './protocol'

/** Hands one batch to the page. Returning `false` means the page could not take it yet: the batch
 *  stays queued, first, and is offered again on the next frame. */
export type Deliver = (batch: NativeToDom[]) => unknown

export type Outbox = {
  post(m: NativeToDom): void
  attach(deliver: Deliver): void
  detach(): void
  /** Drops the queue (a reload or reset); `dropped` counts only what overflow pushed out. */
  clear(): void
  stats(): { queued: number; dropped: number }
}

export type OutboxOptions = {
  schedule?: (fn: () => void) => void
  maxQueue?: number
  maxBatch?: number
}

const MAX_QUEUE = 2000
const MAX_BATCH = 256

const nextFrame = (fn: () => void): void => {
  requestAnimationFrame(() => fn())
}

export function createOutbox(o: OutboxOptions = {}): Outbox {
  const schedule = o.schedule ?? nextFrame
  const maxQueue = o.maxQueue ?? MAX_QUEUE
  const maxBatch = o.maxBatch ?? MAX_BATCH
  let queue: NativeToDom[] = []
  let dropped = 0
  let deliver: Deliver | null = null
  let scheduled = false

  // Past the bound the oldest go, and are counted.
  const trim = () => {
    while (queue.length > maxQueue) {
      queue.shift()
      dropped += 1
    }
  }

  const kick = () => {
    if (scheduled || deliver === null || queue.length === 0) return
    scheduled = true
    schedule(flush)
  }

  function flush() {
    scheduled = false
    if (deliver === null || queue.length === 0) return
    const batch = queue.splice(0, maxBatch)
    if (deliver(batch) === false) {
      queue = batch.concat(queue)
      trim()
    }
    kick()
  }

  return {
    post(m) {
      queue.push(m)
      trim()
      kick()
    },
    attach(d) {
      deliver = d
      kick()
    },
    detach() {
      deliver = null
    },
    clear() {
      queue = []
    },
    stats: () => ({ queued: queue.length, dropped }),
  }
}
