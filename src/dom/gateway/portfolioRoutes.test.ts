import { profileStorage } from '~/core/config/storage'
import type { DomRequest, JSONValue } from '~/dom/bridge/protocol'
import { DomToNativeSchema } from '~/dom/bridge/schemas'
import { createStrategyStore } from '~/market/strategies/store'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { createPortfolioRoutes } from './portfolioRoutes'
import { createRequestRouter, REFUSED_COPY } from './requests'

const leg = {
  segment: 'OPTION',
  side: 'BUY',
  lots: 1,
  lotSize: 75,
  expiry: '27NOV25',
  strike: 24500,
  optionType: 'CE',
  price: 100,
  symbol: 'NIFTY27NOV2524500CE',
}
const good = {
  name: 'Iron',
  watchlist: 'mytrades',
  underlying: 'NIFTY',
  exchange: 'NSE_INDEX',
  expiry: '27NOV25',
  legs: [leg],
}
let rid = 0
function setup() {
  const store = createStrategyStore(profileStorage(memoryKV(), 'p1'), () => Date.UTC(2026, 10, 27))
  const route = createRequestRouter(createPortfolioRoutes(store))
  const call = (
    method: DomRequest['method'],
    path: string,
    o: { query?: Record<string, string>; body?: JSONValue } = {},
  ) =>
    route({ v: 1, kind: 'request', rid: ++rid, method, path, ...o }, new AbortController().signal)
  return { call, store }
}
const err = (message: string, status = 400) => ({ status, body: { status: 'error', message } })

test('create, list, get, update and delete answer the blueprint', async () => {
  const { call } = setup()
  const made = await call('POST', '/api/strategy-portfolio', { body: good })
  expect(made).toMatchObject({
    status: 200,
    body: { status: 'success', item: { id: 1, name: 'Iron' } },
  })
  await call('POST', '/api/strategy-portfolio', {
    body: { ...good, name: 'Sim', watchlist: 'simulation' },
  })
  const all = await call('GET', '/api/strategy-portfolio')
  expect((all.body as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
    'Sim',
    'Iron',
  ])
  const sim = await call('GET', '/api/strategy-portfolio', { query: { watchlist: 'simulation' } })
  expect((sim.body as { items: unknown[] }).items).toHaveLength(1)
  expect(await call('GET', '/api/strategy-portfolio', { query: { watchlist: '' } })).toMatchObject({
    status: 200,
  })
  expect(await call('GET', '/api/strategy-portfolio', { query: { watchlist: 'x' } })).toEqual(
    err('invalid watchlist'),
  )
  expect(await call('GET', '/api/strategy-portfolio/1')).toMatchObject({
    body: { status: 'success', item: { id: 1 } },
  })
  expect(await call('GET', '/api/strategy-portfolio/9')).toEqual(err('not found', 404))
  expect(
    await call('PUT', '/api/strategy-portfolio/1', { body: { ...good, name: '  Renamed ' } }),
  ).toMatchObject({
    body: { item: { id: 1, name: 'Renamed' } },
  })
  expect(await call('PUT', '/api/strategy-portfolio/9', { body: good })).toEqual(
    err('not found', 404),
  )
  expect(await call('DELETE', '/api/strategy-portfolio/1')).toEqual({
    status: 200,
    body: { status: 'success' },
  })
  expect(await call('DELETE', '/api/strategy-portfolio/1')).toEqual(err('not found', 404))
})

