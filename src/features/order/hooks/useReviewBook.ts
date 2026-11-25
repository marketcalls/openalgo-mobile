// Ruling 26: the order book as it stands at the review, so a check after an unknown outcome can
// tell the orders already in it from the one sent. Without it an identical earlier order, the
// last ticket's or a strategy's, would be taken for this one.
import { useCallback, useEffect, useRef, useState } from 'react'
import { qk } from '~/core/query/keys'
import { shouldRetryQuery } from '~/core/query/queryClient'
import { useServices } from '~/core/services/services'
import type { Orderbook } from '~/market/books/schemas'
import { otherOrderOut } from '~/market/orders/pending'
import { useTrading } from '~/market/trading'

/**
 * How long confirm waits for the review's read. A read still out then leaves the snapshot
 * incomplete unless it lands before the send; a failing read retries twice and a slow one can
 * take 15 s a try, which would otherwise hold every confirm.
 */
export const BOOK_WAIT_MS = 5_000

/** What the send knows of the book: the orders already in it, which are not the one sent. */
export type BookSnapshot = {
  knownIds: ReadonlySet<string>
  /** This review's own read landed before the send, after every earlier order of the session. */
  complete: boolean
}

const idsOf = (b: Orderbook | undefined): string[] => b?.orders.map((o) => o.orderid) ?? []

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** TanStack's default delay before the next try, as the app's queries wait. */
const retryDelay = (failures: number) => Math.min(1000 * 2 ** failures, 30_000)

/**
 * The review's book read. `read()` runs when a review opens; it is also run again when another
 * ticket's order is released while this review shows, since a read made while that order was
 * out may not hold it. `pending` is true until the read lands, `BOOK_WAIT_MS` at most.
 */
export function useReviewBook(o: { owner: object; otherOut: boolean; onReview: boolean }): {
  pending: boolean
  read: () => void
  snapshot: () => BookSnapshot
} {
  const { owner, otherOut, onReview } = o
  const s = useServices()
  const trading = useTrading()
  const pid = s.profile.get().id
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Each read; one an earlier read or review started is dropped. */
  const reads = useRef(0)
  /** The latest read's ids once it lands, and whether another order was out when it was sent. */
  const landed = useRef<{ read: number; ids: ReadonlySet<string>; whileOut: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
    }
  }, [])

  /**
   * One read this review sends itself, never one already out: a read sent before an earlier
   * order (the last review's, on a slow broker) does not hold that order. TanStack's `fetchQuery`
   * would join it, and so would the scheduler's dedupe, hence `fresh`. It retries as the app's
   * queries do, while it is still wanted, and shares what it read with the books unless a reply
   * that landed meanwhile is there already.
   */
  const fetchFresh = useCallback(
    async (wanted: () => boolean): Promise<Orderbook> => {
      const key = qk.orderbook(pid)
      for (let failures = 0; ; failures++) {
        const sentAt = Date.now()
        try {
          const b = await trading.orders.orderbook({ fresh: true })
          if ((s.queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) < sentAt) {
            s.queryClient.setQueryData(key, b)
          }
          return b
        } catch (e) {
          if (!wanted() || !shouldRetryQuery(failures, e)) throw e
          await sleep(retryDelay(failures))
          if (!wanted()) throw e
        }
      }
    },
    [s, trading, pid],
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
    const whileOut = otherOrderOut(trading, owner)
    fetchFresh(wanted)
      .then(
        (b) => {
          if (wanted()) landed.current = { read: seq, ids: new Set(idsOf(b)), whileOut }
        },
        () => {},
      )
      .finally(settled)
  }, [trading, owner, fetchFresh])

  // Another ticket's order was out while this review read the book; now its outcome is known,
  // and it is in the book: read again, and confirm waits for that read.
  const wasOut = useRef(otherOut)
  useEffect(() => {
    const released = wasOut.current && !otherOut
    wasOut.current = otherOut
    if (released && onReview) read()
  }, [otherOut, onReview, read])

  /**
   * Taken just before the request. Only replies already in hand count: a read still out may be
   * answered after the order is placed, and would hide it.
   */
  const snapshot = useCallback((): BookSnapshot => {
    const own = landed.current?.read === reads.current ? landed.current : null
    const cached = idsOf(s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid)))
    return {
      knownIds: new Set([...(own?.ids ?? []), ...cached]),
      complete: own !== null && !own.whileOut,
    }
  }, [s, pid])

  return { pending, read, snapshot }
}
