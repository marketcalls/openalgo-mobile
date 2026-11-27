// Black-76 in the server's two modes (design 7.8): the Greeks of the web's own engine
// (frontend/src/lib/optionGreeks.ts, imported, never copied) with the server's implied
// volatility (./engine), its time to expiry, its fallbacks and its rounding.
// Spot mode: services/option_greeks_service.py calculate_greeks (:570-830), what GEX, IV Smile
// and Gamma Density price their legs with. with_greeks mode: calculate_chain_greeks (:427-567)
// over option_chain_service.py _forward_from_chain (:237-270), what /optionchain with_greeks
// attaches from 2.0.2.0.
import { black76Greeks } from '@/lib/optionGreeks'
import { type Flag, impliedVol } from './engine'
import { expiryInstantMs, parseOptionSymbol, serverYears } from './expiry'
import { pyRound } from './pyRound'

export type LegGreeks = { iv: number; delta: number; gamma: number; theta: number; vega: number }
export type ChainRowLike = {
  strike: number
  ce: { ltp: number } | null
  pe: { ltp: number } | null
}

/** IV in percent to 2 places, delta 4, gamma 6, theta 4, vega 4: both modes round so. */
function roundedGreeks(
  flag: Flag,
  F: number,
  K: number,
  t: number,
  r: number,
  sigma: number,
): LegGreeks {
  const g = black76Greeks(flag, F, K, t, r, sigma)
  return {
    iv: pyRound(sigma * 100, 2),
    delta: pyRound(g.delta, 4),
    gamma: pyRound(g.gamma, 6),
    theta: pyRound(g.theta, 4),
    vega: pyRound(g.vega, 4),
  }
}

/** The theoretical Greeks the server gives a leg it cannot invert: IV 0 and only a delta. */
const theoretical = (delta: number): LegGreeks => ({ iv: 0, delta, gamma: 0, theta: 0, vega: 0 })

const intrinsicOf = (flag: Flag, F: number, K: number) =>
  flag === 'c' ? Math.max(F - K, 0) : Math.max(K - F, 0)

/** The server's "no time value" rule: none at all, or under 0.01 on an in-the-money leg. */
const noTimeValue = (price: number, intrinsic: number) =>
  price - intrinsic <= 0 || (intrinsic > 0 && price - intrinsic < 0.01)

/**
 * calculate_greeks at r = 0 with F = `spot`, at the server's `nowMs`: what its 200 reply holds,
 * or null for each error reply, in its order: the symbol does not parse; the option has expired
 * (years 0, RF 1); spot, price or strike ≤ 0; then a leg with no time value gets IV 0 and delta
 * ±1; a price above F (call) or K (put) is a 500, as is a solver failure (preflight conflict 7:
 * only an IV error naming "intrinsic" or "below" turns theoretical).
 */
export function spotGreeks(o: {
  symbol: string
  exchange: string
  spot: number
  price: number
  nowMs: number
}): LegGreeks | null {
  const p = parseOptionSymbol(o.symbol)
  if (!p) return null
  const expiryMs = expiryInstantMs(p.expiry, o.exchange)
  if (expiryMs === null) return null
  const { years } = serverYears(expiryMs, o.nowMs)
  if (years <= 0) return null
  if (!(o.spot > 0) || !(o.price > 0) || !(p.strike > 0)) return null
  const flag: Flag = p.type === 'CE' ? 'c' : 'p'
  const itm = theoretical(flag === 'c' ? 1 : -1)
  if (noTimeValue(o.price, intrinsicOf(flag, o.spot, p.strike))) return itm
  const solved = impliedVol(o.price, o.spot, p.strike, 0, years, flag)
  if ('error' in solved) return solved.error === 'below' ? itm : null
  return roundedGreeks(flag, o.spot, p.strike, years, 0, solved.sigma)
}

/**
 * gamma_density_service._safe_iv: opengreeks' IV as a decimal, or null for a price ≤ 0, a bad
 * F, K or t, any solver error, or an IV that is not in (0, 5]. A price at the maximum gives the
 * bracket top, just under 5.
 */
export function rawIv(
  price: number,
  F: number,
  K: number,
  r: number,
  t: number,
  flag: Flag,
): number | null {
  if (!(price > 0) || !(F > 0) || !(K > 0) || !(t > 0)) return null
  const solved = impliedVol(price, F, K, r, t, flag)
  if ('error' in solved) return null
  const iv = solved.sigma
  return Number.isFinite(iv) && iv > 0 && iv <= 5 ? iv : null
}

