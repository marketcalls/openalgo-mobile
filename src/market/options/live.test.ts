import { chainGreeks, forwardFromParity, priceForGreeks } from '@/lib/optionGreeks'
import type { Quote } from '~/core/realtime/protocol'
import { chainReply, cutoffSec } from '../../../test/helpers/chains'
import {
  CHAIN_REFRESH_LIVE_MS,
  chainExpiryTs,
  DEFAULT_STRIKE_COUNT,
  FORWARD_THROTTLE_MS,
  liveChain,
  livePricing,
  mergeLeg,
  priceRow,
  STRIKE_COUNTS,
  underlyingOf,
} from './live'
import { type OptionChain, OptionChainSchema } from './schemas'

const chainOf = (spec: Parameters<typeof chainReply>[0] = {}): OptionChain =>
  OptionChainSchema.parse(chainReply(spec))

/** A depth tick as the store holds it. */
const tick = (ltp: number, bid: number, ask: number, extra: Partial<Quote> = {}): Quote => ({
  ltp,
  depth: {
    buy: [{ price: bid, quantity: 150 }],
    sell: [{ price: ask, quantity: 225 }],
    levels: 1,
  },
  ts: 1,
  dir: 0,
  source: 'ws',
  ...extra,
})

const NOW = Date.UTC(2026, 10, 30, 5, 0) // Mon 30 Nov 2026, 10:30 IST
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW))
afterEach(() => jest.restoreAllMocks())

test('the strike counts, the refresh and the throttle are the web page’s', () => {
  expect(STRIKE_COUNTS).toEqual([5, 10, 15, 20, 25])
  expect(DEFAULT_STRIKE_COUNT).toBe(10)
  expect(CHAIN_REFRESH_LIVE_MS).toBe(30_000)
  expect(FORWARD_THROTTLE_MS).toBe(1000)
})

describe('chainExpiryTs', () => {
  test('chainExpiryTs derives 15:30 IST from DDMMMYY when expiry_ts is absent (RF 4)', () => {
    const old = chainOf({ old: true, expiry: '02DEC26' })
    expect(old.expiry_ts).toBeUndefined()
    // 15:30 IST is 10:00 UTC
    expect(chainExpiryTs(old, 'NFO')).toBe(Date.UTC(2026, 11, 2, 10, 0) / 1000)
    expect(chainExpiryTs(old, 'BFO')).toBe(cutoffSec('02DEC26'))
    // the exchange's own cut-off: MCX 23:30, CDS 12:30
    expect(chainExpiryTs(old, 'MCX')).toBe(Date.UTC(2026, 11, 2, 18, 0) / 1000)
    expect(chainExpiryTs(old, 'CDS')).toBe(Date.UTC(2026, 11, 2, 7, 0) / 1000)
  })

  test("the server's expiry_ts wins; a null one (not derived there) is derived here", () => {
    expect(chainExpiryTs(chainOf({ expiryTs: 1_800_000_000 }), 'NFO')).toBe(1_800_000_000)
    const unset = OptionChainSchema.parse({ ...chainReply(), expiry_ts: null })
    expect(chainExpiryTs(unset, 'NFO')).toBe(cutoffSec('02DEC26'))
  })

  test('an expiry that is not a date has none', () => {
    const bad = OptionChainSchema.parse({ ...chainReply({ old: true }), expiry_date: '31NOV26' })
    expect(chainExpiryTs(bad, 'NFO')).toBeNull()
  })
})

describe('underlyingOf', () => {
  test('underlyingOf without underlying_symbol: NIFTY → NSE_INDEX, SENSEX → BSE_INDEX, RELIANCE → NSE, CRUDEOIL → its near FUT', () => {
    const old = chainOf({ old: true })
    expect(underlyingOf('NIFTY', 'NFO', old, [])).toEqual({
      symbol: 'NIFTY',
      exchange: 'NSE_INDEX',
    })
    expect(underlyingOf('NIFTYNXT50', 'NFO', old, [])).toEqual({
      symbol: 'NIFTYNXT50',
      exchange: 'NSE_INDEX',
    })
    expect(underlyingOf('SENSEX', 'BFO', old, [])).toEqual({
      symbol: 'SENSEX',
      exchange: 'BSE_INDEX',
    })
    expect(underlyingOf('RELIANCE', 'NFO', old, [])).toEqual({
      symbol: 'RELIANCE',
      exchange: 'NSE',
    })
    expect(underlyingOf('RELIANCE', 'BFO', old, [])).toEqual({
      symbol: 'RELIANCE',
      exchange: 'BSE',
    })
    expect(underlyingOf('CRUDEOIL', 'MCX', old, ['19-DEC-26', '19-JAN-27'])).toEqual({
      symbol: 'CRUDEOIL19DEC26FUT',
      exchange: 'MCX',
    })
    expect(underlyingOf('USDINR', 'CDS', old, ['29-DEC-26'])).toEqual({
      symbol: 'USDINR29DEC26FUT',
      exchange: 'CDS',
    })
  })

  test('a future the futures list does not name, and a CRYPTO chain, hold no underlying', () => {
    const old = chainOf({ old: true })
    expect(underlyingOf('CRUDEOIL', 'MCX', old, [])).toBeNull()
    // the chain poll's underlying_ltp is the price there
    expect(underlyingOf('BTC', 'CRYPTO', old, [])).toBeNull()
  })

  test("the server's quote identity wins (2.0.2.0+)", () => {
    const fresh = chainOf({ underlying: 'CRUDEOIL', underlyingExchange: 'MCX' })
    const named = { ...fresh, underlying_symbol: 'CRUDEOIL19DEC26FUT' }
    expect(underlyingOf('CRUDEOIL', 'MCX', named, [])).toEqual({
      symbol: 'CRUDEOIL19DEC26FUT',
      exchange: 'MCX',
    })
    expect(underlyingOf('NIFTY', 'NFO', chainOf(), [])).toEqual({
      symbol: 'NIFTY',
      exchange: 'NSE_INDEX',
    })
  })
})

