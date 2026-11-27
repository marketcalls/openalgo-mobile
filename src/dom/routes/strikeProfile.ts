// The Strike Profile route, answered on the phone: POST /strikeprofile/api/profile-data
// (blueprints/strike_profile.py:28-99 at c8b2896), a port of services/strike_profile_service.py
// get_strike_profile (:209-423) over /api/v1/optionchain, one expiry after another.
// - The first chain is the probe: when spot ± range_pct needs more than its 20 strikes a side
//   (_strike_count_for_window :192-206), it is read again at that count, and every later expiry
//   is read at the count the window needs.
// - Each chain asks with_greeks where the server prices it (2.0.2.0; preflight F conflict 19:
//   never sent before it); wherever a chain came without them, the phone prices the Greeks as
//   the chain service would (ensureChainGreeks, RF 4). The first expiry's failure, or a busy
//   broker's 429 on any, is the reply; a later expiry that fails is shown unavailable.
// - Per leg (_leg_exposure :78-105), in rupees crore: GEX = sign·γ·OI·S²·0.01/1e7, calls +1 and
//   puts −1, and DEX = Δ·OI·S/1e7. Open interest on a leg with no Greeks is "unpriced".
// - The flip is the spot where the total GEX of every priced leg changes sign, each leg's gamma
//   repriced over a 241-point grid with its IV held fixed (find_gamma_flip :126-189); the walls
//   are the strikes with the most call and put GEX over every expiry.
import { z } from 'zod'
import type {
  StrikeProfileCell,
  StrikeProfileExpiry,
  StrikeProfileResponse,
} from '@/api/strike-profile'
import { ApiError } from '~/core/http/errors'
import { istDate } from '~/core/realtime/marketHours'
import { rawGamma } from '~/market/options/black76'
import { optionsExchangeOf } from '~/market/options/expiry'
import { ensureChainGreeks } from '~/market/options/greeksChain'
import { pyRound, pySum } from '~/market/options/pyRound'
import type { ChainLeg, OptionChain } from '~/market/options/schemas'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { FORMAT_COPY, PAIR_REQUIRED_COPY } from './query'

/** MAX_EXPIRIES (strike_profile.py:24): each expiry is one chain read. */
const MAX_EXPIRIES = 20
/** ALLOWED_RANGES (:26), in percent; 5 when the page sends none. */
const ALLOWED_RANGES: readonly number[] = [2, 5, 10]
const DEFAULT_RANGE = 5
/** DEFAULT_STRIKE_COUNT, the probe's strikes a side, and MAX_STRIKE_COUNT (:62-63). */
const PROBE_STRIKES = 20
const MAX_STRIKES = 40
const FLIP_GRID_POINTS = 241
/**
 * The flip search's gammas between two yields to the event loop. One is a full black76Greeks,
 * about 0.9 µs under `node --jitless` on an M-series Mac and a few µs on a budget phone's Hermes,
 * so a slice is a few ms there, under a 60 Hz frame. Whole rows: at 612 legs (NIFTY, six expiries
 * at 5%) a slice is 4 rows, at 3,240 (twenty expiries at "All") 1 row.
 */
const FLIP_SLICE_GAMMAS = 2_000
const SECONDS_PER_YEAR = 365 * 86400
/** _MIN_YEARS (:71): a flip leg's years are floored at about an hour. */
const MIN_YEARS = 0.0001
const CRORE = 1e7
const DAY_MS = 86_400_000

const UNDERLYING = /^[A-Z0-9]+$/
const EXCHANGE = /^[A-Z0-9_]+$/
const DDMMMYY = /^\d{2}[A-Z]{3}\d{2}$/
/** What Python's float() reads of a string, short of underscores and the words. */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const NO_EXPIRY_COPY = 'Select at least one expiry.'
const EXPIRY_FORMAT_COPY = 'Invalid expiry format. Expected DDMMMYY'
const RANGE_COPY = 'Invalid strike range'
const UNAVAILABLE_COPY = 'No option data for this expiry.'

/**
 * str(v) as far as the route's checks can tell: a string as it is, a number by its digits, and
 * anything else as text no pattern matches.
 */
function pyStr(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v) ?? ''
}

/** `float(range_value)` in ALLOWED_RANGES; null for no range; undefined for a refused one. */
function rangeOf(v: unknown): number | null | undefined {
  if (v === undefined) return DEFAULT_RANGE
  if (v === null) return null
  const text = typeof v === 'string' ? v.trim() : null
  const n =
    typeof v === 'number' ? v : text !== null && FLOAT.test(text) ? Number(text) : Number.NaN
  return ALLOWED_RANGES.includes(n) ? n : undefined
}

