// Single flight for an order action (design 7.10): one request at a time, then a cooldown
// (120 ms, the web terminal's, C9), so a double tap or a tap during the reply sends once.
import { useState, useSyncExternalStore } from 'react'

export type SubmitGuard = {
  /** Runs `fn` unless the guard is busy, which answers `'busy'` without calling it. */
  run<T>(fn: () => Promise<T>): Promise<T | 'busy'>
  /** True while a run is in flight and for `cooldownMs` after it settles. */
  busy(): boolean
  /** Hears every change of `busy()`, the end of the cooldown included. */
  subscribe(cb: () => void): () => void
}

export function createSubmitGuard({
  now,
  cooldownMs = 120,
}: {
  now: () => number
  cooldownMs?: number
}): SubmitGuard {
  let inFlight = false
  let freeAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  const subs = new Set<() => void>()
  const notify = () => {
    for (const cb of [...subs]) cb()
  }
  const busy = () => inFlight || now() < freeAt

  return {
    busy,
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    async run(fn) {
      if (busy()) return 'busy'
      // set before the first await, so a second run in the same tick sees it
      inFlight = true
      notify()
      try {
        return await fn()
      } finally {
        inFlight = false
        freeAt = now() + cooldownMs
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          notify()
        }, cooldownMs)
        notify()
      }
    },
  }
}

/** One guard for the component's lifetime; the component re-renders when `busy()` changes. */
export function useSubmitGuard(): SubmitGuard {
  const [guard] = useState(() => createSubmitGuard({ now: Date.now }))
  useSyncExternalStore(guard.subscribe, guard.busy)
  return guard
}