describe('liveChain', () => {
  const o = { optionsExchange: 'NFO', underlyingKey: 'NSE_INDEX:NIFTY', clockOffsetMs: 0 }

  test('a tick replaces the LTP and the top of the book, rounded to the tick', () => {
    const c = chainOf()
    const leg = c.chain[10]?.ce
    if (!leg) throw new Error('no ATM call')
    const merged = mergeLeg(leg, tick(120.523, 120.47, 120.61))
    expect(merged).toMatchObject({
      ltp: 120.5,
      bid: 120.45,
      ask: 120.6,
      bid_qty: 150,
      ask_qty: 225,
    })
    // a quote without depth takes its own bid and ask; one without either keeps the chain's
    const top = mergeLeg(leg, { ltp: 99, bid: 98.9, ask: 99.2, ts: 1, dir: 0, source: 'ws' })
    expect(top).toMatchObject({ ltp: 99, bid: 98.9, ask: 99.2, bid_qty: leg.bid_qty })
    expect(mergeLeg(leg, undefined)).toBe(leg)
  })

  test('Greeks per leg from the mid, the forward from the ATM pair, t from the expiry', () => {
    const c = chainOf()
    const atmCe = c.chain[10]?.ce
    const atmPe = c.chain[10]?.pe
    if (!atmCe || !atmPe) throw new Error('no ATM pair')
    const quotes = new Map<string, Quote>([
      ['NSE_INDEX:NIFTY', { ltp: 24590, ts: 1, dir: 0, source: 'ws' }],
      [`NFO:${atmCe.symbol}`, tick(150, 149.8, 150.2)],
      [`NFO:${atmPe.symbol}`, tick(140, 139.9, 140.1)],
    ])
    const live = liveChain(c, (k) => quotes.get(k), o)

    const F = forwardFromParity(c.atm_strike, 150, 140, 24590)
    expect(F).toBe(c.atm_strike + 10)
    const t = (cutoffSec('02DEC26') * 1000 - NOW) / 1000 / 86400 / 365
    expect(live.underlying_ltp).toBe(24590)
    expect(live.forward_price).toBe(F)
    const want = chainGreeks(
      live.chain.map((r) => ({
        strike: r.strike,
        cePrice: r.ce ? priceForGreeks(r.ce.ltp, r.ce.bid, r.ce.ask) : 0,
        pePrice: r.pe ? priceForGreeks(r.pe.ltp, r.pe.bid, r.pe.ask) : 0,
      })),
      F,
      t,
    )
    live.chain.forEach((r, i) => {
      expect(r.ce?.implied_volatility).toBe(want[i]?.ce?.iv)
      expect(r.ce?.delta).toBe(want[i]?.ce?.delta)
      expect(r.pe?.gamma).toBe(want[i]?.pe?.gamma)
      expect(r.pe?.vega).toBe(want[i]?.pe?.vega)
    })
    expect(live.chain[10]?.ce?.delta).toBeGreaterThan(0.3)
    expect(live.chain[10]?.pe?.delta).toBeLessThan(-0.3)
  })

  test('a clock 3 minutes behind the server shortens t by those minutes', () => {
    const c = chainOf()
    const offset = 180_000
    const p = livePricing(c, () => undefined, { ...o, clockOffsetMs: offset })
    expect(p.years).toBeCloseTo((cutoffSec('02DEC26') * 1000 - NOW - offset) / 31_536_000_000, 12)
    expect(p.spot).toBe(c.underlying_ltp)
  })

  test('each row priced alone equals the chain priced at once', () => {
    const c = chainOf()
    const live = liveChain(c, () => undefined, o)
    const p = livePricing(c, () => undefined, o)
    c.chain.forEach((r, i) => {
      expect(priceRow(r, p)).toEqual(live.chain[i])
    })
  })

  test("an expired chain keeps the server's Greeks and forward; nothing is clamped", () => {
    const c = OptionChainSchema.parse({
      ...chainReply({ expiryTs: NOW / 1000 - 60 }),
      forward_price: 24601.5,
    })
    const withServer = {
      ...c,
      chain: c.chain.map((r) => ({ ...r, ce: r.ce && { ...r.ce, delta: 0.42 } })),
    }
    const live = liveChain(withServer, () => undefined, o)
    expect(livePricing(withServer, () => undefined, o)).toEqual({
      spot: c.underlying_ltp,
      forward: null,
      years: 0,
    })
    expect(live.forward_price).toBe(24601.5)
    expect(live.chain[3]?.ce?.delta).toBe(0.42)
    expect(live.chain[3]?.pe?.delta).toBeUndefined()
  })
})
