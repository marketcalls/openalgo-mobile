import type { QueryClient } from '@tanstack/react-query'
import type { Analyzer } from '~/core/http/schemas'
import { qk } from './keys'

/** The books and funds of one profile: the server's, in its analyzer mode of the moment. */
const bookKeys = (pid: string) => [
  qk.orderbook(pid),
  qk.tradebook(pid),
  qk.positionbook(pid),
  qk.holdings(pid),
  qk.funds(pid),
]

/** Drops every cached query of one profile and leaves the others alone. */
export const clearProfileCache = (qc: QueryClient, pid: string): void => {
  qc.removeQueries({ queryKey: qk.root(pid) })
}

export type BookInvalidator = { poke(): void; dispose(): void }

/** Debounced invalidation of the books and funds; each poke restarts the wait. */
export const createBookInvalidator = (
  qc: QueryClient,
  pid: string,
  { debounceMs = 500 }: { debounceMs?: number } = {},
): BookInvalidator => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    timer = undefined
    for (const queryKey of bookKeys(pid)) void qc.invalidateQueries({ queryKey })
  }
  return {
    poke() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(fire, debounceMs)
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * The books are the server's in its mode of the moment: the sandbox's in ANALYZE, the broker's
 * in LIVE (Review Focus 2: the mode flips from the web or a strategy). When any read of the mode
 * (the header badge's, a write's) finds it changed, the books read before are the other mode's,
 * so they are dropped and read again, and a tab never shows, or acts on, a live row against the
 * sandbox. Returns the unsubscribe.
 */
export const resetBooksOnModeChange = (qc: QueryClient, pid: string): (() => void) => {
  const key = qk.analyzer(pid)
  const hash = JSON.stringify(key)
  let last = qc.getQueryData<Analyzer>(key)?.mode ?? null
  return qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.query.queryHash !== hash) return
    const mode = (e.query.state.data as Analyzer | undefined)?.mode ?? null
    if (mode === null || mode === last) return
    const was = last
    last = mode
    if (was === null) return
    for (const queryKey of bookKeys(pid)) void qc.resetQueries({ queryKey })
  })
}
