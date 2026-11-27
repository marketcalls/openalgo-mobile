import { profileStorage } from '~/core/config/storage'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { MAX_STRATEGIES, type PortfolioEntry, type PortfolioSavePayload } from './schemas'
import { createStrategyStore, FULL_COPY, LIMIT_COPY, StrategyLimitError } from './store'

const leg = {
  id: 'l1',
  segment: 'OPTION' as const,
  side: 'SELL' as const,
  lots: 1,
  lotSize: 75,
  expiry: '27NOV25',
  strike: 24500,
  optionType: 'CE' as const,
  price: 120,
  symbol: 'NIFTY27NOV2524500CE',
}
const save = (name: string, over: Partial<PortfolioSavePayload> = {}): PortfolioSavePayload => ({
  name,
  watchlist: 'mytrades',
  underlying: 'NIFTY',
  exchange: 'NSE_INDEX',
  expiry: '27NOV25',
  legs: [leg],
  ...over,
})
let clock = Date.UTC(2026, 10, 27, 4, 0)
const now = () => clock++
const make = (pid = 'p1', kv = memoryKV()) => ({
  kv,
  store: createStrategyStore(profileStorage(kv, pid), now),
})

test('create, list newest-updated first, filter by watchlist, update, delete', async () => {
  const { store } = make()
  const a = await store.save(save('A'))
  const b = await store.save(save('B', { watchlist: 'simulation' }))
  expect(a).toMatchObject({ id: 1, name: 'A', notes: null })
  expect(a?.created_at).toBe('2026-11-27T04:00:00.000Z')
  expect((await store.list()).map((e) => e.name)).toEqual(['B', 'A'])
  expect((await store.list('mytrades')).map((e) => e.name)).toEqual(['A'])
  expect(await store.get(2)).toEqual(b)

  const up = await store.save(save('A2', { notes: 'n' }), 1)
  expect(up).toMatchObject({
    id: 1,
    name: 'A2',
    notes: 'n',
    created_at: a?.created_at,
  })
  expect(up?.updated_at).not.toBe(a?.updated_at)
  expect((await store.list()).map((e) => e.name)).toEqual(['A2', 'B'])
  expect(await store.save(save('x'), 99)).toBeNull()

  expect(await store.remove(1)).toBe(true)
  expect(await store.remove(1)).toBe(false)
  expect(await store.get(1)).toBeNull()
  expect((await store.all()).map((e) => e.id)).toEqual([2])
})

test('ids are not reused after a delete; two saves at once both land', async () => {
  const { store } = make()
  await store.save(save('A'))
  await store.save(save('B'))
  await store.remove(2)
  expect((await store.save(save('C')))?.id).toBe(3)
  await store.clear()
  expect((await store.save(save('D')))?.id).toBe(4)
  const [x, y] = await Promise.all([store.save(save('X')), store.save(save('Y'))])
  expect([x?.id, y?.id]).toEqual([5, 6])
  expect((await store.all()).map((e) => e.name).sort()).toEqual(['D', 'X', 'Y'])
})

test('strategies are kept per profile', async () => {
  const kv = memoryKV()
  const one = make('p1', kv).store
  const two = make('p2', kv).store
  await one.save(save('mine'))
  expect(await two.all()).toEqual([])
  expect((await one.all()).map((e) => e.name)).toEqual(['mine'])
  expect([...kv.data.keys()]).toEqual(['oa.p1.strategyPortfolio'])
})

test('a leg with an extra field is stored and read back with it; a key named apikey is not', async () => {
  const { store, kv } = make()
  const odd = {
    ...leg,
    note: 'x',
    nested: { api_key: 'SECRET', ok: 1, deep: [{ apikey: 'S2', z: 2 }] },
  }
  await store.save(save('A', { legs: [odd] }))
  const [e] = await store.all()
  expect(e?.legs[0]).toMatchObject({
    note: 'x',
    nested: { ok: 1, deep: [{ z: 2 }] },
  })
  expect(JSON.stringify(kv.data.get('oa.p1.strategyPortfolio'))).not.toMatch(/SECRET|S2/)
})

test('the 501st strategy is refused and a list over its byte bound is full', async () => {
  const { store } = make()
  const e = (i: number): PortfolioEntry => ({
    id: i,
    watchlist: 'mytrades',
    name: `S${i}`,
    underlying: 'NIFTY',
    exchange: 'NSE_INDEX',
    expiry: null,
    legs: [leg],
    notes: null,
    created_at: `c${i}`,
    updated_at: `c${i}`,
  })
  expect(await store.merge(Array.from({ length: MAX_STRATEGIES + 3 }, (_, i) => e(i + 1)))).toBe(
    MAX_STRATEGIES,
  )
  await expect(store.save(save('one more'))).rejects.toThrow(LIMIT_COPY)
  await expect(store.save(save('one more'))).rejects.toBeInstanceOf(StrategyLimitError)
  expect(await store.all()).toHaveLength(MAX_STRATEGIES)

  const big = make().store
  const fat = { ...leg, blob: 'x'.repeat(400_000) }
  for (let i = 0; i < 3; i++) await big.save(save(`F${i}`, { legs: [fat] }))
  await expect(big.save(save('F3', { legs: [fat] }))).rejects.toThrow(FULL_COPY)
  expect(await big.all()).toHaveLength(3)
})

test('merge stops at the byte limit like the count limit instead of throwing', async () => {
  const src = make().store
  const fat = { ...leg, blob: 'x'.repeat(400_000) }
  for (let i = 0; i < 3; i++) await src.save(save(`F${i}`, { legs: [fat] }))
  const incoming = await src.all()
  const { store } = make()
  await store.save(save('Z', { legs: [fat] }))
  await store.save(save('Y', { legs: [fat] }))
  expect(await store.merge(incoming)).toBe(1)
  expect(await store.all()).toHaveLength(3)
  expect(await store.merge(incoming)).toBe(0)
})

test('merge adds those not present under new ids and skips the same name, list and creation time', async () => {
  const src = make().store
  await src.save(save('A'))
  await src.save(save('B', { watchlist: 'simulation' }))
  const incoming = await src.all()
  const { store } = make()
  await store.save(save('Z'))
  expect(await store.merge(incoming)).toBe(2)
  expect((await store.all()).map((e) => e.id).sort()).toEqual([1, 2, 3])
  expect(await store.merge(incoming)).toBe(0)
  expect(await store.all()).toHaveLength(3)
})

test('an entry that no longer parses is dropped and the rest stay', async () => {
  const kv = memoryKV()
  const { store } = make('p1', kv)
  await store.save(save('A'))
  const doc = JSON.parse(kv.data.get('oa.p1.strategyPortfolio') ?? '')
  doc.items.push({ id: 'bad' })
  kv.data.set('oa.p1.strategyPortfolio', JSON.stringify(doc))
  expect((await store.all()).map((e) => e.name)).toEqual(['A'])
})
