import { profileStorage } from '~/core/config/storage'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { addItem, createList, DEFAULT_WATCHLISTS, setSort, WatchlistsSchema } from './model'
import { createWatchlistsStore, loadWatchlists, saveWatchlists } from './store'

const KEY = 'oa.p1.watchlists'
const setup = (seed: Record<string, string> = {}) => {
  const kv = memoryKV(seed)
  return { kv, s: profileStorage(kv, 'p1') }
}

describe('loadWatchlists', () => {
  test('an A-T21 document without activeId loads with the first list active', async () => {
    const doc = {
      version: 2,
      lists: [
        { id: 'x', name: 'X', items: [], groups: [], sort: 'added' },
        { id: 'y', name: 'Y', items: [], groups: [], sort: 'added' },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    expect((await loadWatchlists(s)).activeId).toBe('x')
  })
  test('an activeId that names no list falls back to the first', async () => {
    const doc = {
      version: 2,
      activeId: 'gone',
      lists: [{ id: 'x', name: 'X', items: [], groups: [], sort: 'added' }],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    expect((await loadWatchlists(s)).activeId).toBe('x')
  })
  test('save then load round-trips', async () => {
    const { s } = setup()
    const w = createList(DEFAULT_WATCHLISTS, 'Swing', 'sw').next
    await saveWatchlists(s, { ...w, activeId: 'sw' })
    expect(await loadWatchlists(s)).toEqual({ ...w, activeId: 'sw' })
  })
})

describe('version 1 documents', () => {
  const v1 = {
    version: 1,
    activeId: 'b',
    lists: [
      { id: 'a', name: 'A', items: [{ exchange: 'NSE', symbol: 'TCS' }] },
      {
        id: 'b',
        name: 'B',
        items: [
          { exchange: 'NFO', symbol: 'X' },
          { exchange: 'NSE', symbol: 'ITC' },
        ],
      },
    ],
  }
  test('loads intact with no groups and the added sort, and is never overwritten by defaults', async () => {
    const { s, kv } = setup({ [KEY]: JSON.stringify(v1) })
    const w = await loadWatchlists(s)
    expect(w).toEqual({
      version: 2,
      activeId: 'b',
      lists: v1.lists.map((l) => ({ ...l, groups: [], sort: 'added' })),
    })
    expect(kv.data.get(KEY)).toBe(JSON.stringify(v1))
  })
  test('the first change saves a version 2 document', async () => {
    const { s, kv } = setup({ [KEY]: JSON.stringify(v1) })
    const store = createWatchlistsStore(s)
    expect(await store.getState().apply(setSort, 'a', 'az')).toBe('ok')
    const saved = JSON.parse(kv.data.get(KEY) ?? 'null')
    expect(saved.version).toBe(2)
    expect(saved.lists.map((l: { id: string }) => l.id)).toEqual(['a', 'b'])
    expect(saved.lists[0].sort).toBe('az')
  })
})

describe('version 2 documents', () => {
  test('an item naming a group the list lacks loads ungrouped', async () => {
    const doc = {
      version: 2,
      activeId: 'a',
      lists: [
        {
          id: 'a',
          name: 'A',
          groups: [{ id: 'g1', name: 'G' }],
          sort: 'added',
          items: [
            { exchange: 'NSE', symbol: 'TCS', group: 'gone' },
            { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
          ],
        },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    expect((await loadWatchlists(s)).lists[0]?.items).toEqual([
      { exchange: 'NSE', symbol: 'TCS' },
      { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
    ])
  })
  test('a bad sort and bad groups fall back', async () => {
    const doc = {
      version: 2,
      lists: [{ id: 'a', name: 'A', items: [], sort: 'random', groups: 5 }],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    const l = (await loadWatchlists(s)).lists[0]
    expect(l?.sort).toBe('added')
    expect(l?.groups).toEqual([])
  })

  test('one malformed group keeps the valid ones and their items', async () => {
    const doc = {
      version: 2,
      activeId: 'a',
      lists: [
        {
          id: 'a',
          name: 'A',
          sort: 'added',
          groups: [{ id: 'g1', name: 'One' }, { id: 7 }, { id: 'g2', name: 'Two' }],
          items: [
            { exchange: 'NSE', symbol: 'TCS', group: 'g1' },
            { exchange: 'NSE', symbol: 'ITC', group: 'g2' },
          ],
        },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    const l = (await loadWatchlists(s)).lists[0]
    expect(l?.groups).toEqual([
      { id: 'g1', name: 'One' },
      { id: 'g2', name: 'Two' },
    ])
    expect(l?.items).toEqual([
      { exchange: 'NSE', symbol: 'TCS', group: 'g1' },
      { exchange: 'NSE', symbol: 'ITC', group: 'g2' },
    ])
  })
  test('an item whose group is not a string loses only its group', async () => {
    const doc = {
      version: 2,
      activeId: 'b',
      lists: [
        {
          id: 'a',
          name: 'A',
          sort: 'az',
          groups: [{ id: 'g1', name: 'G' }],
          items: [
            { exchange: 'NSE', symbol: 'TCS', group: 42 },
            { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
          ],
        },
        {
          id: 'b',
          name: 'B',
          sort: 'added',
          groups: [],
          items: [{ exchange: 'NSE', symbol: 'SBIN' }],
        },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    const w = await loadWatchlists(s)
    expect(w.activeId).toBe('b')
    expect(w.lists.map((l) => l.id)).toEqual(['a', 'b'])
    expect(w.lists[0]?.sort).toBe('az')
    expect(w.lists[0]?.groups).toEqual([{ id: 'g1', name: 'G' }])
    expect(JSON.parse(JSON.stringify(w.lists[0]?.items))).toEqual([
      { exchange: 'NSE', symbol: 'TCS' },
      { exchange: 'NSE', symbol: 'ITC', group: 'g1' },
    ])
    expect(w.lists[1]?.items).toEqual([{ exchange: 'NSE', symbol: 'SBIN' }])
  })
  test('a list with a bogus sort keeps its items and gets the added order', async () => {
    const doc = {
      version: 2,
      activeId: 'a',
      lists: [
        {
          id: 'a',
          name: 'A',
          sort: 'bogus',
          groups: [],
          items: [{ exchange: 'NSE', symbol: 'TCS' }],
        },
        { id: 'b', name: 'B', sort: 'ltp', groups: [], items: [] },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    const w = await loadWatchlists(s)
    expect(w.lists[0]?.sort).toBe('added')
    expect(w.lists[0]?.items).toEqual([{ exchange: 'NSE', symbol: 'TCS' }])
    expect(w.lists[1]?.sort).toBe('ltp')
  })
})

describe('createWatchlistsStore', () => {
  test('load fills data; apply updates it and saves', async () => {
    const { s, kv } = setup()
    const store = createWatchlistsStore(s)
    await store.getState().load()
    expect(store.getState().loaded).toBe(true)
    expect(store.getState().data).toEqual(DEFAULT_WATCHLISTS)

    const r = await store.getState().apply(createList, 'Swing', 'sw')
    expect(r).toBe('ok')
    expect(store.getState().data.lists.map((l) => l.id)).toEqual(['default', 'sw'])
    const saved = WatchlistsSchema.parse(JSON.parse(kv.data.get(KEY) ?? 'null'))
    expect(saved).toEqual(store.getState().data)
  })

  test('a refused change neither alters data nor writes', async () => {
    const { s, kv } = setup()
    const store = createWatchlistsStore(s)
    await store.getState().load()
    const before = kv.data.get(KEY)
    const first = { exchange: 'NSE', symbol: 'RELIANCE' }
    const r = await store.getState().apply(addItem, 'default', first)
    expect(r).toBe('duplicate')
    expect(store.getState().data).toBe(DEFAULT_WATCHLISTS)
    expect(kv.data.get(KEY)).toBe(before)
  })

  test('a second store reads what the first saved', async () => {
    const { s } = setup()
    const a = createWatchlistsStore(s)
    await a.getState().load()
    await a.getState().apply(createList, 'Swing', 'sw')
    const b = createWatchlistsStore(s)
    await b.getState().load()
    expect(b.getState().data).toEqual(a.getState().data)
  })

  test('apply before load keeps the persisted lists and applies on top of them', async () => {
    const { s } = setup()
    const w = createList(DEFAULT_WATCHLISTS, 'Swing', 'sw').next
    await saveWatchlists(s, w)
    const store = createWatchlistsStore(s)
    expect(await store.getState().apply(createList, 'Intraday', 'in')).toBe('ok')
    expect(store.getState().data.lists.map((l) => l.id)).toEqual(['default', 'sw', 'in'])
    const again = createWatchlistsStore(s)
    await again.getState().load()
    expect(again.getState().data.lists.map((l) => l.id)).toEqual(['default', 'sw', 'in'])
  })

  test('a slow load followed by apply keeps the applied change', async () => {
    const { s } = setup()
    const slow = {
      ...s,
      getJSON: async (...a: Parameters<typeof s.getJSON>) => {
        await new Promise((r) => setTimeout(r, 20))
        return s.getJSON(...a)
      },
    } as typeof s
    const store = createWatchlistsStore(slow)
    const loading = store.getState().load()
    const applying = store.getState().apply(createList, 'Swing', 'sw')
    await Promise.all([loading, applying])
    expect(store.getState().data.lists.map((l) => l.id)).toEqual(['default', 'sw'])
  })

  test('concurrent applies are serialized', async () => {
    const { s } = setup()
    const store = createWatchlistsStore(s)
    await store.getState().load()
    await Promise.all([
      store.getState().apply(createList, 'A', 'a'),
      store.getState().apply(createList, 'B', 'b'),
    ])
    expect(store.getState().data.lists.map((l) => l.id)).toEqual(['default', 'a', 'b'])
    const again = createWatchlistsStore(s)
    await again.getState().load()
    expect(again.getState().data).toEqual(store.getState().data)
  })

  test('a failing save rolls data back to the persisted state and rejects', async () => {
    const { s } = setup()
    let fail = false
    const flaky = {
      ...s,
      setJSON: async (...a: Parameters<typeof s.setJSON>) => {
        if (fail) throw new Error('disk full')
        return s.setJSON(...a)
      },
    } as typeof s
    const store = createWatchlistsStore(flaky)
    await store.getState().load()
    const persistedData = store.getState().data
    fail = true
    await expect(store.getState().apply(createList, 'Swing', 'sw')).rejects.toThrow('disk full')
    expect(store.getState().data).toEqual(persistedData)
    fail = false
    expect(await store.getState().apply(createList, 'Swing', 'sw')).toBe('ok')
    expect(store.getState().data.lists.map((l) => l.id)).toEqual(['default', 'sw'])
  })
})
