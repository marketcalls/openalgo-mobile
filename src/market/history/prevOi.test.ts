import { profileStorage } from '~/core/config/storage'
import type { HistoryRow } from '~/market/chart/schemas'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { lastCompletedDay } from './batch'
import { createPrevOiCache, oiDayKey } from './prevOi'

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall time on a date, as epoch seconds. */
const istSec = (iso: string, hhmm: string) =>
  (Date.parse(`${iso}T${hhmm}:00Z`) - IST_OFFSET_MS) / 1000

/** 5m FUT candles from 09:15 to 15:25 IST on each date, as the history route sends them. */
const futCandles = (dates: readonly string[]) =>
  dates.flatMap((iso) =>
    Array.from({ length: 75 }, (_, i) => ({ time: istSec(iso, '09:15') + i * 300 })),
  )

/** A daily candle of the IST date `iso`, stamped at its IST midnight, with its OI. */
const daily = (iso: string, oi: number): HistoryRow => ({
  timestamp: istSec(iso, '00:00'),
  open: 100,
  high: 102,
  low: 98,
  close: 101,
  volume: 1000,
  oi,
})

test('oiDayKey: pre-market → the day before yesterday; after 09:15 → yesterday; one date → null', () => {
  // Wed 25 Nov 2026 at 08:30 IST: the 5-day FUT window ends with Tuesday's session
  const preMarket = futCandles(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'])
  expect(oiDayKey(preMarket)).toBe('2026-11-23')
  // at 10:00 the day's first candles are in: yesterday is the last completed day
  const open = [...preMarket, { time: istSec('2026-11-25', '09:15') }]
  expect(oiDayKey(open)).toBe('2026-11-24')
  // the key is the daily candles' data[-2] at either time
  const days = ['2026-11-20', '2026-11-23', '2026-11-24'].map((d) => daily(d, 1))
  expect(lastCompletedDay(days)).toBe(oiDayKey(preMarket))
  expect(lastCompletedDay([...days, daily('2026-11-25', 1)])).toBe(oiDayKey(open))
  // the order of the candles does not matter; one date, or none, gives no key
  expect(oiDayKey([...open].reverse())).toBe('2026-11-24')
  expect(oiDayKey(futCandles(['2026-11-24']))).toBeNull()
  expect(oiDayKey([])).toBeNull()
})

test("a cache hit needs the leg's own data[-2] date; a leg cached under another day is read again", async () => {
  const kv = memoryKV()
  const storage = profileStorage(kv, 'p1')
  const cache = createPrevOiCache(storage)
  await cache.put('NFO', [
    { symbol: 'NIFTY01DEC2624000CE', day: '2026-11-24', prevOi: 512_000 },
    // a leg that did not trade on the 24th: its own data[-2] is the 23rd
    { symbol: 'NIFTY01DEC2626000CE', day: '2026-11-23', prevOi: 75 },
  ])
  expect(await cache.get('NFO', 'NIFTY01DEC2624000CE', '2026-11-24')).toBe(512_000)
  expect(await cache.get('NFO', 'NIFTY01DEC2626000CE', '2026-11-24')).toBeNull()
  expect(await cache.get('NFO', 'NIFTY01DEC2626000CE', '2026-11-23')).toBe(75)
  // another exchange, an unknown symbol: misses
  expect(await cache.get('BFO', 'NIFTY01DEC2624000CE', '2026-11-24')).toBeNull()
  expect(await cache.get('NFO', 'NIFTY01DEC2624000PE', '2026-11-24')).toBeNull()
  // a prevOi of 0 is a hit, not a miss
  await cache.put('NFO', [{ symbol: 'NIFTY01DEC2624000PE', day: '2026-11-24', prevOi: 0 }])
  expect(await cache.get('NFO', 'NIFTY01DEC2624000PE', '2026-11-24')).toBe(0)
  // stored under one name per exchange; it outlives the app session
  expect([...kv.data.keys()]).toEqual(['oa.p1.prevOi:NFO'])
  const again = createPrevOiCache(storage)
  expect(await again.get('nfo', 'NIFTY01DEC2624000CE', '2026-11-24')).toBe(512_000)
  // a newer read replaces the leg's entry
  await again.put('NFO', [{ symbol: 'NIFTY01DEC2624000CE', day: '2026-11-25', prevOi: 530_000 }])
  expect(await again.get('NFO', 'NIFTY01DEC2624000CE', '2026-11-24')).toBeNull()
  expect(await again.get('NFO', 'NIFTY01DEC2624000CE', '2026-11-25')).toBe(530_000)
})

test('only the two newest days are kept', async () => {
  const kv = memoryKV()
  const cache = createPrevOiCache(profileStorage(kv, 'p1'))
  await cache.put('NFO', [
    { symbol: 'A', day: '2026-11-20', prevOi: 1 },
    { symbol: 'B', day: '2026-11-23', prevOi: 2 },
  ])
  await cache.put('NFO', [{ symbol: 'C', day: '2026-11-24', prevOi: 3 }])
  expect(await cache.get('NFO', 'A', '2026-11-20')).toBeNull()
  expect(await cache.get('NFO', 'B', '2026-11-23')).toBe(2)
  expect(await cache.get('NFO', 'C', '2026-11-24')).toBe(3)
  // an older day than the two kept is not stored at all
  await cache.put('NFO', [{ symbol: 'D', day: '2026-11-19', prevOi: 4 }])
  expect(await cache.get('NFO', 'D', '2026-11-19')).toBeNull()
  expect(JSON.parse(kv.data.get('oa.p1.prevOi:NFO') ?? '[]')).toHaveLength(2)
})

test('at most 3,000 symbols an exchange, the oldest put dropped first', async () => {
  const kv = memoryKV()
  const cache = createPrevOiCache(profileStorage(kv, 'p1'))
  const rows = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ symbol: `S${from + i}`, day: '2026-11-24', prevOi: i }))
  await cache.put('NFO', rows(0, 2_990))
  // S0 is read again: it counts as new
  await cache.put('NFO', [{ symbol: 'S0', day: '2026-11-24', prevOi: 7 }])
  await cache.put('NFO', rows(5_000, 20))
  expect(await cache.get('NFO', 'S0', '2026-11-24')).toBe(7)
  for (const s of ['S1', 'S10']) expect(await cache.get('NFO', s, '2026-11-24')).toBeNull()
  for (const s of ['S11', 'S2989', 'S5019']) {
    expect(await cache.get('NFO', s, '2026-11-24')).not.toBeNull()
  }
  expect(JSON.parse(kv.data.get('oa.p1.prevOi:NFO') ?? '[]')).toHaveLength(3_000)
  // another exchange has its own 3,000
  await cache.put('BFO', rows(0, 1))
  expect(await cache.get('BFO', 'S0', '2026-11-24')).toBe(0)
})