const field = z.unknown().optional()

/**
 * The route's checks in its order (strike_profile.py:50-80): the underlying and exchange, each
 * str() trimmed and cut to 20, both given and of their patterns; a non-empty list of expiries,
 * the first 20, each trimmed and upper-cased to DDMMMYY; and range_pct 2, 5 or 10, or null.
 */
export const StrikeProfileQuery = z
  .object({ underlying: field, exchange: field, expiry_dates: field, range_pct: field })
  .transform((b, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    const underlying = pyStr(b.underlying).trim().slice(0, 20)
    const exchange = pyStr(b.exchange).trim().slice(0, 20)
    if (!underlying || !exchange) return refuse(PAIR_REQUIRED_COPY)
    if (!UNDERLYING.test(underlying) || !EXCHANGE.test(exchange)) return refuse(FORMAT_COPY)
    const listed = b.expiry_dates ?? []
    if (!Array.isArray(listed) || listed.length === 0) return refuse(NO_EXPIRY_COPY)
    const expiryDates = listed.slice(0, MAX_EXPIRIES).map((e) => pyStr(e).trim().toUpperCase())
    if (!expiryDates.every((e) => DDMMMYY.test(e))) return refuse(EXPIRY_FORMAT_COPY)
    const rangePct = rangeOf(b.range_pct)
    if (rangePct === undefined) return refuse(RANGE_COPY)
    return { underlying, exchange, expiry_dates: expiryDates, range_pct: rangePct }
  })

export type StrikeProfileQueryOut = z.output<typeof StrikeProfileQuery>

/** (strike, forward, years, iv as a decimal, oi, sign) of one priced leg (:337-346). */
export type FlipLeg = {
  strike: number
  forward: number
  years: number
  sigma: number
  oi: number
  sign: 1 | -1
}

/** The page aborted the request: the route rejects, as an aborted read does, so the router
 *  answers nothing. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })
  }
}

/** The next turn of the event loop. A timer, not setImmediate: bridgeless React Native shims
 *  setImmediate with queueMicrotask (Libraries/Core/setUpTimers.js), which runs before the JS
 *  thread takes its next task, so taps, bridge messages and ticks would still wait. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * find_gamma_flip: the spot in [low, high] where Σ γ·OI·sign × p² changes sign, each leg's
 * forward moved in proportion to the spot (F·p/spot) and its gamma repriced at its own σ. The
 * grid is np.linspace (low + i·step, the last point `high`); a crossing is interpolated linearly,
 * or is a grid point where the total is 0; the one nearest `spot` wins, the first of two as near.
 * null with no legs, a bad range or no sign change.
 *
 * The search is points × legs Black-76 gammas (about 234k at six expiries and "All"), on the JS
 * thread the app's header, bridge and ticks share. So it hands the thread back between grid rows,
 * once each FLIP_SLICE_GAMMAS, and stops with the page: `o.signal` is checked before the first
 * row and at every yield, and an abort rejects. A slice holds whole rows, and each row sums its
 * legs in order, so the result is the one an unbroken loop gives.
 */
export async function findGammaFlip(
  legs: readonly FlipLeg[],
  spot: number,
  low: number,
  high: number,
  points: number = FLIP_GRID_POINTS,
  o: RouteOptions = {},
): Promise<number | null> {
  if (legs.length === 0 || spot <= 0 || low <= 0 || high <= low || points < 2) return null
  throwIfAborted(o.signal)
  const step = (high - low) / (points - 1)
  const grid = Array.from({ length: points }, (_, i) => (i === points - 1 ? high : low + i * step))
  const weights = legs.map((l) => l.oi * l.sign)
  // the hot loop (points × legs gammas): plain loops, as the dot product sums in leg order
  const totals: number[] = []
  let sliced = 0
  for (const price of grid) {
    if (sliced >= FLIP_SLICE_GAMMAS) {
      await nextTask()
      throwIfAborted(o.signal)
      sliced = 0
    }
    const ratio = price / spot
    let dot = 0
    for (let j = 0; j < legs.length; j++) {
      const l = legs[j] as FlipLeg
      dot +=
        rawGamma('c', l.forward * ratio, l.strike, l.years, 0, l.sigma) * (weights[j] as number)
    }
    totals.push(dot * price * price)
    sliced += legs.length
  }

  let best: number | null = null
  for (let i = 0; i < points - 1; i++) {
    const a = totals[i] as number
    const b = totals[i + 1] as number
    const g0 = grid[i] as number
    const g1 = grid[i + 1] as number
    let crossing: number
    if (a === 0) crossing = g0
    else if (a < 0 !== b < 0 && b !== 0) crossing = g0 + ((g1 - g0) * -a) / (b - a)
    else continue
    if (best === null || Math.abs(crossing - spot) < Math.abs(best - spot)) best = crossing
  }
  return best
}

