// A ticket's order can outlive its sheet. An Android form sheet can always be swiped away, and the
// app shell can unmount, while the order is on its way or while its outcome is being checked. A
// reopened ticket has its own submit guard, which knows nothing of that order, so each session
// (one Trading container) keeps the tickets whose order's outcome is not known yet. Another
// ticket does not send until it is, so an order whose outcome was never shown is not sent twice.
//
// The outcome of an order whose sheet had gone reaches only the root toast, and on iOS that toast
// is drawn beneath any presented sheet: the ticket waiting for it, or the instrument sheet. So
// the session also keeps that outcome's line until a ticket's review has shown it.
import { useCallback, useSyncExternalStore } from 'react'
import type { Trading } from '~/market/trading'

type Pending = { owners: Set<object>; unseen: string | null; subs: Set<() => void> }

const sessions = new WeakMap<Trading, Pending>()

function pendingOf(t: Trading): Pending {
  let p = sessions.get(t)
  if (!p) {
    p = { owners: new Set(), unseen: null, subs: new Set() }
    sessions.set(t, p)
  }
  return p
}

function notify(p: Pending): void {
  for (const cb of [...p.subs]) cb()
}

/**
 * Marks `owner`'s order as out until the returned release runs; a second release does nothing.
 * `outcome` is the result line when it reached only the toast (the sheet had gone): it is kept
 * for the next review to show.
 */
export function holdOrder(t: Trading, owner: object): (outcome?: string | null) => void {
  const p = pendingOf(t)
  p.owners.add(owner)
  notify(p)
  return (outcome) => {
    if (!p.owners.delete(owner)) return
    if (outcome) p.unseen = outcome
    notify(p)
  }
}

/** True while another ticket of this session has an order whose outcome is not known yet. */
export function otherOrderOut(t: Trading, owner: object): boolean {
  return [...pendingOf(t).owners].some((o) => o !== owner)
}

function useSession<T>(t: Trading, read: (p: Pending) => T): T {
  const p = pendingOf(t)
  const subscribe = useCallback(
    (cb: () => void) => {
      p.subs.add(cb)
      return () => {
        p.subs.delete(cb)
      }
    },
    [p],
  )
  return useSyncExternalStore(subscribe, () => read(p))
}

/** `otherOrderOut`, as a hook. */
export function useOtherOrderOut(t: Trading, owner: object): boolean {
  return useSession(t, () => otherOrderOut(t, owner))
}

/** The line of an outcome that only a toast carried, until a review takes it. */
export function useUnseenOutcome(t: Trading): string | null {
  return useSession(t, (p) => p.unseen)
}

/** Takes the unseen outcome's line, for the review that shows it; null when there is none. */
export function takeUnseenOutcome(t: Trading): string | null {
  const p = pendingOf(t)
  const line = p.unseen
  if (line === null) return null
  p.unseen = null
  notify(p)
  return line
}
