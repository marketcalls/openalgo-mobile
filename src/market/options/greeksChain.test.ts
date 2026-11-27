import { chainReply, cutoffSec } from '../../../test/helpers/chains'
import { chainForward, withGreeksChain } from './black76'
import { serverYears } from './expiry'
import { ensureChainGreeks } from './greeksChain'
import { type ChainLeg, type OptionChain, OptionChainSchema } from './schemas'

// Mon 30 Nov 2026, 10:30 IST: the 02DEC26 expiry is two days and five hours away
const NOW = Date.UTC(2026, 10, 30, 5, 0)
const GREEKS = ['implied_volatility', 'delta', 'gamma', 'theta', 'vega'] as const

const chainOf = (spec: Parameters<typeof chainReply>[0] = {}, o: Record<string, unknown> = {}) =>
  OptionChainSchema.parse({ ...chainReply(spec), ...o })

const greeksOf = (leg: ChainLeg | null) =>
  leg ? Object.fromEntries(GREEKS.filter((k) => k in leg).map((k) => [k, leg[k]])) : null
const withoutGreeks = (leg: ChainLeg | null) =>
  leg
    ? Object.fromEntries(
        Object.entries(leg).filter(([k]) => !(GREEKS as readonly string[]).includes(k)),
      )
    : null

test('a chain the server priced is returned as it is', () => {
  const priced = chainOf({}, { greeks_included: true, forward_price: 24601.25 })
  expect(ensureChainGreeks(priced, { optionsExchange: 'NFO', nowMs: NOW })).toBe(priced)
})

test("a 2.0.0.0 chain gets the server's forward, expiry instant and per-leg Greeks (RF 4)", () => {
  const old = chainOf({ old: true, expiry: '02DEC26', each: 3 })
  const before = structuredClone(old)
  const c = ensureChainGreeks(old, { optionsExchange: 'NFO', nowMs: NOW })

  const forward = chainForward(old.chain, old.atm_strike, old.underlying_ltp)
  const { years } = serverYears(cutoffSec('02DEC26') * 1000, NOW)
  const want = withGreeksChain(old.chain, { forward, years })
  expect(c.forward_price).toBe(forward)
  expect(c.expiry_ts).toBe(cutoffSec('02DEC26'))
  expect(c.greeks_included).toBe(true)
  c.chain.forEach((row, i) => {
    for (const side of ['ce', 'pe'] as const) {
      const g = want[i]?.[side]
      if (!g) throw new Error(`every leg of this chain is priced (${row.strike} ${side})`)
      expect(greeksOf(row[side])).toEqual({
        implied_volatility: g.iv,
        delta: g.delta,
        gamma: g.gamma,
        theta: g.theta,
        vega: g.vega,
      })
      // the rest of the leg is the server's
      expect(withoutGreeks(row[side])).toEqual(old.chain[i]?.[side])
    }
  })
  // the polled chain is never changed
  expect(old).toEqual(before)
})

test("the server's own expiry_ts prices the legs; an unpriced leg gets no Greek fields", () => {
  const c0 = chainOf({ expiry: '02DEC26', each: 2 })
  const rows = c0.chain.map((r) =>
    r.strike === c0.atm_strike + 50 && r.ce ? { ...r, ce: { ...r.ce, ltp: 0 } } : r,
  )
  // a server that sends expiry_ts but prices nothing (greeks_included false, as the mock does)
  const later = cutoffSec('02DEC26') + 3600
  const c = ensureChainGreeks(
    { ...c0, expiry_ts: later, chain: rows },
    { optionsExchange: 'NFO', nowMs: NOW },
  )
  expect(c.expiry_ts).toBe(later)
  const { years } = serverYears(later * 1000, NOW)
  const forward = chainForward(rows, c0.atm_strike, c0.underlying_ltp)
  const want = withGreeksChain(rows, { forward, years })
  const unpriced = c.chain.find((r) => r.strike === c0.atm_strike + 50)
  expect(unpriced?.ce).toBeTruthy()
  for (const k of GREEKS) expect(unpriced?.ce && k in unpriced.ce).toBe(false)
  expect(unpriced?.pe?.gamma).toBe(want[3]?.pe?.gamma)
})

test('an expired chain, or one with no expiry instant, keeps its legs bare', () => {
  const bare = (c: OptionChain) =>
    c.chain.every((r) => [r.ce, r.pe].every((leg) => leg && GREEKS.every((k) => !(k in leg))))

  const expired = ensureChainGreeks(chainOf({ old: true, expiry: '27NOV26', each: 2 }), {
    optionsExchange: 'NFO',
    nowMs: NOW,
  })
  expect(bare(expired)).toBe(true)
  expect(expired.greeks_included).toBe(true)
  expect(expired.expiry_ts).toBe(cutoffSec('27NOV26'))

  // 31 NOV is no date: the server derives no expiry_ts and prices nothing
  const undated = ensureChainGreeks(chainOf({ old: true, each: 2 }, { expiry_date: '31NOV26' }), {
    optionsExchange: 'NFO',
    nowMs: NOW,
  })
  expect(undated.expiry_ts).toBeNull()
  expect(bare(undated)).toBe(true)
})

test('the cut-off is the options exchange’s: MCX prices to 23:30 IST', () => {
  const mcx = ensureChainGreeks(chainOf({ old: true, expiry: '02DEC26', each: 1 }), {
    optionsExchange: 'MCX',
    nowMs: NOW,
  })
  expect(mcx.expiry_ts).toBe(Date.UTC(2026, 11, 2, 18, 0) / 1000)
})
