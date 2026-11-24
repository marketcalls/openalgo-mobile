import { profileStorage } from '~/core/config/storage'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { addItem, createList, DEFAULT_WATCHLISTS, WatchlistsSchema } from './model'
import { createWatchlistsStore, loadWatchlists, saveWatchlists } from './store'

const KEY = 'oa.p1.watchlists'
const setup = (seed: Record<string, string> = {}) => {
  const kv = memoryKV(seed)
  return { kv, s: profileStorage(kv, 'p1') }
}

describe('loadWatchlists', () => {
  test('an A-T21 document without activeId loads with the first list active', async () => {
    const doc = {
      version: 1,
      lists: [
        { id: 'x', name: 'X', items: [] },
        { id: 'y', name: 'Y', items: [] },
      ],
    }
    const { s } = setup({ [KEY]: JSON.stringify(doc) })
    expect((await loadWatchlists(s)).activeId).toBe('x')
  })
  test('an activeId that names no list falls back to the first', async () => {
    const doc = { version: 1, activeId: 'gone', lists: [{ id: 'x', name: 'X', items: [] }] }
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
})
