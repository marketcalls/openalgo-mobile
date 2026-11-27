import {
  ChartIntentSchema,
  DomToNativeSchema,
  NativeToDomBatchSchema,
  parseDomToNative,
} from './schemas'

const req = {
  v: 1,
  kind: 'request',
  rid: 1,
  method: 'POST',
  path: '/api/v1/history',
  body: { symbol: 'INFY' },
}
const inst = { exchange: 'NSE', symbol: 'INFY' }
const ok = (x: unknown) => DomToNativeSchema.safeParse(x).success

test('a DOM request parses', () => expect(ok(req)).toBe(true))

test('another version, an unknown kind or an extra key is refused', () => {
  expect(ok({ ...req, v: 2 })).toBe(false)
  const { v: _v, ...noVersion } = req
  expect(ok(noVersion)).toBe(false)
  expect(ok({ ...req, query: { a: 1 } })).toBe(false)
  expect(ok({ ...req, query: { a: 'b' } })).toBe(true)
  expect(ok({ ...req, kind: 'eval' })).toBe(false)
  expect(ok({ ...req, x: 1 })).toBe(false)
})

test.each(['https://evil.example/x', '/api/../auth/x', '//host/x', '\\x', 'api/v1/x'])(
  'the path %s is refused',
  (path) => expect(ok({ ...req, path })).toBe(false),
)

test('every message kind parses', () => {
  for (const m of [
    { v: 1, kind: 'abort', rid: 3 },
    { v: 1, kind: 'socket', sid: 0, op: 'open', url: 'wss://native.invalid/ws' },
    { v: 1, kind: 'socket', sid: 999, op: 'send', data: '{}' },
    { v: 1, kind: 'socket', sid: 1, op: 'close' },
    { v: 1, kind: 'storage', op: 'entries', prefix: 'oac-' },
    { v: 1, kind: 'storage', op: 'get', key: 'k' },
    { v: 1, kind: 'storage', op: 'set', key: 'k', value: 'v' },
    { v: 1, kind: 'storage', op: 'remove', key: 'k' },
    { v: 1, kind: 'intent', intent: { type: 'depth', inst } },
    { v: 1, kind: 'event', name: 'loaded' },
    {
      v: 1,
      kind: 'event',
      name: 'ready',
      info: { bars: 1, indicators: 0, mobile: true, csp: true },
    },
    { v: 1, kind: 'event', name: 'error', message: 'x' },
    { v: 1, kind: 'event', name: 'error', message: 'x', load: true },
    { v: 1, kind: 'event', name: 'link', url: 'https://openalgo.in' },
  ])
    expect(ok(m)).toBe(true)
})

test('size limits hold', () => {
  const set = { v: 1, kind: 'storage', op: 'set', key: 'k' }
  expect(ok({ ...set, value: 'x'.repeat(1_000_000) })).toBe(true)
  expect(ok({ ...set, value: 'x'.repeat(1_000_001) })).toBe(false)
  const send = { v: 1, kind: 'socket', sid: 1, op: 'send' }
  expect(ok({ ...send, data: 'x'.repeat(65_536) })).toBe(true)
  expect(ok({ ...send, data: 'x'.repeat(65_537) })).toBe(false)
  expect(ok({ ...send, sid: 1000, data: '' })).toBe(false)
  expect(ok({ ...send, sid: -1, data: '' })).toBe(false)
  expect(ok({ v: 1, kind: 'abort', rid: -1 })).toBe(false)
  expect(ok({ v: 1, kind: 'abort', rid: 2 ** 53 })).toBe(false)
  expect(ok({ ...req, path: `/${'a'.repeat(256)}` })).toBe(false)
  expect(ok({ v: 1, kind: 'event', name: 'error', message: 'x'.repeat(501) })).toBe(false)
  expect(ok({ v: 1, kind: 'event', name: 'error', message: 'x', load: false })).toBe(false)
  expect(ok({ v: 1, kind: 'event', name: 'link', url: 'x'.repeat(2_049) })).toBe(false)
  expect(ok({ v: 1, kind: 'storage', op: 'get', key: 'k'.repeat(257) })).toBe(false)
})

test('an intent needs its instrument and sane numbers', () => {
  const good = { type: 'trade', inst, side: 'BUY', lots: 1 }
  expect(ChartIntentSchema.safeParse(good).success).toBe(true)
  expect(ChartIntentSchema.safeParse({ type: 'trade', side: 'BUY', lots: 1 }).success).toBe(false)
  for (const lots of [0, 10_000, 1.5])
    expect(ChartIntentSchema.safeParse({ ...good, lots }).success).toBe(false)
  for (const price of [NaN, -1, 0, Infinity]) {
    expect(ChartIntentSchema.safeParse({ type: 'priceMenu', inst, price }).success).toBe(false)
    expect(ChartIntentSchema.safeParse({ type: 'modify', inst, orderid: 'a', price }).success).toBe(
      false,
    )
  }
  expect(
    ChartIntentSchema.safeParse({ type: 'modify', inst, orderid: 'a'.repeat(65), price: 1 })
      .success,
  ).toBe(false)
  expect(ChartIntentSchema.safeParse({ type: 'close', inst, product: 'XX' }).success).toBe(false)
  expect(
    ChartIntentSchema.safeParse({ ...good, inst: { exchange: 'nse', symbol: 'A' } }).success,
  ).toBe(false)
  expect(
    ChartIntentSchema.safeParse({ ...good, inst: { ...inst, symbol: 'A'.repeat(65) } }).success,
  ).toBe(false)
})

test('a native batch parses and a malformed one does not', () => {
  const batch = [
    { kind: 'socket', sid: 1, event: 'open' },
    { kind: 'socket', sid: 1, event: 'message', data: '{}' },
    { kind: 'push', topic: 'chart.redraw', payload: null },
  ]
  expect(NativeToDomBatchSchema.safeParse(batch).success).toBe(true)
  expect(
    NativeToDomBatchSchema.safeParse([{ kind: 'socket', sid: 1, event: 'message' }]).success,
  ).toBe(false)
  expect(NativeToDomBatchSchema.safeParse([{ kind: 'eval', code: 'x' }]).success).toBe(false)
  expect(NativeToDomBatchSchema.safeParse({}).success).toBe(false)
})

describe('request body bounds', () => {
  const req = (body: unknown) => ({
    v: 1,
    kind: 'request',
    rid: 1,
    method: 'POST',
    path: '/api/v1/x',
    body,
  })
  const deep = (n: number) => JSON.parse('['.repeat(n) + ']'.repeat(n))
  it('refuses a deeply nested body without throwing', () => {
    for (const n of [10, 5_000, 20_000]) {
      expect(() => DomToNativeSchema.safeParse(req(deep(n)))).not.toThrow()
      expect(DomToNativeSchema.safeParse(req(deep(n))).success).toBe(false)
      expect(parseDomToNative(req(deep(n))).success).toBe(false)
    }
  })
  it('refuses an oversized body and accepts a flat one', () => {
    expect(DomToNativeSchema.safeParse(req(Array(1_001).fill(1))).success).toBe(false)
    expect(DomToNativeSchema.safeParse(req({ symbol: 'INFY', n: 1, a: [1, 2] })).success).toBe(true)
    expect(parseDomToNative(req({ symbol: 'INFY' })).success).toBe(true)
  })
})
