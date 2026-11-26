import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ProfileStorage } from '~/core/config/storage'
import { DEFAULT_WATCHLISTS, type Reduced, type Watchlists, WatchlistsSchema } from './model'

const NAME = 'watchlists'

/**
 * An A-T21 document has no `activeId`, and a stale one names no list: the first list is active.
 * An item whose `group` names no group of its list is ungrouped.
 */
export function normalizeWatchlists(w: Watchlists): Watchlists {
  const stale = (l: Watchlists['lists'][number]) =>
    l.items.some((i) => i.group !== undefined && !l.groups.some((g) => g.id === i.group))
  const lists = w.lists.some(stale)
    ? w.lists.map((l) =>
        stale(l)
          ? {
              ...l,
              items: l.items.map((i) =>
                i.group !== undefined && !l.groups.some((g) => g.id === i.group)
                  ? { exchange: i.exchange, symbol: i.symbol }
                  : i,
              ),
            }
          : l,
      )
    : w.lists
  const activeOk = w.activeId !== undefined && lists.some((l) => l.id === w.activeId)
  if (lists === w.lists && activeOk) return w
  return { ...w, lists, activeId: activeOk ? w.activeId : lists[0]?.id }
}

/** The saved lists; the first run (or an unreadable value) stores and returns the defaults. */
export async function loadWatchlists(s: ProfileStorage): Promise<Watchlists> {
  const saved = await s.getJSON(NAME, WatchlistsSchema)
  if (saved) return normalizeWatchlists(saved)
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
  /** Loads and applies run one at a time, in call order, so none sees or clobbers a half-done change. */
  let tail: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job)
    tail = run.catch(() => undefined)
    return run
  }
  /** The last state known to be on disk; a failed save rolls memory back to it. */
  let persisted: Watchlists = DEFAULT_WATCHLISTS

  return createStore<WatchlistsState>((set, get) => {
    const doLoad = async () => {
      const data = await loadWatchlists(storage)
      persisted = data
      set({ data, loaded: true })
    }
    return {
      data: DEFAULT_WATCHLISTS,
      loaded: false,
      load: () => enqueue(doLoad),
      apply: (reducer, ...args) =>
        enqueue(async () => {
          if (!get().loaded) await doLoad()
          const { next, result } = reducer(get().data, ...args)
          if (next !== get().data) {
            set({ data: next })
            try {
              await saveWatchlists(storage, next)
              persisted = next
            } catch (e) {
              set({ data: persisted })
              throw e
            }
          }
          return result
        }),
    }
  })
}
