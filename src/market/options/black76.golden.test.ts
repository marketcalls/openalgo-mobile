// The phone's Black-76 against opengreeks 0.2.0 and the server's own Python (design 9.2): the
// synthetic grid in test/golden/expected/black76.json and the recorded chains' legs.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { black76Greeks } from '@/lib/optionGreeks'
import {
  fakeApi,
  type GoldenInput,
  type GreeksBody,
  goldenCases,
  greeksOf,
} from '../../../test/helpers/golden'
import {
  chainForward,
  rawGamma,
  rawGreeks,
  rawIv,
  rawIvAny,
  spotGreeks,
  withGreeksChain,
} from './black76'
import { expiryInstantMs, optionsExchangeOf, serverYears } from './expiry'
import { pyRound } from './pyRound'

type Flag = 'c' | 'p'
type GridRow = {
  flag: Flag
  F: number
  K: number
  t: number
  sigma: number
  price: number
  iv: number | null
  ivError: string | null
  delta: number
  gamma: number
  theta: number
  vega: number
}
type EdgeRow = { label: string; flag: Flag; F: number; K: number; t: number; price: number }
type RawGreeks = { delta: number; gamma: number; theta: number; vega: number }
type EdgeGolden = EdgeRow & { iv: number | null; error: string | null; greeks: RawGreeks | null }
type SymbolRow = {
  label: string
  symbol: string
  exchange: string
  spot: number
  price: number
  nowMs: number
  status: number
  body: GreeksBody
}
type Black76Golden = { rate: number; grid: GridRow[]; edges: EdgeGolden[]; symbols: SymbolRow[] }

const B76: Black76Golden = JSON.parse(
  readFileSync(join(__dirname, '../../../test/golden/expected/black76.json'), 'utf8'),
)

/** What gamma_density_service._safe_iv keeps of opengreeks' answer. */
function safeIv(price: number, F: number, K: number, t: number, iv: number | null) {
  if (!(price > 0) || !(F > 0) || !(K > 0) || !(t > 0)) return null
  return iv !== null && Number.isFinite(iv) && iv > 0 && iv <= 5 ? iv : null
}

/**
 * How far rawIv may sit from opengreeks' IV, on every row: 1e-9 (preflight conflict 10). A miss
 * is answered by the engine (./engine), never by a wider bound here.
 */
const IV_BOUND = 1e-9

/**
 * The one grid row engine.ts misses by more than 1e-9, named, with its own bound: a call 4,800 in
 * the money with 30 days left and 1.8e-5 of time value (vega 3.5e-3). On 15 of the 98 Math.exp
 * calls of its solve, V8 differs in the last bit from the macOS libm the golden was generated on
 * (opengreeks' Rust calls it), which moves the IV by 1.35e-9 (measured). Replayed with libm's exp
 * and log values, the same solve gives opengreeks' IV bit for bit, so no TypeScript engine can
 * close it. A golden regenerated on another libm is measured again before this row changes.
 */
const LIBM_RESIDUE = { flag: 'c', F: 24000, K: 19200, t: 30 / 365, sigma: 0.15, bound: 2e-9 }
const isLibmResidue = (g: GridRow) =>
  g.flag === LIBM_RESIDUE.flag &&
  g.F === LIBM_RESIDUE.F &&
  g.K === LIBM_RESIDUE.K &&
  g.t === LIBM_RESIDUE.t &&
  g.sigma === LIBM_RESIDUE.sigma

/**
 * Of the 808 grid rows both sides solve, 724 give opengreeks' IV bit for bit. A normal CDF or a
 * solver step that is not opengreeks' loses most of them while staying inside 1e-9 on many.
 */
const MIN_BIT_EXACT = 700

/** How rawIv's `got` differs from opengreeks' `want` (kept as _safe_iv keeps it): null if not. */
function ivMiss(got: number | null, want: number | null, bound = IV_BOUND) {
  if (got === null || want === null) return got === want ? null : `${got} for ${want}`
  if (!(Math.abs(got - want) <= bound)) return `|Δ| ${Math.abs(got - want)} > ${bound}`
  return pyRound(got * 100, 2) === pyRound(want * 100, 2) ? null : 'rounded to 2 places'
}

const PLACES = { delta: 4, gamma: 6, theta: 4, vega: 4 } as const

