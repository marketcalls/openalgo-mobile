import { z } from 'zod'

export const WatchItemSchema = z.object({ exchange: z.string(), symbol: z.string() })

/** The device-local watchlists (design 7.7). `version` lets a later release migrate the shape. */
export const WatchlistsSchema = z.object({
  version: z.literal(1),
  /** The list the screen shows; absent in A-T21 documents, where the first list is active. */
  activeId: z.string().optional(),
  lists: z.array(z.object({ id: z.string(), name: z.string(), items: z.array(WatchItemSchema) })),
})

export type WatchItem = z.output<typeof WatchItemSchema>
export type Watchlists = z.output<typeof WatchlistsSchema>

export const DEFAULT_WATCHLISTS: Watchlists = {
  version: 1,
  activeId: 'default',
  lists: [
    {
      id: 'default',
      name: 'Watchlist',
      items: [
        { exchange: 'NSE', symbol: 'RELIANCE' },
        { exchange: 'NSE', symbol: 'TCS' },
        { exchange: 'NSE', symbol: 'INFY' },
        { exchange: 'NSE', symbol: 'HDFCBANK' },
        { exchange: 'NSE', symbol: 'ICICIBANK' },
        { exchange: 'NSE', symbol: 'SBIN' },
        { exchange: 'NSE_INDEX', symbol: 'NIFTY' },
      ],
    },
  ],
}

export const WATCHLIST_LIMITS = { lists: 50, items: 250, nameMax: 30 } as const

/** Every reducer is pure: it returns the next document (the same object when nothing changed). */
export type Reduced<R> = { next: Watchlists; result: R }

const keep = <R>(w: Watchlists, result: R): Reduced<R> => ({ next: w, result })
const cleanName = (name: string): string | null => {
  const n = name.trim()
  return n.length > 0 && n.length <= WATCHLIST_LIMITS.nameMax ? n : null
}
const mapList = (
  w: Watchlists,
  id: string,
  f: (items: WatchItem[]) => WatchItem[],
): Watchlists => ({
  ...w,
  lists: w.lists.map((l) => (l.id === id ? { ...l, items: f(l.items) } : l)),
})
const find = (w: Watchlists, id: string) => w.lists.find((l) => l.id === id)
const same = (a: WatchItem, b: WatchItem) => a.exchange === b.exchange && a.symbol === b.symbol

export function createList(
  w: Watchlists,
  name: string,
  id: string,
): Reduced<'ok' | 'limit' | 'bad_name'> {
  const n = cleanName(name)
  if (n === null) return keep(w, 'bad_name')
  if (w.lists.length >= WATCHLIST_LIMITS.lists) return keep(w, 'limit')
  return { next: { ...w, lists: [...w.lists, { id, name: n, items: [] }] }, result: 'ok' }
}

export function renameList(
  w: Watchlists,
  id: string,
  name: string,
): Reduced<'ok' | 'bad_name' | 'missing'> {
  const n = cleanName(name)
  if (n === null) return keep(w, 'bad_name')
  if (!find(w, id)) return keep(w, 'missing')
  return {
    next: { ...w, lists: w.lists.map((l) => (l.id === id ? { ...l, name: n } : l)) },
    result: 'ok',
  }
}

export function deleteList(w: Watchlists, id: string): Reduced<'ok' | 'last_list' | 'missing'> {
  if (!find(w, id)) return keep(w, 'missing')
  if (w.lists.length <= 1) return keep(w, 'last_list')
  const lists = w.lists.filter((l) => l.id !== id)
  const activeId = w.activeId === id ? lists[0]?.id : w.activeId
  return { next: { ...w, lists, activeId }, result: 'ok' }
}

export function addItem(
  w: Watchlists,
  listId: string,
  item: WatchItem,
): Reduced<'added' | 'duplicate' | 'full' | 'missing'> {
  const list = find(w, listId)
  if (!list) return keep(w, 'missing')
  if (list.items.some((i) => same(i, item))) return keep(w, 'duplicate')
  if (list.items.length >= WATCHLIST_LIMITS.items) return keep(w, 'full')
  const row = { exchange: item.exchange, symbol: item.symbol }
  return { next: mapList(w, listId, (items) => [...items, row]), result: 'added' }
}

export function removeItem(
  w: Watchlists,
  listId: string,
  item: WatchItem,
): Reduced<'ok' | 'missing'> {
  const list = find(w, listId)
  if (!list?.items.some((i) => same(i, item))) return keep(w, 'missing')
  return { next: mapList(w, listId, (items) => items.filter((i) => !same(i, item))), result: 'ok' }
}

export function moveItem(
  w: Watchlists,
  listId: string,
  from: number,
  to: number,
): Reduced<'ok' | 'bad_index' | 'missing'> {
  const list = find(w, listId)
  if (!list) return keep(w, 'missing')
  const n = list.items.length
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < n
  if (!ok(from) || !ok(to)) return keep(w, 'bad_index')
  if (from === to) return keep(w, 'ok')
  return {
    next: mapList(w, listId, (items) => {
      const rows = [...items]
      const [moved] = rows.splice(from, 1)
      if (moved) rows.splice(to, 0, moved)
      return rows
    }),
    result: 'ok',
  }
}

export function setActive(w: Watchlists, id: string): Reduced<'ok' | 'missing'> {
  if (!find(w, id)) return keep(w, 'missing')
  return { next: { ...w, activeId: id }, result: 'ok' }
}
