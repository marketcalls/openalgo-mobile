// The Vol Surface route, answered on the phone: POST /volsurface/api/surface-data
// (blueprints/vol_surface.py:19-72 at c8b2896), a port of services/vol_surface_service.py
// get_vol_surface_data (:57-261) over one /api/v1/optionchain read per expiry, in order.
// - The server quotes the underlying, lists each expiry's strikes from its master and
//   multiquotes the legs. The phone reads them all from the chains instead (preflight F conflicts
//   6 and 7): the first chain's underlying_ltp, each chain's call strikes, and each leg's LTP.
//   The two agree at one instant; a chain sees only the strikes within its strike_count. A
//   failed first chain is the reply; a later one is skipped, as the server skips an expiry it
//   lists no strikes for.
// - Each expiry takes the strikes within strike_count of its ATM (the strike nearest the
//   underlying); the grid is the strikes every expiry shares, or the first expiry's when fewer
//   than 3 are shared.
// - Each cell is the out-of-the-money leg's IV (the call from the first ATM up, the put below),
//   as calculate_greeks inverts it at F = the underlying, null when the leg has no price or no IV.
//   dte counts from the server's clock, whose naive now() the service reads as IST.
import { z } from 'zod'
import type { VolSurfaceResponse } from '@/api/vol-surface'
import { ApiError } from '~/core/http/errors'
import { spotGreeks } from '~/market/options/black76'
import { expiryInstantMs, optionsExchangeOf, parseOptionSymbol } from '~/market/options/expiry'
import { pyRound } from '~/market/options/pyRound'
import type { OptionChain } from '~/market/options/schemas'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { PAIR_REQUIRED_COPY, PyInt } from './query'
import { quoteExchange } from './reference'
import { nearestStrike, optionSymbol } from './series'

/** vol_surface.py:56-58: at most 8 expiries; 5 to 40 strikes a side, 15 when none is asked. */
const MAX_EXPIRIES = 8
const DEFAULT_STRIKES = 15
const MIN_STRIKES = 5
const MAX_STRIKES = 40
/** Fewer common strikes than this and the grid is the first expiry's (:163-165). */
const MIN_COMMON = 3

/**
 * The route's reading of the body (vol_surface.py:40-58): `.strip()` of the underlying and the
 * exchange and `int()` of strike_count raise on anything else (its 500); then both are required,
 * and expiry_dates must be a non-empty list, of which the first 8 are kept.
 */
export const VolSurfaceQuery = z
  .object({
    underlying: z.string().optional(),
    exchange: z.string().optional(),
    expiry_dates: z.unknown().optional(),
    strike_count: PyInt.optional(),
  })
  .transform((b, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    const underlying = (b.underlying ?? '').trim()
    const exchange = (b.exchange ?? '').trim()
    if (!underlying || !exchange) return refuse(PAIR_REQUIRED_COPY)
    const listed = b.expiry_dates ?? []
    if (!Array.isArray(listed) || listed.length === 0) {
      return refuse('expiry_dates must be a non-empty list')
    }
    return {
      underlying,
      exchange,
      expiry_dates: listed.slice(0, MAX_EXPIRIES).map(String),
      strike_count: Math.min(Math.max(MIN_STRIKES, b.strike_count ?? DEFAULT_STRIKES), MAX_STRIKES),
    }
  })

export type VolSurfaceQueryOut = z.output<typeof VolSurfaceQuery>

type Expiry = { expiry: string; strikes: number[]; atm: number; ltps: Map<string, number> }

export async function volSurface(
  q: VolSurfaceQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<VolSurfaceResponse> {
  const base = q.underlying.toUpperCase()
  const exchange = q.exchange.toUpperCase()
  const optionsExchange = optionsExchangeOf(quoteExchange(base, exchange))

  let ltp = 0
  const loaded: Expiry[] = []
  for (const [index, expiry] of q.expiry_dates.entries()) {
    let chain: OptionChain
    try {
      chain = await d.options.chain(
        { underlying: base, exchange, expiry_date: expiry, strike_count: q.strike_count },
        { signal: o.signal },
      )
    } catch (e) {
      // a later expiry the server cannot list is skipped, as one without strikes is (:136-139)
      if (!(e instanceof ApiError) || o.signal?.aborted || index === 0) throw e
      continue
    }
    if (index === 0) {
      ltp = chain.underlying_ltp
      if (!ltp) throw routeError(500, `No LTP for ${base}`)
    }

    // get_available_strikes(base, expiry, "CE"): the strikes the chain lists a call at
    const strikes = chain.chain
      .filter((r) => r.ce)
      .map((r) => r.strike)
      .sort((a, b) => a - b)
    const atm = nearestStrike(ltp, strikes)
    if (atm === null) continue
    const at = strikes.indexOf(atm)
    const ltps = new Map<string, number>()
    for (const row of chain.chain) {
      for (const leg of [row.ce, row.pe]) if (leg?.symbol) ltps.set(leg.symbol, leg.ltp)
    }
    loaded.push({
      expiry,
      strikes: strikes.slice(Math.max(0, at - q.strike_count), at + q.strike_count + 1),
      atm,
      ltps,
    })
  }

  const first = loaded[0]
  if (!first) throw routeError(404, 'No valid expiry data found')
  // the strikes every expiry has, for a rectangular grid; else the first expiry's (with gaps)
  let strikes = first.strikes
    .filter((k, i, all) => all.indexOf(k) === i && loaded.every((e) => e.strikes.includes(k)))
    .sort((a, b) => a - b)
  if (strikes.length < MIN_COMMON) strikes = [...first.strikes].sort((a, b) => a - b)
  const atmStrike = first.atm

  const nowMs = d.now()
  const surface = loaded.map((e) =>
    strikes.map((strike) => {
      const symbol = optionSymbol(base, e.expiry, strike, strike >= atmStrike ? 'CE' : 'PE')
      const price = e.ltps.get(symbol) ?? 0
      if (!(price > 0)) return null
      const g = spotGreeks({ symbol, exchange: optionsExchange, spot: ltp, price, nowMs })
      return g && g.iv > 0 ? pyRound(g.iv, 2) : null
    }),
  )
  // the days to the expiry instant of the grid's first call, on the server's (IST) clock
  const expiries = loaded.map((e) => {
    const parsed = parseOptionSymbol(optionSymbol(base, e.expiry, strikes[0] as number, 'CE'))
    const at = parsed === null ? null : expiryInstantMs(parsed.expiry, optionsExchange)
    if (at === null) return { date: e.expiry, dte: 0 }
    return { date: e.expiry, dte: pyRound(Math.max(0, (at - nowMs) / 1000 / 86400), 1) }
  })

  return {
    status: 'success',
    data: {
      underlying: base,
      underlying_ltp: ltp,
      atm_strike: atmStrike,
      strikes,
      expiries,
      surface,
    },
  }
}