/**
 * Rounded Greeks agree, zero signs included, but for one: where φ(d1) underflows to 0 (d1 above
 * about 38.6) opengreeks' call theta is −(0 + −0 + 0)/365 = −0.0 and the web's is 0. No leg
 * with a solved IV gets there (its time value is at least a tick), and JSON drops the sign.
 */
function sameRounded(k: keyof typeof PLACES, ours: number, want: number, flag: Flag) {
  const a = pyRound(ours, PLACES[k])
  const b = pyRound(want, PLACES[k])
  return Object.is(a, b) || (k === 'theta' && flag === 'c' && a === 0 && Object.is(b, -0))
}

test('the golden grid is the one T5 generated', () => {
  expect(B76.rate).toBe(0)
  expect(B76.grid).toHaveLength(840)
  expect(B76.edges).toHaveLength(11)
  expect(B76.symbols).toHaveLength(12)
  // The named exception is one row of this grid, so it cannot drift onto another.
  expect(B76.grid.filter(isLibmResidue)).toHaveLength(1)
})

test('every synthetic vector: rounded outputs equal opengreeks exactly; |rawIv − iv| ≤ 1e-9 (one named libm row ≤ 2e-9), at least 700 bit-exact; nulls agree', () => {
  const misses: string[] = []
  let bitExact = 0
  for (const g of B76.grid) {
    const at = `${g.flag} F=${g.F} K=${g.K} t=${g.t} σ=${g.sigma}`
    const got = rawIv(g.price, g.F, g.K, B76.rate, g.t, g.flag)
    const want = safeIv(g.price, g.F, g.K, g.t, g.iv)
    const miss = ivMiss(got, want, isLibmResidue(g) ? LIBM_RESIDUE.bound : IV_BOUND)
    if (miss) misses.push(`${at}: iv ${miss}`)
    if (got !== null && got === want) bitExact++
    const ours = black76Greeks(g.flag, g.F, g.K, g.t, B76.rate, g.sigma)
    for (const k of Object.keys(PLACES) as (keyof typeof PLACES)[]) {
      if (!sameRounded(k, ours[k], g[k], g.flag)) misses.push(`${at}: ${k} ${ours[k]} for ${g[k]}`)
    }
    const gamma = rawGamma(g.flag, g.F, g.K, g.t, B76.rate, g.sigma)
    if (!sameRounded('gamma', gamma, g.gamma, g.flag)) misses.push(`${at}: rawGamma ${gamma}`)
  }
  expect(misses).toEqual([])
  expect(bitExact).toBeGreaterThanOrEqual(MIN_BIT_EXACT)
})

test.each(B76.edges)(
  'edge, $label ($flag F=$F K=$K at $price): rawIv agrees with opengreeks',
  (e) => {
    const got = rawIv(e.price, e.F, e.K, B76.rate, e.t, e.flag)
    expect(ivMiss(got, safeIv(e.price, e.F, e.K, e.t, e.iv))).toBeNull()
  },
)

test('rawIv at the maximum is the bracket value, above it null (preflight conflict 7)', () => {
  expect(rawIv(24000, 24000, 24000, 0, 7 / 365, 'c')).toBeCloseTo(5, 12)
  expect(rawIv(24001, 24000, 24000, 0, 7 / 365, 'c')).toBeNull()
  expect(rawIv(25000, 24000, 25000, 0, 7 / 365, 'p')).toBeCloseTo(5, 12)
  expect(rawIv(25001, 24000, 25000, 0, 7 / 365, 'p')).toBeNull()
})

test('rawIv and rawGamma refuse what _safe_iv and _safe_gamma refuse', () => {
  expect(rawIv(0, 24000, 24000, 0, 0.02, 'c')).toBeNull()
  expect(rawIv(-1, 24000, 24000, 0, 0.02, 'c')).toBeNull()
  expect(rawIv(100, 0, 24000, 0, 0.02, 'c')).toBeNull()
  expect(rawIv(100, 24000, 0, 0, 0.02, 'c')).toBeNull()
  expect(rawIv(100, 24000, 24000, 0, 0, 'c')).toBeNull()
  expect(rawIv(Number.NaN, 24000, 24000, 0, 0.02, 'c')).toBeNull()
  expect(rawGamma('c', 24000, 24000, 0.02, 0, 0)).toBe(0)
  expect(rawGamma('c', 24000, 24000, 0, 0, 0.2)).toBe(0)
  expect(rawGamma('p', 0, 24000, 0.02, 0, 0.2)).toBe(0)
  expect(rawGamma('p', 24000, 24000, 0.02, 0, 0.2)).toBeGreaterThan(0)
})