/** _strike_count_for_window: the strikes a side the probe needs to cover spot ± rangePct. */
function strikeCountForWindow(c: OptionChain, spot: number, rangePct: number | null): number {
  if (!rangePct) return MAX_STRIKES
  const strikes = [...new Set(c.chain.map((r) => r.strike))].sort((a, b) => a - b)
  if (strikes.length < 2) return PROBE_STRIKES
  let step = 0
  for (let i = 1; i < strikes.length; i++) {
    const d = (strikes[i] as number) - (strikes[i - 1] as number)
    if (d > 0 && (step === 0 || d < step)) step = d
  }
  if (step <= 0) return PROBE_STRIKES
  const needed = Math.ceil((spot * rangePct) / 100 / step) + 1
  return Math.max(5, Math.min(needed, MAX_STRIKES))
}

/** _expiry_years: from the chain's expiry_ts and server_ts (else the server's clock), ≥ 0. */
function expiryYears(c: OptionChain, nowMs: number): number {
  const serverTs = c.server_ts || nowMs / 1000
  if (!c.expiry_ts) return 0
  return Math.max((c.expiry_ts - serverTs) / SECONDS_PER_YEAR, 0)
}

/** _calendar_dte: whole IST calendar days from today to the expiry's day, ≥ 0. */
function calendarDte(expiryTs: number | null, nowMs: number): number | null {
  if (!expiryTs) return null
  const days = (Date.parse(istDate(expiryTs * 1000)) - Date.parse(istDate(nowMs))) / DAY_MS
  return Math.max(days, 0)
}

type Exposure = { oi: number; gex: number; dex: number; iv: number; priced: boolean }

/** _leg_exposure: one leg's OI, GEX and DEX, its IV in percent and whether it has Greeks. */
function exposure(leg: ChainLeg | null, spot: number, sign: 1 | -1): Exposure {
  if (!leg) return { oi: 0, gex: 0, dex: 0, iv: 0, priced: false }
  const oi = leg.oi || 0
  const gamma = leg.gamma || 0
  const delta = leg.delta || 0
  return {
    oi,
    // the server's order of operations, left to right
    gex: (sign * gamma * oi * spot * spot * 0.01) / CRORE,
    dex: (delta * oi * spot) / CRORE,
    iv: leg.implied_volatility || 0,
    priced: leg.gamma !== undefined && leg.delta !== undefined,
  }
}

/** The strike whose summed `value` over the expiries is the largest, the first on a tie; null
 *  when that sum is not above 0. */
function wall(
  strikes: readonly number[],
  rowsByExpiry: readonly Map<number, StrikeProfileCell>[],
  value: (c: StrikeProfileCell) => number,
): number | null {
  let best: number | null = null
  let bestSum = 0
  for (const k of strikes) {
    // `(rows.get(strike) or {}).get(…, 0.0)`: an expiry without the strike adds 0
    const sum = pySum(
      rowsByExpiry.map((rows) => {
        const cell = rows.get(k)
        return cell ? value(cell) : 0
      }),
    )
    if (best === null || sum > bestSum) {
      best = k
      bestSum = sum
    }
  }
  return best === null || bestSum <= 0 ? null : best
}

