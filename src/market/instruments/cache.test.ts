import { profileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { SearchSchema } from '~/core/http/schemas'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { createInstrumentCache, isSymbolNotFound } from './cache'
import { SymbolSchema } from './meta'

const DAY1 = Date.UTC(2026, 10, 24, 5, 0) // 10:30 IST, 2026-11-24
const DAY2 = DAY1 + 86_400_000

const notFound = (sym: string, ex: string) =>
  new ApiError({
    kind: 'Unsupported',
    status: 404,
    endpoint: 'symbol',
    serverMessage: `Symbol ${sym} not found in exchange ${ex}`,
  })

function setup(opts: { listed?: Record<string, Record<string, unknown>> } = {}) {
  const listed = opts.listed ?? {
    'NSE:RELIANCE': { name: 'RELIANCE', lotsize: 1, tick_size: 0.05 },
    'NFO:NIFTY30DEC25FUT': { lotsize: 75, tick_size: 0.05, freeze_qty: 1800 },
  }
  const calls: Record<string, unknown>[] = []
  const api: Api = {
    async call(id, body, schema) {
      expect(id).toBe('symbol')
      expect(schema).toBe(SymbolSchema)
      calls.push(body)
      const key = `${String(body.exchange)}:${String(body.symbol)}`
      const row = listed[key]
      if (!row) throw notFound(String(body.symbol), String(body.exchange))
      return SymbolSchema.parse({
        status: 'success',
        data: { symbol: body.symbol, exchange: body.exchange, ...row },
      }) as never
    },
  }
  const kv = memoryKV()
  const storage = profileStorage(kv, 'p1')
  let t = DAY1
  const make = () => createInstrumentCache({ api, storage, now: () => t })
  return {
    calls,
    kv,
    storage,
    make,
    cache: make(),
    setNow: (n: number) => {
      t = n
    },
  }
}

describe('instrument cache', () => {
  test('a second get the same day makes no call', async () => {
    const h = setup()
    const a = await h.cache.get('NSE', 'RELIANCE')
    const b = await h.cache.get('NSE', 'RELIANCE')
    expect(h.calls).toEqual([{ symbol: 'RELIANCE', exchange: 'NSE' }])
    expect(b).toBe(a)
    expect(a).toMatchObject({ symbol: 'RELIANCE', lotsize: 1 })
    expect(h.cache.peek('NSE', 'RELIANCE')).toEqual(a)
  })

  test('concurrent gets share one call', async () => {
    const h = setup()
    await Promise.all([h.cache.get('NSE', 'RELIANCE'), h.cache.get('NSE', 'RELIANCE')])
    expect(h.calls).toHaveLength(1)
  })

  test('the next IST day refetches', async () => {
    const h = setup()
    await h.cache.get('NSE', 'RELIANCE')
    h.setNow(DAY2)
    expect(h.cache.peek('NSE', 'RELIANCE')).toBeUndefined()
    await h.cache.get('NSE', 'RELIANCE')
    expect(h.calls).toHaveLength(2)
  })

  test('the day turns at IST midnight, not UTC midnight', async () => {
    const h = setup()
    await h.cache.get('NSE', 'RELIANCE')
    h.setNow(Date.UTC(2026, 10, 24, 18, 29)) // 23:59 IST the same day
    await h.cache.get('NSE', 'RELIANCE')
    expect(h.calls).toHaveLength(1)
    h.setNow(Date.UTC(2026, 10, 24, 18, 30)) // 00:00 IST next day
    await h.cache.get('NSE', 'RELIANCE')
    expect(h.calls).toHaveLength(2)
  })

  test('RF 1: an expired contract is unknown, asked once a day', async () => {
    const h = setup()
    expect(await h.cache.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(h.calls).toHaveLength(1)
    for (let i = 0; i < 5; i++) expect(await h.cache.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(h.calls).toHaveLength(1)
    expect(h.cache.peek('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    h.setNow(DAY2)
    expect(await h.cache.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(h.calls).toHaveLength(2)
  })

  test('other failures are thrown and not remembered', async () => {
    const h = setup()
    const down = new ApiError({ kind: 'Network', status: 0, endpoint: 'symbol' })
    const api: Api = {
      call: async () => {
        throw down
      },
    }
    const cache = createInstrumentCache({ api, storage: h.storage, now: () => DAY1 })
    await expect(cache.get('NSE', 'RELIANCE')).rejects.toBe(down)
    expect(cache.peek('NSE', 'RELIANCE')).toBeUndefined()
  })

  test('a 404 that is not "not found in exchange" is not unknown', async () => {
    const e = new ApiError({
      kind: 'Unsupported',
      status: 404,
      endpoint: 'symbol',
      serverMessage: 'Endpoint not found',
    })
    expect(isSymbolNotFound(e)).toBe(false)
    expect(isSymbolNotFound(notFound('X', 'NSE'))).toBe(true)
    expect(isSymbolNotFound(new Error('Symbol X not found in exchange NSE'))).toBe(false)
    expect(
      isSymbolNotFound(
        new ApiError({
          kind: 'Validation',
          status: 400,
          endpoint: 'symbol',
          serverMessage: 'Symbol X not found in exchange NSE',
        }),
      ),
    ).toBe(false)
  })

  test('rows given to putMany skip /symbol', async () => {
    const h = setup()
    const rows = SearchSchema.parse({
      status: 'success',
      data: [
        { symbol: 'TCS', exchange: 'NSE', name: 'TCS', lotsize: 1, tick_size: 0.05 },
        { symbol: 'NIFTY', exchange: 'NSE_INDEX', tick_size: 0.0005 },
      ],
    })
    await h.cache.putMany(rows)
    const tcs = await h.cache.get('NSE', 'TCS')
    expect(tcs).toMatchObject({ symbol: 'TCS' })
    expect(await h.cache.get('NSE_INDEX', 'NIFTY')).toMatchObject({ quoteOnly: true })
    expect(h.calls).toHaveLength(0)
  })

  test('a row from search clears an unknown mark', async () => {
    const h = setup()
    expect(await h.cache.get('NSE', 'NEWCO')).toBe('unknown')
    await h.cache.putMany(
      SearchSchema.parse({ status: 'success', data: [{ symbol: 'NEWCO', exchange: 'NSE' }] }),
    )
    expect(h.cache.peek('NSE', 'NEWCO')).toMatchObject({ symbol: 'NEWCO' })
  })

  test('it is stored as { day, items, unknown } and read back by a new cache', async () => {
    const h = setup()
    await h.cache.get('NSE', 'RELIANCE')
    await h.cache.get('NFO', 'NIFTY25NOV25FUT')
    const stored = JSON.parse(h.kv.data.get('oa.p1.instruments') ?? 'null')
    expect(stored.day).toBe('2026-11-24')
    expect(stored.items).toHaveLength(1)
    expect(stored.unknown).toEqual(['NFO:NIFTY25NOV25FUT'])

    const again = h.make()
    expect(await again.get('NSE', 'RELIANCE')).toMatchObject({ symbol: 'RELIANCE' })
    expect(await again.get('NFO', 'NIFTY25NOV25FUT')).toBe('unknown')
    expect(h.calls).toHaveLength(2) // nothing new
  })

  test('yesterday’s store is dropped', async () => {
    const h = setup()
    await h.cache.get('NSE', 'RELIANCE')
    h.setNow(DAY2)
    const again = h.make()
    await again.get('NSE', 'RELIANCE')
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(h.kv.data.get('oa.p1.instruments') ?? 'null').day).toBe('2026-11-25')
  })

  test('an unreadable store starts empty', async () => {
    const h = setup()
    h.kv.data.set('oa.p1.instruments', '{"day":5}')
    await h.make().get('NSE', 'RELIANCE')
    expect(h.calls).toHaveLength(1)
  })

  test('at most 2,000 items, oldest dropped first', async () => {
    const h = setup()
    const rows = SearchSchema.parse({
      status: 'success',
      data: Array.from({ length: 2005 }, (_v, i) => ({ symbol: `S${i}`, exchange: 'NSE' })),
    })
    await h.cache.putMany(rows)
    expect(h.cache.peek('NSE', 'S0')).toBeUndefined()
    expect(h.cache.peek('NSE', 'S4')).toBeUndefined()
    expect(h.cache.peek('NSE', 'S5')).toBeDefined()
    expect(h.cache.peek('NSE', 'S2004')).toBeDefined()
    expect(JSON.parse(h.kv.data.get('oa.p1.instruments') ?? 'null').items).toHaveLength(2000)
  })

  test('a failing store does not fail a get', async () => {
    const h = setup()
    const storage = {
      ...h.storage,
      setJSON: async () => {
        throw new Error('disk full')
      },
    }
    const api: Api = {
      call: async () =>
        SymbolSchema.parse({ status: 'success', data: { symbol: 'A', exchange: 'NSE' } }) as never,
    }
    const cache = createInstrumentCache({ api, storage, now: () => DAY1 })
    await expect(cache.get('NSE', 'A')).resolves.toMatchObject({ symbol: 'A' })
  })
})
