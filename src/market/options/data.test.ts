import { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import { createServerClock } from '~/core/http/serverClock'
import { qk } from '~/core/query/keys'
import { expectLog, keepExpectedLogs } from '../../../test/helpers/consoleLogs'
import { createOptionsData } from './data'
import { ExpirySchema, OptionChainSchema } from './schemas'

// 10:30 IST on 2026-11-24
const T0 = Date.UTC(2026, 10, 24, 5, 0)
const PID = 'p1'

const leg = (symbol: string, o: Record<string, unknown> = {}) => ({
  symbol,
  label: 'ATM',
  ltp: 120.5,
  bid: 120.4,
  ask: 120.6,
  bid_qty: 650,
  ask_qty: 1300,
  open: 110,
  high: 130,
  low: 105,
  prev_close: 112,
  volume: 125000,
  oi: 5200000,
  lotsize: 65,
  tick_size: 0.05,
  ...o,
})

/** A 2.0.0.0 reply (b7cdf2636): no quote identity, expiry instant, server clock or Greeks. */
const OLD_CHAIN = {
  status: 'success',
  underlying: 'NIFTY',
  underlying_ltp: '24010.5',
  underlying_prev_close: 23950,
  expiry_date: '30DEC26',
  atm_strike: 24000,
  chain: [
    { strike: 23950, ce: leg('NIFTY30DEC2623950CE', { label: 'ITM1', oi: '4100000' }), pe: null },
    { strike: '24000', ce: leg('NIFTY30DEC2624000CE'), pe: leg('NIFTY30DEC2624000PE') },
  ],
}

/** A 2.0.2.0+ reply with Greeks on one leg. */
const NEW_CHAIN = {
  ...OLD_CHAIN,
  underlying_symbol: 'NIFTY',
  underlying_exchange: 'NSE_INDEX',
  expiry_ts: 1798624800,
  server_ts: T0 / 1000 + 180,
  quotes_included: true,
  greeks_included: true,
  forward_price: 24035.25,
  chain: [
    {
      strike: 24000,
      ce: leg('NIFTY30DEC2624000CE', {
        implied_volatility: 14.21,
        delta: 0.5123,
        gamma: 0.000412,
        theta: -12.3456,
        vega: 25.1234,
      }),
      // a leg the server could not price keeps no Greek fields
      pe: leg('NIFTY30DEC2624000PE'),
    },
  ],
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 })
  keepExpectedLogs()
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

type Call = { id: string; body: Record<string, unknown>; signal?: AbortSignal }

