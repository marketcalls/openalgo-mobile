import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ProfileStorage } from '~/core/config/storage'
import { DEFAULT_WATCHLISTS, type Reduced, type Watchlists, WatchlistsSchema } from './model'

const NAME = 'watchlists'

/** An A-T21 document has no `activeId`, and a stale one names no list: the first list is active. */
function withActive(w: Watchlists): Watchlists {
  if (w.activeId !== undefined && w.lists.some((l) => l.id === w.activeId)) return w
  return { ...w, activeId: w.lists[0]?.id }
}

/** The saved lists; the first run (or an unreadable value) stores and returns the defaults. */
export async function loadWatchlists(s: ProfileStorage): Promise<Watchlists> {
  const saved = await s.getJSON(NAME, WatchlistsSchema)
  if (saved) return withActive(saved)
  await s.setJSON(NAME, DEFAULT_WATCHLISTS)
  return DEFAULT_WATCHLISTS
}

export async function saveWatchlists(s: ProfileStorage, w: Watchlists): Promise<void> {
  await s.setJSON(NAME, w)
}

export type WatchlistsState = {
  /** The defaults until `load` finishes; `loaded` says which. */
  data: Watchlists
  loaded: boolean
  load(): Promise<void>
  /** Runs a pure reducer on `data`, saves when it changed, and returns the reducer's result. */
  apply<A extends unknown[], R>(
    reducer: (w: Watchlists, ...args: A) => Reduced<R>,
    ...args: A
  ): Promise<R>
}

export type WatchlistsStore = StoreApi<WatchlistsState>

export function createWatchlistsStore(storage: ProfileStorage): WatchlistsStore {
  return createStore<WatchlistsState>((set, get) => ({
    data: DEFAULT_WATCHLISTS,
    loaded: false,
    async load() {
      const data = await loadWatchlists(storage)
      set({ data, loaded: true })
    },
    async apply(reducer, ...args) {
      const { next, result } = reducer(get().data, ...args)
      if (next !== get().data) {
        set({ data: next })
        await saveWatchlists(storage, next)
      }
      return result
    },
  }))
}
