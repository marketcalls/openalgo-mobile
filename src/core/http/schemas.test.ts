import { z } from 'zod'
import analyzerAnalyze from '../../../test/fixtures/openalgo-docs/analyzer-analyze.json'
import analyzerLive from '../../../test/fixtures/openalgo-docs/analyzer-live.json'
import depth from '../../../test/fixtures/openalgo-docs/depth.json'
import funds from '../../../test/fixtures/openalgo-docs/funds.json'
import multiquotes from '../../../test/fixtures/openalgo-docs/multiquotes.json'
import {
  AnalyzerSchema,
  AppInfoSchema,
  DepthSchema,
  envelope,
  FundsSchema,
  MultiQuotesSchema,
  PingSchema,
  QuotesSchema,
  SearchSchema,
  SwaggerSchema,
} from './schemas'

/** A deep copy with every number turned into a string, as some brokers send them. */
function allStrings(v: unknown): unknown {
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(allStrings)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, allStrings(x)]))
  }
  return v
}

describe('envelope', () => {
  const s = envelope(z.object({ n: z.number() }))
  test('parses a success envelope to its data', () => {
    expect(s.parse({ status: 'success', data: { n: 1 } })).toEqual({ n: 1 })
  })
  test('rejects an error envelope and a bare payload', () => {
    expect(s.safeParse({ status: 'error', data: { n: 1 } }).success).toBe(false)
    expect(s.safeParse({ n: 1 }).success).toBe(false)
  })
})

describe('MultiQuotesSchema', () => {
  test('the docs fixture and an all-strings copy give the same output', () => {
    const a = MultiQuotesSchema.parse(multiquotes)
    expect(MultiQuotesSchema.parse(allStrings(multiquotes))).toEqual(a)
    expect(a).toHaveLength(3)
    expect(a[0]).toEqual({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      data: {
        open: 1542.3,
        high: 1571.6,
        low: 1540.5,
        ltp: 1569.9,
        prev_close: 1539.7,
        ask: 1569.9,
        bid: 0,
        oi: 0,
        volume: 14054299,
      },
    })
  })

  test('an invalid entry keeps its error and has no data', () => {
    const out = MultiQuotesSchema.parse({
      status: 'success',
      results: [{ symbol: 'NOPE', exchange: 'NSE', error: 'Symbol not found' }],
    })
    expect(out).toEqual([{ symbol: 'NOPE', exchange: 'NSE', error: 'Symbol not found' }])
  })

  test('empty and null prices become undefined', () => {
    const [q] = MultiQuotesSchema.parse({
      status: 'success',
      results: [{ symbol: 'X', exchange: 'NSE', data: { ltp: '10.5', oi: '', bid: null } }],
    })
    expect(q?.data).toEqual({ ltp: 10.5 })
  })
})

test('QuotesSchema coerces the quote fields', () => {
  expect(QuotesSchema.parse({ status: 'success', data: { ltp: '1.5', volume: '7' } })).toEqual({
    ltp: 1.5,
    volume: 7,
  })
})

test('DepthSchema: the docs fixture and an all-strings copy agree, without _source', () => {
  const d = DepthSchema.parse(depth)
  expect(DepthSchema.parse(allStrings(depth))).toEqual(d)
  expect(d.bids).toHaveLength(5)
  expect(d.asks[0]).toEqual({ price: 769.6, quantity: 767 })
  expect(d).toMatchObject({ ltp: 769.6, ltq: 205, totalbuyqty: 591351, totalsellqty: 835701 })
  expect(d).not.toHaveProperty('_source')
})

test('FundsSchema turns the docs strings into numbers', () => {
  expect(FundsSchema.parse(funds)).toEqual({
    availablecash: 320.66,
    collateral: 0,
    m2mrealized: 3.27,
    m2munrealized: -7.88,
    utiliseddebits: 679.34,
  })
})

test('AnalyzerSchema reads both docs fixtures and the toggle message', () => {
  expect(AnalyzerSchema.parse(analyzerLive)).toEqual({
    mode: 'live',
    analyze_mode: false,
    total_logs: 0,
  })
  expect(AnalyzerSchema.parse(analyzerAnalyze).mode).toBe('analyze')
  const toggled = AnalyzerSchema.parse({
    status: 'success',
    data: { mode: 'live', analyze_mode: 'false', message: 'Analyzer mode switched to live' },
  })
  expect(toggled).toEqual({
    mode: 'live',
    analyze_mode: false,
    message: 'Analyzer mode switched to live',
  })
  expect(AnalyzerSchema.safeParse({ status: 'success', data: { mode: 'paper' } }).success).toBe(
    false,
  )
})

test('SearchSchema coerces loose instrument fields and allows an empty list', () => {
  const out = SearchSchema.parse({
    status: 'success',
    message: 'Found 1 matching symbols',
    data: [
      {
        symbol: 'NIFTY',
        brsymbol: 'NIFTY',
        name: null,
        exchange: 'NSE_INDEX',
        token: 26000,
        expiry: '',
        strike: '-1',
        lotsize: '1',
        instrumenttype: 'INDEX',
        tick_size: '0.05',
        freeze_qty: null,
      },
    ],
  })
  expect(out).toEqual([
    {
      symbol: 'NIFTY',
      name: null,
      exchange: 'NSE_INDEX',
      token: '26000',
      expiry: '',
      strike: -1,
      lotsize: 1,
      instrumenttype: 'INDEX',
      tick_size: 0.05,
      freeze_qty: undefined,
    },
  ])
  expect(SearchSchema.parse({ status: 'success', data: [] })).toEqual([])
})

test('PingSchema reads message and broker', () => {
  expect(
    PingSchema.parse({ status: 'success', data: { message: 'pong', broker: 'zerodha' } }),
  ).toEqual({ message: 'pong', broker: 'zerodha' })
})

test('AppInfoSchema accepts only a string version', () => {
  const body = { status: 'success', version: '2.0.3.5', name: 'OpenAlgo' }
  expect(AppInfoSchema.parse(body).version).toBe('2.0.3.5')
  expect(AppInfoSchema.safeParse({ ...body, version: 2 }).success).toBe(false)
  expect(AppInfoSchema.safeParse({ status: 'success' }).success).toBe(false)
})

test('SwaggerSchema gives the endpoint ids: each paths key with its slashes trimmed', () => {
  const spec = {
    swagger: '2.0',
    info: { version: '1.0' },
    paths: { '/placeorder/': {}, '/portfolio/benchmarks': {}, '/market/timings/': {} },
  }
  expect(SwaggerSchema.parse(spec)).toEqual([
    'placeorder',
    'portfolio/benchmarks',
    'market/timings',
  ])
  expect(SwaggerSchema.safeParse({ swagger: '2.0' }).success).toBe(false)
  expect(SwaggerSchema.safeParse({ paths: [] }).success).toBe(false)
})