export async function strikeProfile(
  q: StrikeProfileQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<StrikeProfileResponse> {
  const optionsExchange = optionsExchangeOf(q.exchange)
  const read = async (expiry: string, count: number) => {
    const c = await d.options.chain(
      {
        underlying: q.underlying,
        exchange: q.exchange,
        expiry_date: expiry,
        strike_count: count,
        with_greeks: d.greeksOnServer(),
      },
      { signal: o.signal },
    )
    return ensureChainGreeks(c, { optionsExchange, nowMs: d.now() })
  }

  let spot: number | null = null
  let serverTs: number | undefined
  let strikeCount = PROBE_STRIKES
  const expiries: StrikeProfileExpiry[] = []
  const rowsByExpiry: Map<number, StrikeProfileCell>[] = []
  const flipLegs: FlipLeg[] = []
  const allStrikes = new Set<number>()

  for (const [index, expiry] of q.expiry_dates.entries()) {
    let chain: OptionChain
    try {
      chain = await read(expiry, strikeCount)
    } catch (e) {
      // the first expiry's failure, or a busy broker on any, is the load's reply
      if (
        !(e instanceof ApiError) ||
        o.signal?.aborted ||
        index === 0 ||
        e.kind === 'RateLimited'
      ) {
        throw e
      }
      expiries.push({
        expiry,
        expiry_ts: null,
        dte: null,
        available: false,
        message: UNAVAILABLE_COPY,
        cells: [],
      })
      rowsByExpiry.push(new Map())
      continue
    }

    if (spot === null) {
      spot = chain.underlying_ltp
      if (!(spot > 0)) throw routeError(404, 'The underlying price is not available.')
      serverTs = chain.server_ts
      const wanted = strikeCountForWindow(chain, spot, q.range_pct)
      if (wanted > strikeCount) {
        strikeCount = wanted
        chain = await read(expiry, strikeCount)
      } else strikeCount = wanted
    }

    const years = expiryYears(chain, d.now())
    const forward = chain.forward_price || spot
    const expiryTs = chain.expiry_ts ?? null
    const rows = new Map<number, StrikeProfileCell>()
    let totalGex = 0
    let totalDex = 0
    for (const row of chain.chain) {
      const strike = row.strike
      if (!(strike > 0)) continue
      const ce = exposure(row.ce, spot, 1)
      const pe = exposure(row.pe, spot, -1)
      const gex = ce.gex + pe.gex
      const dex = ce.dex + pe.dex
      rows.set(strike, {
        ce_oi: ce.oi,
        pe_oi: pe.oi,
        ce_gex: pyRound(ce.gex, 4),
        pe_gex: pyRound(pe.gex, 4),
        ce_dex: pyRound(ce.dex, 4),
        pe_dex: pyRound(pe.dex, 4),
        gex: pyRound(gex, 4),
        dex: pyRound(dex, 4),
        // open interest with no Greeks to weight it is unknown, not zero
        unpriced: (ce.oi > 0 && !ce.priced) || (pe.oi > 0 && !pe.priced),
      })
      allStrikes.add(strike)
      totalGex += gex
      totalDex += dex
      if (years > 0) {
        for (const [leg, sign] of [
          [ce, 1],
          [pe, -1],
        ] as const) {
          if (leg.oi > 0 && leg.priced && leg.iv > 0) {
            flipLegs.push({
              strike,
              forward,
              years: Math.max(years, MIN_YEARS),
              sigma: leg.iv / 100,
              oi: leg.oi,
              sign,
            })
          }
        }
      }
    }

    // the first row with a leg (the call's, else the put's) that names a lot size
    let lotSize: number | null = null
    for (const row of chain.chain) {
      const leg = row.ce ?? row.pe
      if (leg?.lotsize) {
        lotSize = leg.lotsize
        break
      }
    }

    expiries.push({
      expiry,
      expiry_ts: expiryTs,
      dte: calendarDte(expiryTs, d.now()),
      years: pyRound(years, 6),
      forward: pyRound(forward, 2),
      lot_size: lotSize,
      available: true,
      net_gex: pyRound(totalGex, 4),
      net_dex: pyRound(totalDex, 4),
      cells: [],
    })
    rowsByExpiry.push(rows)
  }

  if (spot === null || allStrikes.size === 0) {
    throw routeError(404, 'No option data for these expiries.')
  }
  const strikes = [...allStrikes].sort((a, b) => a - b)
  // the grid aligned to the strikes: null where an expiry does not list one
  expiries.forEach((meta, i) => {
    const rows = rowsByExpiry[i] as Map<number, StrikeProfileCell>
    meta.cells = strikes.map((k) => rows.get(k) ?? null)
  })
  const low = strikes[0] as number
  const high = strikes[strikes.length - 1] as number
  const flip = await findGammaFlip(flipLegs, spot, low, high, FLIP_GRID_POINTS, o)

  return {
    status: 'success',
    underlying: q.underlying,
    exchange: q.exchange,
    spot_price: pyRound(spot, 2),
    as_of: serverTs || Math.floor(d.now() / 1000),
    range_pct: q.range_pct,
    strikes,
    flip: flip === null ? null : pyRound(flip, 2),
    call_wall: wall(strikes, rowsByExpiry, (c) => c.ce_gex),
    put_wall: wall(strikes, rowsByExpiry, (c) => Math.abs(c.pe_gex)),
    expiries,
  }
}
