import type { QueryClient } from '@tanstack/react-query'
import { qk } from './keys'

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
    for (const queryKey of [
      qk.orderbook(pid),
      qk.tradebook(pid),
      qk.positionbook(pid),
      qk.holdings(pid),
      qk.funds(pid),
    ]) {
      void qc.invalidateQueries({ queryKey })
    }
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
