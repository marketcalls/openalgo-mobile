// Whether order events really arrive (Review Focus 3): a broker listed as emitting them may not,
// on a server older than its adapter or with ORDER_UPDATES_ENABLED=FALSE. When one of the app's
// own orders gets no event in time, the books poll at the no-events rate for the session.
import type { SetTimer } from '~/core/http/scheduler'
import { log } from '~/core/log/logger'

export type EventWatch = {
  /** The app placed `orderid` and its event should follow; none in time demotes. */
  expect(orderid: string): void
  /** An order event arrived for `orderid`. */
  seen(orderid: string): void
  /** No event came for one of the app's own orders this session. */
  demoted(): boolean
  /** Forgets everything: the demotion, the waits and the ids seen. */
  reset(): void
}

/**
 * How long a seen id counts (ruling 12): the event can beat the order's own reply, from the
 * server (it emits while handling the write) or from a broker postback.
 */
const SEEN_KEEP_MS = 60_000

const TAG = 'books'

const defaultTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

export function createEventWatch({
  now,
  setTimer = defaultTimer,
  timeoutMs = 10_000,
}: {
  now: () => number
  setTimer?: SetTimer
  timeoutMs?: number
}): EventWatch {
  let demoted = false
  /** Seen order ids and when, oldest first. */
  const seenAt = new Map<string, number>()
  /** The waits still running, by order id. */
  const waits = new Map<string, () => void>()

  const prune = () => {
    const cutoff = now() - SEEN_KEEP_MS
    for (const [id, at] of seenAt) {
      if (at > cutoff) break
      seenAt.delete(id)
    }
  }

  return {
    expect(orderid) {
      prune()
      if (demoted || seenAt.has(orderid) || waits.has(orderid)) return
      waits.set(
        orderid,
        setTimer(() => {
          waits.delete(orderid)
          if (demoted) return
          demoted = true
          log.info(TAG, `no order event within ${timeoutMs} ms: polling at the no-events rate`)
        }, timeoutMs),
      )
    },

    seen(orderid) {
      // re-inserted, so the map stays oldest first
      seenAt.delete(orderid)
      seenAt.set(orderid, now())
      prune()
      waits.get(orderid)?.()
      waits.delete(orderid)
    },

    demoted: () => demoted,

    reset() {
      for (const cancel of waits.values()) cancel()
      waits.clear()
      seenAt.clear()
      demoted = false
    },
  }
}
