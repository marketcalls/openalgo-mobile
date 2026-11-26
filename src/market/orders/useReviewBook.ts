// Ruling 26: the book as it stands at the review, so a check after an unknown outcome can tell
// the entries already in it from the one sent. Without it an identical earlier entry, the last
// ticket's or a strategy's, would be taken for this one. The order ticket reads the order book
// (order ids), the GTT ticket the GTT book (trigger ids).
import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldRetryQuery } from '~/core/query/queryClient'
import { useTrading } from '../trading'
import { sleep } from './outcome'
import { NEW_ORDER, otherOrderOut, type PendingScope } from './pending'

/**
 * How long confirm waits for the review's read. A read still out then leaves the snapshot
 * incomplete unless it lands before the send; a failing read retries twice and a slow one can
 * take 15 s a try, which would otherwise hold every confirm.
 */
export const BOOK_WAIT_MS = 5_000

/** What the send knows of the book: the ids already in it, which are not the one sent. */
export type BookSnapshot = {
  knownIds: ReadonlySet<string>
  /** This review's own read landed before the send, after every earlier write of the session. */
  complete: boolean
}

/** TanStack's default delay before the next try, as the app's queries wait. */
const retryDelay = (failures: number) => Math.min(1000 * 2 ** failures, 30_000)

/**
 * The review's book read. `read()` runs when a review opens; it is also run again when another
 * ticket's write on `scope` is released while this review shows, since a read made while that
 * write was out may not hold it. `pending` is true until the read lands, `BOOK_WAIT_MS` at most.
 *
 * - `readIds` reads the book's ids with a request of its own, never one already out: a read sent
 *   before an earlier write (the last review's, on a slow broker) does not hold it.
 * - `cachedIds` are the ids the cached book holds, which are not the one sent either.
 * - Both are kept stable by the caller (`useCallback`), as `read` and `snapshot` depend on them.
 */
export function useReviewBook(o: {
  owner: object
  otherOut: boolean
  onReview: boolean
  readIds: () => Promise<readonly string[]>
  cachedIds: () => readonly string[]
  /** The writes this review waits for: a new order by default. */
  scope?: PendingScope
}): {
  pending: boolean
  read: () => void
  snapshot: () => BookSnapshot
} {
  const { owner, otherOut, onReview, readIds, cachedIds, scope = NEW_ORDER } = o
  const trading = useTrading()
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Each read; one an earlier read or review started is dropped. */
  const reads = useRef(0)
  /** The latest read's ids once it lands, and whether another write was out when it was sent. */
  const landed = useRef<{ read: number; ids: ReadonlySet<string>; whileOut: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])

  /** `readIds`, retried as the app's queries retry, while it is still wanted. */
  const fetchFresh = useCallback(
    async (wanted: () => boolean): Promise<readonly string[]> => {
      for (let failures = 0; ; failures++) {
        try {
          return await readIds()
        } catch (e) {
          if (!wanted() || !shouldRetryQuery(failures, e)) throw e
          await sleep(retryDelay(failures))
          if (!wanted()) throw e
        }
      }
    },
    [readIds],
  )

  const read = useCallback(() => {
    const seq = ++reads.current
    const wanted = () => alive.current && reads.current === seq
    landed.current = null
    setPending(true)
    clearTimeout(timer.current)
    const settled = () => {
      if (!wanted()) return
      clearTimeout(timer.current)
      setPending(false)
    }
    timer.current = setTimeout(settled, BOOK_WAIT_MS)
    const whileOut = otherOrderOut(trading, owner, scope)
    fetchFresh(wanted)
      .then(
        (ids) => {
          if (wanted()) landed.current = { read: seq, ids: new Set(ids), whileOut }
        },
        () => {},
      )
      .finally(settled)
  }, [trading, owner, scope, fetchFresh])

  // Another ticket's write was out while this review read the book; now its outcome is known,
  // and it is in the book: read again, and confirm waits for that read.
  const wasOut = useRef(otherOut)
  useEffect(() => {
    const released = wasOut.current && !otherOut
    wasOut.current = otherOut
    if (released && onReview) read()
  }, [otherOut, onReview, read])

  /**
   * Taken just before the request. Only replies already in hand count: a read still out may be
   * answered after the write lands, and would hide it.
   */
  const snapshot = useCallback((): BookSnapshot => {
    const own = landed.current?.read === reads.current ? landed.current : null
    return {
      knownIds: new Set([...(own?.ids ?? []), ...cachedIds()]),
      complete: own !== null && !own.whileOut,
    }
  }, [cachedIds])

  return { pending, read, snapshot }
}
