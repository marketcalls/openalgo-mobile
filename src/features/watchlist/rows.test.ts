import type { WatchItem, WatchList } from '~/market/watchlists/model'
import { buildRows, exchangeLabel, rowOffsets, sortItems } from './rows'

const it_ = (symbol: string, exchange = 'NSE', group?: string): WatchItem => ({
  exchange,
  symbol,
  group,
})
const none = () => undefined
const syms = (xs: WatchItem[]) => xs.map((x) => x.symbol)

describe('sortItems', () => {
  const items = [it_('RELIANCE'), it_('TCS'), it_('INFY')]

  it('keeps the input order for added', () => {
    expect(syms(sortItems(items, 'added', none))).toEqual(['RELIANCE', 'TCS', 'INFY'])
  })

  it('sorts az', () => {
    expect(syms(sortItems(items, 'az', none))).toEqual(['INFY', 'RELIANCE', 'TCS'])
  })

  it('sorts by change descending, unquoted last', () => {
    const q = (k: string) =>
      ({ 'NSE:RELIANCE': { changePct: 1.2 }, 'NSE:TCS': { changePct: -0.5 } })[k]
    expect(syms(sortItems(items, 'change', q))).toEqual(['RELIANCE', 'TCS', 'INFY'])
  })

  it('sorts by ltp descending', () => {
    const q = (k: string) =>
      ({ 'NSE:RELIANCE': { ltp: 100 }, 'NSE:TCS': { ltp: 300 }, 'NSE:INFY': { ltp: 200 } })[k]
    expect(syms(sortItems(items, 'ltp', q))).toEqual(['TCS', 'INFY', 'RELIANCE'])
  })

  it('sorts by exchange then symbol', () => {
    const xs = [it_('TCS'), it_('NIFTY25DECFUT', 'NFO'), it_('INFY'), it_('BANKNIFTY', 'NFO')]
    expect(syms(sortItems(xs, 'exchange', none))).toEqual([
      'BANKNIFTY',
      'NIFTY25DECFUT',
      'INFY',
      'TCS',
    ])
  })

  it('keeps the order of items without a quote', () => {
    expect(syms(sortItems([it_('B'), it_('A')], 'ltp', none))).toEqual(['B', 'A'])
  })

  it('does not mutate its input', () => {
    const copy = [...items]
    sortItems(items, 'az', none)
    expect(items).toEqual(copy)
  })
})

describe('buildRows', () => {
  const list: WatchList = {
    id: 'l',
    name: 'L',
    sort: 'added',
    groups: [
      { id: 'g1', name: 'One' },
      { id: 'g2', name: 'Two' },
    ],
    items: [it_('RELIANCE'), it_('TCS', 'NSE', 'g1'), it_('INFY', 'NSE', 'g1')],
  }

  it('puts ungrouped items first, then each group with its items', () => {
    const rows = buildRows(list, { editing: false, quoteOf: none })
    expect(
      rows.map((r) =>
        r.kind === 'item' ? r.item.symbol : r.kind === 'group' ? r.group.id : r.kind,
      ),
    ).toEqual(['RELIANCE', 'g1', 'TCS', 'INFY', 'g2'])
    const g1 = rows[1]
    expect(g1).toMatchObject({ kind: 'group', index: 0, count: 2 })
    expect(rows[4]).toMatchObject({ kind: 'group', index: 1, count: 0 })
  })

  it('marks first and last per group', () => {
    const rows = buildRows(list, { editing: false, quoteOf: none })
    expect(rows[0]).toMatchObject({ first: true, last: true })
    expect(rows[2]).toMatchObject({ first: true, last: false })
    expect(rows[3]).toMatchObject({ first: false, last: true })
  })

  it('appends new-group while editing, and ignores the sort', () => {
    const sorted = { ...list, sort: 'az' as const }
    const rows = buildRows(sorted, { editing: true, quoteOf: none })
    expect(rows[rows.length - 1]).toEqual({ kind: 'new-group' })
    expect(
      rows.filter((r) => r.kind === 'item').map((r) => r.kind === 'item' && r.item.symbol),
    ).toEqual(['RELIANCE', 'TCS', 'INFY'])
  })

  it('applies the list sort outside editing', () => {
    const rows = buildRows({ ...list, sort: 'az' }, { editing: false, quoteOf: none })
    expect(
      rows.filter((r) => r.kind === 'item').map((r) => r.kind === 'item' && r.item.symbol),
    ).toEqual(['RELIANCE', 'INFY', 'TCS'])
  })

  it('treats an item of an unknown group as ungrouped', () => {
    const rows = buildRows(
      { ...list, groups: [], items: [it_('X', 'NSE', 'gone')] },
      { editing: false, quoteOf: none },
    )
    expect(rows).toHaveLength(1)
  })
})

describe('rowOffsets and labels', () => {
  it('accumulates the three heights', () => {
    const item = { kind: 'item', item: it_('A'), key: 'NSE:A', first: true, last: true } as const
    const group = { kind: 'group', group: { id: 'g', name: 'G' }, index: 0, count: 1 } as const
    expect(rowOffsets([item, group, item])).toEqual([0, 56, 96])
  })

  it('labels indices', () => {
    expect(exchangeLabel('NSE_INDEX')).toBe('INDICES')
    expect(exchangeLabel('NFO')).toBe('NFO')
  })
})