/** opengreeks' own IV, which rawIvAny answers: never asked for a price ≤ 0 (opengreeks gives 1e-6). */
const anyIv = (price: number, iv: number | null) => (price > 0 ? iv : null)

test('rawIvAny: overpriced → 4.999999999999996; at intrinsic → 1e-6; below intrinsic or price 0 → null', () => {
  const edge = (label: string) => {
    const e = B76.edges.find((x) => x.label === label)
    if (!e) throw new Error(`no edge ${label}`)
    return e
  }
  const sigma62 = edge('a price from sigma 6.2')
  const atIntrinsic = edge('at intrinsic')
  const any = (e: EdgeGolden) => rawIvAny(e.price, e.F, e.K, B76.rate, e.t, e.flag)
  expect(any(sigma62)).toBe(4.999999999999996)
  expect(any(atIntrinsic)).toBe(1e-6)
  for (const label of ['below intrinsic', 'above the maximum']) {
    const rows = B76.edges.filter((e) => e.label === label)
    expect(rows.map(any)).toEqual(rows.map(() => null))
  }
  expect(rawIvAny(0, 24000, 24000, 0, atIntrinsic.t, 'c')).toBeNull()
  expect(rawIvAny(-1, 24000, 24000, 0, atIntrinsic.t, 'c')).toBeNull()
  expect(rawIvAny(Number.NaN, 24000, 24000, 0, atIntrinsic.t, 'c')).toBeNull()

  // every edge and grid row as opengreeks answers it (the grid's one named libm row ≤ 2e-9)
  const misses: string[] = []
  for (const e of B76.edges) {
    const miss = ivMiss(any(e), anyIv(e.price, e.iv))
    if (miss) misses.push(`edge ${e.label} ${e.flag}: ${miss}`)
  }
  for (const g of B76.grid) {
    const got = rawIvAny(g.price, g.F, g.K, B76.rate, g.t, g.flag)
    const bound = isLibmResidue(g) ? LIBM_RESIDUE.bound : IV_BOUND
    const miss = ivMiss(got, anyIv(g.price, g.iv), bound)
    if (miss) misses.push(`${g.flag} F=${g.F} K=${g.K} t=${g.t} σ=${g.sigma}: ${miss}`)
  }
  expect(misses).toEqual([])
})

test('rawGreeks matches the black76 golden vectors, the two new edge rows included', () => {
  const misses: string[] = []
  const compare = (at: string, got: RawGreeks | null, want: RawGreeks, flag: Flag) => {
    if (!got) {
      misses.push(`${at}: null`)
      return
    }
    for (const k of Object.keys(PLACES) as (keyof typeof PLACES)[]) {
      if (!sameRounded(k, got[k], want[k], flag))
        misses.push(`${at}: ${k} ${got[k]} for ${want[k]}`)
    }
  }
  for (const g of B76.grid) {
    const at = `${g.flag} F=${g.F} K=${g.K} t=${g.t} σ=${g.sigma}`
    compare(at, rawGreeks(g.flag, g.F, g.K, g.t, B76.rate, g.sigma), g, g.flag)
  }
  // iv_chart_service.py:436-454: Greeks at the solved IV, the 1e-6 floor and the cap included
  for (const e of B76.edges) {
    const at = `edge ${e.label} ${e.flag}`
    const sigma = rawIvAny(e.price, e.F, e.K, B76.rate, e.t, e.flag)
    if (sigma === null || e.greeks === null) {
      if (sigma !== null || e.greeks !== null) misses.push(`${at}: IV ${sigma} for ${e.iv}`)
      continue
    }
    compare(at, rawGreeks(e.flag, e.F, e.K, e.t, B76.rate, sigma), e.greeks, e.flag)
  }
  expect(misses).toEqual([])
  const priced = B76.edges.filter((e) => e.greeks !== null).map((e) => e.label)
  expect(priced).toEqual(expect.arrayContaining(['a price from sigma 6.2', 'at intrinsic']))
  expect(rawGreeks('c', 24000, 23000, 7 / 365, 0, 1e-6)).toEqual({
    delta: 1,
    gamma: 0,
    theta: 0,
    vega: 0,
  })
  // nothing to price: no σ, no time, no forward or no strike
  expect(rawGreeks('c', 24000, 24000, 0.02, 0, 0)).toBeNull()
  expect(rawGreeks('c', 24000, 24000, 0, 0, 0.2)).toBeNull()
  expect(rawGreeks('p', 0, 24000, 0.02, 0, 0.2)).toBeNull()
  expect(rawGreeks('p', 24000, 0, 0.02, 0, 0.2)).toBeNull()
  expect(rawGreeks('p', 24000, 24000, 0.02, 0, Number.NaN)).toBeNull()
})