test('the server messages: no name, bad watchlist, no legs, a 121-character name', async () => {
  const { call } = setup()
  const post = (body: JSONValue) => call('POST', '/api/strategy-portfolio', { body })
  expect(await post({ ...good, name: '' })).toEqual(err("'name' is required"))
  expect(await post({ ...good, name: '   ' })).toEqual(err("'name' is required"))
  const { underlying: _u, ...noUnderlying } = good
  expect(await post(noUnderlying)).toEqual(err("'underlying' is required"))
  expect(await post({ ...good, exchange: null })).toEqual(err("'exchange' is required"))
  expect(await post({ ...good, watchlist: '' })).toEqual(err("'watchlist' is required"))
  expect(await post({ ...good, watchlist: 'both' })).toEqual(
    err("watchlist must be one of ['mytrades', 'simulation']"),
  )
  expect(await post({ ...good, legs: [] })).toEqual(err('at least one leg is required'))
  expect(await post({ ...good, legs: 'x' })).toEqual(err('at least one leg is required'))
  expect(await post({ ...good, name: 'x'.repeat(121) })).toEqual(
    err('name too long (max 120 chars)'),
  )
  expect(await post({ ...good, name: 'x'.repeat(120) })).toMatchObject({ status: 200 })
  expect(await post({ ...good, legs: Array.from({ length: 51 }, () => leg) })).toEqual(
    err('too many legs (max 50)'),
  )
  expect(await post([1])).toEqual(err('Invalid payload'))
  expect(await call('POST', '/api/strategy-portfolio')).toEqual(err("'name' is required"))
})

test('the 501st strategy answers 400 with the sentence, and no route answers 401 or 403', async () => {
  const { call, store } = setup()
  await store.merge(
    Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      watchlist: 'mytrades' as const,
      name: `S${i}`,
      underlying: 'NIFTY',
      exchange: 'NSE_INDEX',
      expiry: null,
      legs: [
        { ...leg, segment: 'OPTION' as const, side: 'BUY' as const, optionType: 'CE' as const },
      ],
      notes: null,
      created_at: `c${i}`,
      updated_at: `c${i}`,
    })),
  )
  expect(await call('POST', '/api/strategy-portfolio', { body: good })).toEqual(
    err('The phone keeps at most 500 strategies.'),
  )
  // an update that only changes a strategy is still allowed
  expect(await call('PUT', '/api/strategy-portfolio/1', { body: good })).toMatchObject({
    status: 200,
  })
})

test('PUT /api/strategy-portfolio/7 parses as a DomRequest and matches; /api/strategy-portfolio/abc is refused', async () => {
  const { call } = setup()
  const wire = {
    v: 1,
    kind: 'request',
    rid: 1,
    method: 'PUT',
    path: '/api/strategy-portfolio/7',
    body: good,
  }
  expect(DomToNativeSchema.safeParse(wire).success).toBe(true)
  expect(DomToNativeSchema.safeParse({ ...wire, method: 'DELETE', body: undefined }).success).toBe(
    true,
  )
  expect(DomToNativeSchema.safeParse({ ...wire, method: 'PATCH' }).success).toBe(false)
  expect(await call('PUT', '/api/strategy-portfolio/7', { body: good })).toEqual(
    err('not found', 404),
  )
  const refused = { status: 403, body: { status: 'error', message: REFUSED_COPY } }
  for (const p of [
    '/api/strategy-portfolio/abc',
    '/api/strategy-portfolio/1234567890',
    '/api/strategy-portfolio/1/',
    '/api/strategy-portfolio/-1',
    '/api/strategy-portfolio/1/x',
  ]) {
    expect(await call('GET', p)).toEqual(refused)
    expect(await call('DELETE', p)).toEqual(refused)
  }
  // a method the path has no route for
  expect(await call('DELETE', '/api/strategy-portfolio')).toEqual(refused)
  expect(await call('PUT', '/api/strategy-portfolio', { body: good })).toEqual(refused)
})

test('a leg with an extra field is stored and read back with it', async () => {
  const { call } = setup()
  await call('POST', '/api/strategy-portfolio', {
    body: { ...good, legs: [{ ...leg, extra: { a: 1 } }] },
  })
  const got = await call('GET', '/api/strategy-portfolio/1')
  expect((got.body as { item: { legs: unknown[] } }).item.legs[0]).toMatchObject({
    extra: { a: 1 },
  })
})
