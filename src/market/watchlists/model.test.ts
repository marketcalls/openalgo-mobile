import {
  addItem,
  createGroup,
  createList,
  DEFAULT_WATCHLISTS,
  deleteGroup,
  deleteList,
  moveGroup,
  moveItem,
  moveItemInGroup,
  moveList,
  removeItem,
  renameGroup,
  renameList,
  setActive,
  setItemGroup,
  setSort,
  WATCHLIST_LIMITS,
  type Watchlists,
} from './model'

const base: Watchlists = {
  version: 2,
  activeId: 'a',
  lists: [
    { id: 'a', name: 'A', items: [], groups: [], sort: 'added' },
    { id: 'b', name: 'B', items: [], groups: [], sort: 'added' },
  ],
}
const item = (n: number) => ({ exchange: 'NSE', symbol: `S${n}` })

describe('createList', () => {
  test('trims the name and appends the list', () => {
    const { next, result } = createList(base, '  Swing  ', 'c')
    expect(result).toBe('ok')
    expect(next.lists.at(-1)).toEqual({
      id: 'c',
      name: 'Swing',
      items: [],
      groups: [],
      sort: 'added',
    })
  })
  test('rejects an empty name and a 31-character name', () => {
    expect(createList(base, '   ', 'c').result).toBe('bad_name')
    expect(createList(base, 'x'.repeat(31), 'c').result).toBe('bad_name')
    expect(createList(base, 'x'.repeat(30), 'c').result).toBe('ok')
  })
  test('the 51st list is refused and nothing changes', () => {
    let w = base
    for (let i = 0; i < WATCHLIST_LIMITS.lists - 2; i++) w = createList(w, `L${i}`, `id${i}`).next
    expect(w.lists).toHaveLength(50)
    const r = createList(w, 'one more', 'z')
    expect(r.result).toBe('limit')
    expect(r.next).toBe(w)
  })
})

describe('renameList', () => {
  test('trims, validates and reports a missing list', () => {
    expect(renameList(base, 'a', ' Core ').next.lists[0]?.name).toBe('Core')
    expect(renameList(base, 'a', '').result).toBe('bad_name')
    expect(renameList(base, 'zz', 'X').result).toBe('missing')
  })
})

describe('deleteList', () => {
  test('the last list cannot be deleted', () => {
    const one: Watchlists = {
      version: 2,
      activeId: 'a',
      lists: [{ id: 'a', name: 'A', items: [], groups: [], sort: 'added' }],
    }
    const r = deleteList(one, 'a')
    expect(r.result).toBe('last_list')
    expect(r.next).toBe(one)
  })
  test('deleting the active list activates the first remaining', () => {
    const w = setActive(base, 'b').next
    const r = deleteList(w, 'b')
    expect(r.result).toBe('ok')
    expect(r.next.activeId).toBe('a')
    expect(r.next.lists.map((l) => l.id)).toEqual(['a'])
  })
  test('deleting another list keeps the active one', () => {
    expect(deleteList(base, 'b').next.activeId).toBe('a')
  })
})

describe('items', () => {
  test('addItem adds, then reports a duplicate', () => {
    const one = addItem(base, 'a', item(1))
    expect(one.result).toBe('added')
    expect(addItem(one.next, 'a', item(1)).result).toBe('duplicate')
    // the same symbol in another list is fine
    expect(addItem(one.next, 'b', item(1)).result).toBe('added')
  })
  test('the 251st item is refused', () => {
    let w = base
    for (let i = 0; i < WATCHLIST_LIMITS.items; i++) w = addItem(w, 'a', item(i)).next
    expect(w.lists[0]?.items).toHaveLength(250)
    expect(addItem(w, 'a', item(999)).result).toBe('full')
  })
  test('removeItem drops the matching row', () => {
    const w = addItem(addItem(base, 'a', item(1)).next, 'a', item(2)).next
    expect(removeItem(w, 'a', item(1)).next.lists[0]?.items).toEqual([item(2)])
    expect(removeItem(w, 'a', item(9)).result).toBe('missing')
  })
  test('moveItem 0 to 2 reorders', () => {
    let w = base
    for (const n of [1, 2, 3]) w = addItem(w, 'a', item(n)).next
    const r = moveItem(w, 'a', 0, 2)
    expect(r.result).toBe('ok')
    expect(r.next.lists[0]?.items.map((i) => i.symbol)).toEqual(['S2', 'S3', 'S1'])
    expect(moveItem(w, 'a', 0, 3).result).toBe('bad_index')
  })
})

describe('setActive', () => {
  test('sets a known list and refuses an unknown one', () => {
    expect(setActive(base, 'b').next.activeId).toBe('b')
    const r = setActive(base, 'zz')
    expect(r.result).toBe('missing')
    expect(r.next).toBe(base)
  })
})

