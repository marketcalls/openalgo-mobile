import { profileStorage } from '~/core/config/storage'
import type { DomStorageMsg } from '~/dom/bridge/protocol'
import { memoryKV } from '../../../test/helpers/memoryKV'
import {
  chartStoreName,
  createChartStorageHandler,
  readChartRecords,
  writeChartRecords,
} from './chartStorage'
import { MAX_DOM_VALUE } from './domStorage'

const DRAW = 'oac-widget:chart:drawings:NSE:INFY'
type StorageOp = DomStorageMsg extends infer M
  ? M extends unknown
    ? Omit<M, 'v' | 'kind'>
    : never
  : never
const msg = (m: StorageOp) => ({ v: 1, kind: 'storage', ...m }) as DomStorageMsg

test('chartStoreName splits drawings by instrument from everything else', () => {
  expect(chartStoreName(DRAW)).toBe('chartDrawings:NSE:INFY')
  expect(chartStoreName('oac-widget:chart:state')).toBe('chartPrefs:oac-widget:chart:state')
})

test('drawings are kept per profile and instrument', async () => {
  const kv = memoryKV()
  const h1 = createChartStorageHandler(profileStorage(kv, 'p1'))
  const h2 = createChartStorageHandler(profileStorage(kv, 'p2'))
  expect(await h1(msg({ op: 'set', key: DRAW, value: '[1]' }))).toEqual({ status: 204, body: null })
  expect(kv.data.get('oa.p1.chartDrawings:NSE:INFY')).toBe(JSON.stringify({ k: DRAW, v: '[1]' }))
  expect(await h1(msg({ op: 'get', key: DRAW }))).toEqual({ status: 200, body: '[1]' })
  expect(await h1(msg({ op: 'get', key: 'oac-widget:chart:drawings:NSE:TCS' }))).toEqual({
    status: 200,
    body: null,
  })
  expect(await h2(msg({ op: 'get', key: DRAW }))).toEqual({ status: 200, body: null })
  expect(await h2(msg({ op: 'entries', prefix: 'oac-widget:' }))).toEqual({ status: 200, body: [] })
  await h1(msg({ op: 'remove', key: DRAW }))
  expect(kv.data.size).toBe(0)
})

test('entries returns full widget keys under the prefix', async () => {
  const h = createChartStorageHandler(profileStorage(memoryKV(), 'p1'))
  await h(msg({ op: 'set', key: DRAW, value: 'a' }))
  await h(msg({ op: 'set', key: 'oac-widget:chart:drawings:NSE:TCS', value: 'b' }))
  await h(msg({ op: 'set', key: 'oac-widget:chart:state', value: 'c' }))
  const r = await h(msg({ op: 'entries', prefix: 'oac-widget:chart:drawings:' }))
  expect(r.status).toBe(200)
  expect(r.body).toEqual([
    [DRAW, 'a'],
    ['oac-widget:chart:drawings:NSE:TCS', 'b'],
  ])
})

test('a key outside the widget prefix is refused with 403', async () => {
  const kv = memoryKV()
  const h = createChartStorageHandler(profileStorage(kv, 'p1'))
  expect((await h(msg({ op: 'set', key: 'other', value: 'x' }))).status).toBe(403)
  expect(kv.data.size).toBe(0)
})

test('a value over 1,000,000 characters is refused with 413 and nothing is stored', async () => {
  const kv = memoryKV()
  const h = createChartStorageHandler(profileStorage(kv, 'p1'))
  const r = await h(msg({ op: 'set', key: DRAW, value: 'x'.repeat(MAX_DOM_VALUE + 1) }))
  expect(r.status).toBe(413)
  expect(kv.data.size).toBe(0)
  expect((await h(msg({ op: 'set', key: DRAW, value: 'x'.repeat(MAX_DOM_VALUE) }))).status).toBe(
    204,
  )
})

test('writes to one name land in the order sent', async () => {
  const kv = memoryKV()
  const base = memoryKV()
  // The first write is slow: it must still land before the second.
  const slow = {
    ...base,
    async set(key: string, value: string) {
      if (value.includes('"v":"first"')) await new Promise((r) => setTimeout(r, 20))
      await kv.set(key, value)
    },
    get: kv.get,
    del: kv.del,
    keys: kv.keys,
  }
  const h = createChartStorageHandler(profileStorage(slow, 'p1'))
  await Promise.all([
    h(msg({ op: 'set', key: DRAW, value: 'first' })),
    h(msg({ op: 'set', key: DRAW, value: 'second' })),
  ])
  expect(await h(msg({ op: 'get', key: DRAW }))).toEqual({ status: 200, body: 'second' })
})

test('a record write that fails does not block the next one', async () => {
  let fail = true
  const kv = memoryKV()
  const flaky = {
    ...kv,
    async set(key: string, value: string) {
      if (fail) {
        fail = false
        throw new Error('disk')
      }
      await kv.set(key, value)
    },
  }
  const h = createChartStorageHandler(profileStorage(flaky, 'p1'))
  await expect(h(msg({ op: 'set', key: DRAW, value: 'a' }))).rejects.toThrow('disk')
  expect((await h(msg({ op: 'set', key: DRAW, value: 'b' }))).status).toBe(204)
})

test('readChartRecords and writeChartRecords round-trip; same key replaced, the rest kept', async () => {
  const s = profileStorage(memoryKV(), 'p1')
  const h = createChartStorageHandler(s)
  await h(msg({ op: 'set', key: DRAW, value: 'old' }))
  await h(msg({ op: 'set', key: 'oac-widget:chart:drawings:NSE:TCS', value: 'keep' }))
  const n = await writeChartRecords(s, {
    drawings: [{ k: DRAW, v: 'new' }],
    prefs: [
      { k: 'oac-widget:chart:state', v: 's' },
      { k: DRAW + 'x', v: 'wrong section' },
    ],
  })
  expect(n).toBe(2)
  const r = await readChartRecords(s)
  expect(r.drawings).toEqual([
    { k: DRAW, v: 'new' },
    { k: 'oac-widget:chart:drawings:NSE:TCS', v: 'keep' },
  ])
  expect(r.prefs).toEqual([{ k: 'oac-widget:chart:state', v: 's' }])
})