/** opengreeks' IV floor, and the top of its bisection bracket, where a price past σ = 5 lands. */
const IV_FLOOR = 1e-6
const IV_CAP = 4.999999999999996

/**
 * iv_chart_service.py's IV (opengreeks implied_volatility) as a decimal: null where opengreeks
 * raises (below intrinsic, above F for a call or K for a put, no convergence) and for a price ≤ 0,
 * which the service never asks; 1e-6 at intrinsic; else the solver's σ within [1e-6,
 * 4.999999999999996], where opengreeks saturates.
 */
export function rawIvAny(
  price: number,
  F: number,
  K: number,
  r: number,
  t: number,
  flag: Flag,
): number | null {
  if (!(price > 0)) return null
  const solved = impliedVol(price, F, K, r, t, flag)
  if ('error' in solved) return null
  return Math.min(Math.max(solved.sigma, IV_FLOOR), IV_CAP)
}

/**
 * The Greeks iv_chart_service.py prices at a solved σ (opengreeks delta, gamma, theta, vega): the
 * web's Black-76 in opengreeks' units (theta per calendar day, vega per 1% of IV). null with
 * nothing to price (σ, F, K or t not above 0) or a Greek that is not finite.
 */
export function rawGreeks(
  flag: Flag,
  F: number,
  K: number,
  t: number,
  r: number,
  sigma: number,
): { delta: number; gamma: number; theta: number; vega: number } | null {
  if (!(sigma > 0) || !(F > 0) || !(K > 0) || !(t > 0)) return null
  const { delta, gamma, theta, vega } = black76Greeks(flag, F, K, t, r, sigma)
  const g = { delta, gamma, theta, vega }
  return Object.values(g).every(Number.isFinite) ? g : null
}

/** gamma_density_service._safe_gamma: Black-76 gamma, or 0 on any numerical failure. */
export function rawGamma(
  flag: Flag,
  F: number,
  K: number,
  t: number,
  r: number,
  sigma: number,
): number {
  if (!(sigma > 0) || !(F > 0) || !(K > 0) || !(t > 0)) return 0
  const gamma = black76Greeks(flag, F, K, t, r, sigma).gamma
  return Number.isFinite(gamma) && gamma >= 0 ? gamma : 0
}

/**
 * _forward_from_chain: the ATM row's K + C − P rounded to 4 places when both legs are priced,
 * else the underlying's LTP.
 */
export function chainForward(
  rows: readonly ChainRowLike[],
  atm: number,
  underlyingLtp: number,
): number {
  const row = rows.find((r) => r.strike === atm)
  const call = row?.ce?.ltp || 0
  const put = row?.pe?.ltp || 0
  return call > 0 && put > 0 ? pyRound(atm + call - put, 4) : underlyingLtp
}

/**
 * calculate_chain_greeks over a ladder priced off `forward`: per leg its rounded Greeks; IV 0
 * with delta ±1 in the money (0 out of it) when it has no time value or its IV does not solve;
 * null when it is unpriced. No forward or no time left (the chain has expired) leaves every leg
 * null.
 */
export function withGreeksChain(
  rows: readonly ChainRowLike[],
  o: { forward: number; years: number; ratePct?: number },
): Array<{ ce: LegGreeks | null; pe: LegGreeks | null }> {
  const { forward: F, years: t } = o
  if (!(F > 0) || !(t > 0)) return rows.map(() => ({ ce: null, pe: null }))
  const r = (o.ratePct || 0) / 100
  const leg = (flag: Flag, K: number, ltp: number | undefined): LegGreeks | null => {
    const price = ltp || 0
    if (!(price > 0) || !(K > 0)) return null
    const intrinsic = intrinsicOf(flag, F, K)
    const fallback = theoretical(intrinsic > 0 ? (flag === 'c' ? 1 : -1) : 0)
    if (noTimeValue(price, intrinsic)) return fallback
    // The array solver turns every error into NaN, and NaN joins the theoretical bucket.
    const solved = impliedVol(price, F, K, r, t, flag)
    if ('error' in solved || !(solved.sigma > 0)) return fallback
    return roundedGreeks(flag, F, K, t, r, solved.sigma)
  }
  return rows.map((row) => ({
    ce: leg('c', row.strike, row.ce?.ltp),
    pe: leg('p', row.strike, row.pe?.ltp),
  }))
}
