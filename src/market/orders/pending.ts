// A write can outlive its sheet. An Android form sheet can always be swiped away, and the app shell
// can unmount, while the write is on its way or while its outcome is being checked. A reopened
// sheet has its own submit guard, which knows nothing of that write, so each session (one Trading
// container) keeps the writes whose outcome is not known yet, each on its scope: a new order
// (every ticket), or one order of the book (its modify and cancel). Another write on the same
// scope does not go until that outcome is known, so a write whose outcome was never shown is not
// sent twice (Global 4).
//
// The outcome of a write whose sheet had gone reaches only the root toast, and on iOS that toast
// is drawn beneath any presented sheet: the one waiting for it, or another. So the session also
// keeps that outcome's line, by scope, until a sheet on that scope has shown it.
import { useCallback, useSyncExternalStore } from 'react'
import type { Trading } from '../trading'

/** What a write is on; writes on the same scope go one at a time across the session. */
export type PendingScope = string

/** A new order: every ticket shares it, since a placement names no order yet. */
export const NEW_ORDER: PendingScope = 'new'

/** One order of the book: its modify and its cancel. */
export const onOrder = (orderid: string): PendingScope => `order:${orderid}`

/** A new GTT: every GTT ticket shares it, as every order ticket shares `NEW_ORDER`. */
export const NEW_GTT: PendingScope = 'gtt:new'

/** One GTT of the GTT book, by trigger id: its modify and its cancel. */
export const onGtt = (triggerId: string): PendingScope => `gtt:${triggerId}`

/**
 * One position: its close, until the positionbook shows it closed or the check of the close ends.
 * A second close sent meanwhile would be sized from the position the first has not yet closed.
 */
export const onPosition = (r: {
  exchange: string
  symbol: string
  product: string
}): PendingScope => `position:${r.exchange}:${r.symbol}:${r.product}`

/** Close all: every position waits for it. */
export const ALL_POSITIONS: PendingScope = 'position:*'

/** Whether a scope is a position's (or close all's): Close all waits while any is out. */
export const isPositionScope = (scope: PendingScope) => scope.startsWith('position:')

type Hold = { owner: object; scope: PendingScope }

type Pending = {
  holds: Set<Hold>
  /** The scopes with a write out; a new set at each change, as `useSyncExternalStore` needs. */
  out: ReadonlySet<PendingScope>
  /** An outcome line only a toast carried, by scope, until a sheet on that scope takes it. */
  unseen: Map<PendingScope, string>
  subs: Set<() => void>
}

const sessions = new WeakMap<Trading, Pending>()

function pendingOf(t: Trading): Pending {
  let p = sessions.get(t)
  if (!p) {
    p = { holds: new Set(), out: new Set(), unseen: new Map(), subs: new Set() }
    sessions.set(t, p)
  }
  return p
}

function notify(p: Pending): void {
  p.out = new Set([...p.holds].map((h) => h.scope))
  for (const cb of [...p.subs]) cb()
}

/**
 * Marks `owner`'s write on `scope` as out until the returned release runs; a second release does
 * nothing. `outcome` is the result line when it reached only the toast (the sheet had gone): it
 * is kept for the next sheet on that scope to show.
 */
export function holdOrder(
  t: Trading,
  owner: object,
  scope: PendingScope = NEW_ORDER,
): (outcome?: string | null) => void {
  const p = pendingOf(t)
  const hold: Hold = { owner, scope }
  p.holds.add(hold)
  notify(p)
  return (outcome) => {
    if (!p.holds.delete(hold)) return
    if (outcome) p.unseen.set(scope, outcome)
    notify(p)
  }
}

/** True while another owner of this session has a write on `scope` whose outcome is not known. */
export function otherOrderOut(t: Trading, owner: object, scope: PendingScope = NEW_ORDER): boolean {
  return [...pendingOf(t).holds].some((h) => h.scope === scope && h.owner !== owner)
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
export function useOtherOrderOut(
  t: Trading,
  owner: object,
  scope: PendingScope = NEW_ORDER,
): boolean {
  return useSession(t, () => otherOrderOut(t, owner, scope))
}

/** The scopes with a write out, whoever owns it. */
export function useScopesOut(t: Trading): ReadonlySet<PendingScope> {
  return useSession(t, (p) => p.out)
}

/** The line of an outcome on `scope` that only a toast carried, until a sheet takes it. */
export function useUnseenOutcome(t: Trading, scope: PendingScope = NEW_ORDER): string | null {
  return useSession(t, (p) => p.unseen.get(scope) ?? null)
}

/** Takes the unseen outcome's line on `scope`, for the sheet that shows it; null when none. */
export function takeUnseenOutcome(t: Trading, scope: PendingScope = NEW_ORDER): string | null {
  const p = pendingOf(t)
  const line = p.unseen.get(scope)
  if (line === undefined) return null
  p.unseen.delete(scope)
  notify(p)
  return line
}