test('the defaults name their first list active', () => {
  expect(DEFAULT_WATCHLISTS.activeId).toBe(DEFAULT_WATCHLISTS.lists[0]?.id)
})

const tcs = { exchange: 'NSE', symbol: 'TCS' }
const withItems = (
  items: Watchlists['lists'][number]['items'],
  groups = [{ id: 'g1', name: 'G' }],
) => ({
  ...base,
  lists: [{ id: 'a', name: 'A', items, groups, sort: 'added' as const }, ...base.lists.slice(1)],
})

describe('groups', () => {
  test('createGroup trims, rejects a 31-character name and stops at 20', () => {
    expect(createGroup(base, 'a', ' Banks ', 'g').next.lists[0]?.groups).toEqual([
      { id: 'g', name: 'Banks' },
    ])
    expect(createGroup(base, 'a', 'x'.repeat(31), 'g').result).toBe('bad_name')
    expect(createGroup(base, 'zz', 'x', 'g').result).toBe('missing')
    let w = base
    for (let i = 0; i < WATCHLIST_LIMITS.groups; i++) w = createGroup(w, 'a', `G${i}`, `g${i}`).next
    expect(createGroup(w, 'a', 'one more', 'gx').result).toBe('limit')
  })
  test('renameGroup', () => {
    const w = withItems([])
    expect(renameGroup(w, 'a', 'g1', ' New ').next.lists[0]?.groups[0]?.name).toBe('New')
    expect(renameGroup(w, 'a', 'g1', '').result).toBe('bad_name')
    expect(renameGroup(w, 'a', 'nope', 'x').result).toBe('missing')
  })
  test('deleteGroup leaves its items in place with no group', () => {
    const w = withItems([{ ...tcs, group: 'g1' }, item(1)])
    const r = deleteGroup(w, 'a', 'g1')
    expect(r.result).toBe('ok')
    expect(r.next.lists[0]?.groups).toEqual([])
    expect(r.next.lists[0]?.items).toEqual([tcs, item(1)])
    expect(deleteGroup(w, 'a', 'nope').result).toBe('missing')
  })
  test('moveGroup swaps and refuses past either end', () => {
    const w = withItems(
      [],
      [
        { id: 'g1', name: 'A' },
        { id: 'g2', name: 'B' },
      ],
    )
    expect(moveGroup(w, 'a', 'g1', -1).result).toBe('bad_index')
    expect(moveGroup(w, 'a', 'g2', 1).result).toBe('bad_index')
    expect(moveGroup(w, 'a', 'g1', 1).next.lists[0]?.groups.map((g) => g.id)).toEqual(['g2', 'g1'])
    expect(moveGroup(w, 'a', 'x', 1).result).toBe('missing')
  })
  test('setItemGroup puts the item last with its group; null ungroups', () => {
    const w = withItems([tcs, item(1)])
    const r = setItemGroup(w, 'a', tcs, 'g1')
    expect(r.next.lists[0]?.items).toEqual([item(1), { ...tcs, group: 'g1' }])
    const back = setItemGroup(r.next, 'a', tcs, null)
    expect(back.next.lists[0]?.items).toEqual([item(1), tcs])
    expect(setItemGroup(w, 'a', item(9), 'g1').result).toBe('missing')
    expect(setItemGroup(w, 'a', tcs, 'nope').result).toBe('missing')
  })
  test('moveItemInGroup swaps with the nearest item of the same group', () => {
    const A = { ...item(1), group: 'g1' }
    const C = { ...item(3), group: 'g1' }
    const w = withItems([A, item(2), C])
    expect(moveItemInGroup(w, 'a', C, -1).next.lists[0]?.items).toEqual([C, item(2), A])
    expect(moveItemInGroup(w, 'a', A, -1).result).toBe('bad_index')
    expect(moveItemInGroup(w, 'a', item(2), 1).result).toBe('bad_index')
    expect(moveItemInGroup(w, 'a', item(7), 1).result).toBe('missing')
  })
  test('identity stays exchange and symbol whatever the group', () => {
    const w = withItems([{ ...tcs, group: 'g1' }])
    expect(addItem(w, 'a', tcs).result).toBe('duplicate')
    expect(removeItem(w, 'a', tcs).next.lists[0]?.items).toEqual([])
  })
})

describe('moveList and setSort', () => {
  test('moveList puts b first and refuses past the ends', () => {
    expect(moveList(base, 'b', -1).next.lists.map((l) => l.id)).toEqual(['b', 'a'])
    expect(moveList(base, 'a', -1).result).toBe('bad_index')
    expect(moveList(base, 'b', 1).result).toBe('bad_index')
    expect(moveList(base, 'x', 1).result).toBe('missing')
  })
  test('setSort', () => {
    expect(setSort(base, 'a', 'az').next.lists[0]?.sort).toBe('az')
    expect(setSort(base, 'x', 'az').result).toBe('missing')
  })
})
