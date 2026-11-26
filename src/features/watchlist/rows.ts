// The watchlist screen's rows: items and group headers in one flat list, sorted per the list's
// sort, with the heights `getItemLayout` needs.
import { quoteKey } from '~/core/realtime/protocol'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import type { WatchGroup, WatchItem, WatchList, WatchSort } from '~/market/watchlists/model'

export const ROW_HEIGHT = 56
export const GROUP_HEIGHT = 40
export const NEW_GROUP_HEIGHT = 48

export const exchangeLabel = (ex: string): string => (isQuoteOnly(ex) ? 'INDICES' : ex)

type QuoteOf = (key: string) => { ltp?: number; changePct?: number } | undefined

export type RowModel =
  | { kind: 'item'; item: WatchItem; key: string; first: boolean; last: boolean }
  | { kind: 'group'; group: WatchGroup; index: number; count: number }
  | { kind: 'new-group' }

const keyOf = (i: WatchItem) => quoteKey(i.exchange, i.symbol)
const bySymbol = (a: WatchItem, b: WatchItem) => a.symbol.localeCompare(b.symbol, 'en')

/** A stable sort; an item without the sorted value goes last, in its input order. */
export function sortItems(
  items: readonly WatchItem[],
  sort: WatchSort,
  quoteOf: QuoteOf,
): WatchItem[] {
  if (sort === 'added') return [...items]
  const num = (i: WatchItem): number | undefined => {
    const q = quoteOf(keyOf(i))
    return sort === 'change' ? q?.changePct : q?.ltp
  }
  const cmp = (a: WatchItem, b: WatchItem): number => {
    if (sort === 'az') return bySymbol(a, b)
    if (sort === 'exchange') return a.exchange.localeCompare(b.exchange, 'en') || bySymbol(a, b)
    const x = num(a)
    const y = num(b)
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1
    return y - x
  }
  // Array#sort is stable (ES2019), so ties keep their input order.
  return [...items].sort(cmp)
}

export function buildRows(list: WatchList, o: { editing: boolean; quoteOf: QuoteOf }): RowModel[] {
  const sort = o.editing ? 'added' : list.sort
  const ids = new Set(list.groups.map((g) => g.id))
  const section = (items: WatchItem[]): RowModel[] =>
    sortItems(items, sort, o.quoteOf).map((item, i, all) => ({
      kind: 'item',
      item,
      key: keyOf(item),
      first: i === 0,
      last: i === all.length - 1,
    }))
  const rows: RowModel[] = section(list.items.filter((i) => !i.group || !ids.has(i.group)))
  list.groups.forEach((group, index) => {
    const mine = section(list.items.filter((i) => i.group === group.id))
    rows.push({ kind: 'group', group, index, count: mine.length }, ...mine)
  })
  if (o.editing) rows.push({ kind: 'new-group' })
  return rows
}

const heightOf = (r: RowModel) =>
  r.kind === 'item' ? ROW_HEIGHT : r.kind === 'group' ? GROUP_HEIGHT : NEW_GROUP_HEIGHT

/** Each row's top offset, for `getItemLayout`. */
export function rowOffsets(rows: readonly RowModel[]): number[] {
  let at = 0
  return rows.map((r) => {
    const top = at
    at += heightOf(r)
    return top
  })
}