test('writes are serialized: puts at the same time, and from a second cache, all land', async () => {
  const kv = memoryKV()
  const storage = profileStorage(kv, 'p1')
  // a tool screen closed while its last write is out, and the one opened next
  const a = createPrevOiCache(storage)
  const b = createPrevOiCache(storage)
  let writes = 0
  let release = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  const set = kv.set.bind(kv)
  kv.set = async (k, v) => {
    writes++
    if (writes === 1) await held
    await set(k, v)
  }
  const legs = Array.from({ length: 40 }, (_, i) => `L${i}`)
  const put = (s: string, i: number) => a.put('NFO', [{ symbol: s, day: '2026-11-24', prevOi: i }])
  const first = put('L0', 0)
  while (writes === 0) await new Promise((r) => setImmediate(r))
  // the first write is out: what is put meanwhile, by either cache, goes in the next one
  const rest = [
    ...legs.slice(1).map((s, i) => put(s, i + 1)),
    b.put('NFO', [{ symbol: 'FROM_B', day: '2026-11-24', prevOi: 9 }]),
  ]
  release()
  await Promise.all([first, ...rest])
  expect(writes).toBe(2)
  expect(await a.get('NFO', 'FROM_B', '2026-11-24')).toBe(9)
  expect(await b.get('NFO', 'L39', '2026-11-24')).toBe(39)
  const stored = createPrevOiCache(profileStorage(kv, 'p1'))
  for (const [i, s] of legs.entries()) expect(await stored.get('NFO', s, '2026-11-24')).toBe(i)
  expect(await stored.get('NFO', 'FROM_B', '2026-11-24')).toBe(9)
})

test('an unreadable stored list is an empty cache', async () => {
  const kv = memoryKV({ 'oa.p1.prevOi:NFO': '{"not":"a list"}' })
  const cache = createPrevOiCache(profileStorage(kv, 'p1'))
  expect(await cache.get('NFO', 'A', '2026-11-24')).toBeNull()
  await cache.put('NFO', [{ symbol: 'A', day: '2026-11-24', prevOi: 5 }])
  expect(await cache.get('NFO', 'A', '2026-11-24')).toBe(5)
})
