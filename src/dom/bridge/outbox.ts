// What native sends a DOM page: queued until the page has loaded, then delivered in order, at most
// one batch per animation frame (design 7.7). The queue is bounded, so a page that never loads, or
// a WebView that died, costs at most `maxQueue` messages.
import { log } from '~/core/log/logger'
import type { NativeToDom } from './protocol'

/** Hands one batch to the page. Returning `false` means the page could not take it yet; throwing
 *  means the hand-off failed. Either way the batch stays queued, first, and is offered again after
 *  `OUTBOX_RETRY_MS`, or on the next frame once `attach` is called again (the page's next
 *  'loaded'). */
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
/** How long a batch the page did not take waits before it is offered again: a page that never
 *  registers its handle costs 4 tries a second, not one per frame. */
export const OUTBOX_RETRY_MS = 250
const WARN_EVERY_MS = 10_000

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
  // A frame is due, or a retry is waiting: at most one of each, and no frame while a retry waits.
  let scheduled = false
  let retry: ReturnType<typeof setTimeout> | null = null
  let lastWarn = Number.NEGATIVE_INFINITY

  // Past the bound the oldest go, and are counted.
  const trim = () => {
    while (queue.length > maxQueue) {
      queue.shift()
      dropped += 1
    }
  }

  const kick = () => {
    if (scheduled || retry !== null || deliver === null || queue.length === 0) return
    scheduled = true
    schedule(flush)
  }

  const cancelRetry = () => {
    if (retry === null) return
    clearTimeout(retry)
    retry = null
  }

  // At most one line per 10 s, and never the batch.
  const warn = (e: unknown) => {
    const now = Date.now()
    if (now - lastWarn < WARN_EVERY_MS) return
    lastWarn = now
    log.warn('dom', 'could not deliver to the page', e)
  }

  function flush() {
    scheduled = false
    if (deliver === null || queue.length === 0) return
    const batch = queue.splice(0, maxBatch)
    let taken: unknown
    try {
      taken = deliver(batch)
    } catch (e) {
      warn(e)
      taken = false
    }
    if (taken === false) {
      queue = batch.concat(queue)
      trim()
      retry = setTimeout(() => {
        retry = null
        kick()
      }, OUTBOX_RETRY_MS)
      return
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
      // A new attach is a page that has just loaded: what it did not take goes on the next frame.
      cancelRetry()
      kick()
    },
    detach() {
      deliver = null
      cancelRetry()
    },
    clear() {
      queue = []
    },
    stats: () => ({ queued: queue.length, dropped }),
  }
}