function setup(replies: (id: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  const api: Pick<Api, 'call'> = {
    async call(id, body, schema, o) {
      calls.push({ id, body, signal: o?.signal })
      const reply = replies(id, body)
      if (reply instanceof Error) throw reply
      return schema.parse(reply)
    },
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const clock = createServerClock(() => Date.now())
  const options = createOptionsData({ api, queryClient, pid: PID, clock })
  return { options, calls, queryClient, clock }
}

const expiryReply = (data: string[]) => ({ status: 'success', message: 'Found', data })
const quoteReply = (ltp: number) => ({
  status: 'success',
  data: { ltp, prev_close: ltp - 50, open: 0, high: 0, low: 0, volume: 0, oi: 0, bid: 0, ask: 0 },
})

describe('schemas', () => {
  test('ExpirySchema reads the DD-MMM-YY list', () => {
    expect(ExpirySchema.parse(expiryReply(['02-DEC-26', '30-DEC-26']))).toEqual([
      '02-DEC-26',
      '30-DEC-26',
    ])
  })

  test('OptionChainSchema reads a 2.0.0.0 chain: numbers coerced, a missing leg null, no Greeks', () => {
    const c = OptionChainSchema.parse(OLD_CHAIN)
    expect(c.underlying_ltp).toBe(24010.5)
    expect(c.underlying_symbol).toBeUndefined()
    expect(c.expiry_ts).toBeUndefined()
    expect(c.server_ts).toBeUndefined()
    expect(c.chain.map((r) => r.strike)).toEqual([23950, 24000])
    expect(c.chain[0]?.pe).toBeNull()
    expect(c.chain[0]?.ce?.oi).toBe(4100000)
    expect(c.chain[1]?.pe?.implied_volatility).toBeUndefined()
  })

  test('OptionChainSchema reads 2.0.2.0 fields and leg Greeks where the server sent them', () => {
    const c = OptionChainSchema.parse(NEW_CHAIN)
    expect(c).toMatchObject({
      underlying_symbol: 'NIFTY',
      underlying_exchange: 'NSE_INDEX',
      expiry_ts: 1798624800,
      greeks_included: true,
      forward_price: 24035.25,
    })
    expect(c.chain[0]?.ce).toMatchObject({ implied_volatility: 14.21, delta: 0.5123 })
    expect(c.chain[0]?.pe?.delta).toBeUndefined()
    // null instead of a number: the server's own get(…, 0) default
    const nulls = OptionChainSchema.parse({
      ...NEW_CHAIN,
      forward_price: null,
      expiry_ts: null,
      chain: [{ strike: 24000, ce: leg('X', { ltp: null, oi: null }), pe: null }],
    })
    expect(nulls.forward_price).toBeNull()
    expect(nulls.expiry_ts).toBeNull()
    expect(nulls.chain[0]?.ce).toMatchObject({ ltp: 0, oi: 0 })
  })

  test('a leg the server sent no ltp for reads 0 and says so; an ltp of 0 is a price', () => {
    const legs = OptionChainSchema.parse({
      ...OLD_CHAIN,
      chain: [
        { strike: 23900, ce: leg('A', { ltp: null }), pe: leg('B', { ltp: '' }) },
        { strike: 23950, ce: leg('C', { ltp: undefined }), pe: leg('D', { ltp: 'n/a' }) },
        { strike: 24000, ce: leg('E', { ltp: 0 }), pe: leg('F', { ltp: '95.5' }) },
      ],
    }).chain.flatMap((r) => [r.ce, r.pe])
    expect(legs.map((l) => [l?.symbol, l?.ltp, l?.ltpMissing])).toEqual([
      ['A', 0, true],
      ['B', 0, true],
      ['C', 0, true],
      ['D', 0, true],
      ['E', 0, undefined],
      ['F', 95.5, undefined],
    ])
    // a priced leg carries no marker, so its parse is the server's fields only
    expect(legs[4]).not.toHaveProperty('ltpMissing')
  })
})

describe('OptionsData', () => {
  test('expiries are read once per IST day', async () => {
    const { options, calls, queryClient } = setup((_id, body) =>
      expiryReply(body.instrumenttype === 'options' ? ['02-DEC-26', '30-DEC-26'] : ['30-DEC-26']),
    )
    expect(await options.expiries('NFO', 'NIFTY', 'options')).toEqual(['02-DEC-26', '30-DEC-26'])
    expect(await options.expiries('NFO', 'NIFTY', 'options')).toEqual(['02-DEC-26', '30-DEC-26'])
    expect(await options.expiries('NFO', 'NIFTY', 'futures')).toEqual(['30-DEC-26'])
    expect(calls.map((c) => [c.id, c.body])).toEqual([
      ['expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'options' }],
      ['expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'futures' }],
    ])
    expect(queryClient.getQueryData(qk.expiry(PID, 'NFO', 'NIFTY', 'options'))).toEqual([
      '02-DEC-26',
      '30-DEC-26',
    ])

    // late the same IST day: still cached
    jest.setSystemTime(Date.UTC(2026, 10, 24, 18, 29)) // 23:59 IST
    await options.expiries('NFO', 'NIFTY', 'options')
    expect(calls).toHaveLength(2)
    // 00:01 IST the next day: read again
    jest.setSystemTime(Date.UTC(2026, 10, 24, 18, 31))
    await options.expiries('NFO', 'NIFTY', 'options')
    expect(calls).toHaveLength(3)
    queryClient.clear()
  })

  test("expiries roll with the server's IST day, not a skewed phone clock", async () => {
    const { options, calls, queryClient, clock } = setup(() => expiryReply(['30-DEC-26']))
    // the phone is 3 minutes ahead of the server
    jest.setSystemTime(Date.UTC(2026, 10, 24, 18, 31)) // the phone says 00:01 IST
    clock.noteServerTs((Date.now() - 180_000) / 1000, Date.now()) // the server says 23:58
    await options.expiries('NFO', 'NIFTY', 'options')
    jest.setSystemTime(Date.UTC(2026, 10, 24, 18, 32)) // server 23:59
    await options.expiries('NFO', 'NIFTY', 'options')
    expect(calls).toHaveLength(1)
    jest.setSystemTime(Date.UTC(2026, 10, 24, 18, 34)) // server 00:01: the list may have changed
    await options.expiries('NFO', 'NIFTY', 'options')
    expect(calls).toHaveLength(2)
    queryClient.clear()
  })

  test('futuresPrice prefers the same-expiry FUT, else the nearest; CRYPTO uses the chain LTP', async () => {
    let futures = ['30-DEC-26', '27-JAN-27']
    const { options, calls, queryClient } = setup((id, body) => {
      if (id === 'expiry') return expiryReply(futures)
      if (id === 'quotes' && body.symbol === 'NIFTY30DEC26FUT') return quoteReply(24100.5)
      if (id === 'quotes' && body.symbol === 'NIFTY27JAN27FUT') return quoteReply(24200)
      return new ApiError({ kind: 'Validation', status: 400, endpoint: id })
    })
    const quotes = () => calls.filter((c) => c.id === 'quotes').map((c) => c.body)

    // the chain's own expiry has a future
    expect(await options.futuresPrice('NIFTY', 'NFO', '27JAN27', 24000)).toBe(24200)
    // a weekly expiry has none: the nearest future
    expect(await options.futuresPrice('NIFTY', 'NFO', '02DEC26', 24000)).toBe(24100.5)
    expect(quotes()).toEqual([
      { symbol: 'NIFTY27JAN27FUT', exchange: 'NFO' },
      { symbol: 'NIFTY30DEC26FUT', exchange: 'NFO' },
    ])
    // the futures list is the day's cached /expiry read
    expect(calls.filter((c) => c.id === 'expiry')).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'futures' })

    // the perpetual is what the chain already quotes
    expect(await options.futuresPrice('BTC', 'CRYPTO', '28FEB27', 90123.5)).toBe(90123.5)
    expect(calls.filter((c) => c.body.symbol === 'BTC' || c.body.exchange === 'CRYPTO')).toEqual([])

    // no future listed, or its quote refused: no price
    futures = []
    expect(await options.futuresPrice('USDINR', 'CDS', '26DEC26', 84.1)).toBeNull()
    expect(calls.filter((c) => c.body.exchange === 'CDS').map((c) => c.id)).toEqual(['expiry'])
    futures = ['24-DEC-26']
    const warned = expectLog('warn', /\[options\] futures price/)
    expect(await options.futuresPrice('BANKNIFTY', 'NFO', '24DEC26', 52000)).toBeNull()
    expect(quotes().at(-1)).toEqual({ symbol: 'BANKNIFTY24DEC26FUT', exchange: 'NFO' })
    expect(warned).toHaveLength(1)
    queryClient.clear()
  })

  test('chain sends with_greeks only when asked and notes server_ts in the clock', async () => {
    const { options, calls, clock } = setup((_id, body) =>
      body.with_greeks ? NEW_CHAIN : OLD_CHAIN,
    )
    const q = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '30DEC26', strike_count: 10 }
    const ctrl = new AbortController()

    const old = await options.chain(q, { signal: ctrl.signal })
    expect(old.atm_strike).toBe(24000)
    expect(calls[0]).toEqual({ id: 'optionchain', body: q, signal: ctrl.signal })
    // a 2.0.0.0 reply has no server_ts: the clock keeps the Date header's reading
    expect(clock.offsetMs()).toBe(0)

    await options.chain({ ...q, with_greeks: false })
    expect(calls[1]?.body).toEqual(q)
    await options.chain({ ...q, with_greeks: true })
    expect(calls[2]?.body).toEqual({ ...q, with_greeks: true })
    expect(clock.offsetMs()).toBe(180_000)
    expect(clock.now()).toBe(T0 + 180_000)
  })
})
