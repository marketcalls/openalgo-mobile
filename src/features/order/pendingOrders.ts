// A ticket's order can outlive its sheet. An Android form sheet can always be swiped away, and the
// app shell can unmount, while the order is on its way or while its outcome is being checked. A
// reopened ticket has its own submit guard, which knows nothing of that order, so each session
// (one Trading container) keeps the tickets whose order's outcome is not known yet. Another
// ticket does not send until it is, so an order whose outcome was never shown is not sent twice.
import { useCallback, useSyncExternalStore } from 'react'
import type { Trading } from '~/market/trading'

type Pending = { owners: Set<object>; subs: Set<() => void> }

const sessions = new WeakMap<Trading, Pending>()

function pendingOf(t: Trading): Pending {
  let p = sessions.get(t)
  if (!p) {
    p = { owners: new Set(), subs: new Set() }
    sessions.set(t, p)
  }
  return p
}

function notify(p: Pending): void {
  for (const cb of [...p.subs]) cb()
}

/** Marks `owner`'s order as out until the returned release runs; a second release does nothing. */
export function holdOrder(t: Trading, owner: object): () => void {
  const p = pendingOf(t)
  p.owners.add(owner)
  notify(p)
  return () => {
    if (p.owners.delete(owner)) notify(p)
  }
}

/** True while another ticket of this session has an order whose outcome is not known yet. */
export function useOtherOrderOut(t: Trading, owner: object): boolean {
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
  const other = useCallback(() => [...p.owners].some((o) => o !== owner), [p, owner])
  return useSyncExternalStore(subscribe, other)
}