test.each(B76.symbols)('$label ($symbol): spotGreeks equals calculate_greeks', (s) => {
  expect(spotGreeks(s)).toEqual(greeksOf(s))
})

// A leg's ltp may be null on a real server; the services read it as 0 (`.get("ltp") or 0`).
const LegSchema = z
  .object({
    symbol: z.string(),
    ltp: z
      .number()
      .nullable()
      .transform((v) => v ?? 0),
  })
  .nullable()
const ChainSchema = z.object({
  underlying_ltp: z.number(),
  atm_strike: z.number(),
  server_ts: z.number().optional(),
  chain: z.array(z.object({ strike: z.number(), ce: LegSchema, pe: LegSchema })),
})

/** The chain the legs and the with_greeks golden come from, as the phone reads it. */
function chain25(input: GoldenInput) {
  const body = {
    underlying: input.underlying,
    exchange: input.exchange,
    expiry_date: input.expiry,
    strike_count: 25,
  }
  return fakeApi(input).call('optionchain', body, ChainSchema)
}

test.each(goldenCases())(
  '$id: spotGreeks equals calculate_greeks on every priced leg',
  async (c) => {
    const chain = await chain25(c.input)
    const exchange = optionsExchangeOf(c.input.exchange)
    const priced = chain.chain.flatMap((r) => [r.ce, r.pe]).filter((l) => l !== null && l.ltp > 0)
    expect(c.expected.legs.map((l) => [l.symbol, l.exchange, l.price])).toEqual(
      priced.map((l) => [l?.symbol, exchange, l?.ltp]),
    )
    for (const leg of c.expected.legs) {
      expect(leg.spot).toBe(chain.underlying_ltp)
      const got = spotGreeks({ ...leg, nowMs: c.input.serverNowMs })
      expect({ symbol: leg.symbol, greeks: got }).toEqual({
        symbol: leg.symbol,
        greeks: greeksOf(leg),
      })
    }
  },
)

test.each(goldenCases())('$id: withGreeksChain equals calculate_chain_greeks', async (c) => {
  const chain = await chain25(c.input)
  const want = c.expected.withGreeks
  const forward = chainForward(chain.chain, chain.atm_strike, chain.underlying_ltp)
  expect(forward).toBe(want.forward)
  const expiryMs = expiryInstantMs(c.input.expiry, optionsExchangeOf(c.input.exchange))
  if (expiryMs === null) throw new Error(`bad golden expiry ${c.input.expiry}`)
  const { years, days } = serverYears(expiryMs, c.input.serverNowMs)
  expect({ years, days }).toEqual({ years: want.years, days: want.days })
  const rows = withGreeksChain(chain.chain, { forward, years })
  expect(rows.map((r, i) => ({ strike: chain.chain[i]?.strike, ...r }))).toEqual(want.rows)
})

test('fakeApi answers by request key at the case instant, and an unrecorded request throws', async () => {
  const [c] = goldenCases()
  if (!c) throw new Error('no golden case recorded')
  // A chain stamped a few seconds off the case instant is answered at serverNowMs.
  const responses = Object.fromEntries(
    Object.entries(c.input.responses).map(([key, reply]) => [
      key,
      key.startsWith('optionchain ') ? { ...(reply as object), server_ts: 1 } : reply,
    ]),
  )
  const input = { ...c.input, responses }
  const chain = await chain25(input)
  expect(chain.server_ts).toBe(c.input.serverNowMs / 1000)
  expect(chain.chain.length).toBeGreaterThan(0)
  const api = fakeApi(input)
  const bare = { underlying: c.input.underlying, exchange: c.input.exchange }
  await expect(api.call('optionchain', bare, z.unknown())).rejects.toThrow(
    /no recorded reply for optionchain/,
  )
  await expect(api.get('instruments', { exchange: 'NFO' }, z.unknown())).rejects.toThrow(
    /no recorded reply for instruments/,
  )
})
