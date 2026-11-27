// The Gamma Density route, answered on the phone: POST /gammadensity/api/gamma-data
// (blueprints/gamma_density.py:28-81 at openalgo.ref), a port of
// services/gamma_density_service.py calculate_gamma_density (:127-353) over /api/v1/optionchain
// at 23 strikes a side.
// - F is the chain's own ATM parity, round(K + C − P, 2) as synthetic_future_service.py:152,173
//   rounds it, else the spot (design 7.8: the server's second, synthetic-future fetch is not
//   made; scripts/golden/harness.py patches _resolve_forward_price the same way).
// - Pass one inverts each leg's IV (opengreeks semantics, _safe_iv :100-111) and takes the ATM
//   strike's mean, else the median of the strikes', else 0.15. Pass two prices each leg's gamma
//   (_safe_gamma :114-124) at the full time to expiry and at one day, as Γ×OI densities.
import type {
  ExpectedMoveBand,
  GammaDensityResponse,
  GammaDensityStrike,
} from '@/api/gamma-density'
import { rawGamma, rawIv } from '~/market/options/black76'
import { expiryInstantMs, serverYears } from '~/market/options/expiry'
import { pyRound, pySum } from '~/market/options/pyRound'
import type { ChainRow } from '~/market/options/schemas'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import type { ToolQuery } from './query'

/** 23 each side of ATM, sized as the OI tracker's (:169-177). */
const STRIKES = 23
/** _DAYS_PER_YEAR and _INTRADAY_T_YEARS (:44-49): one calendar day. */
const INTRADAY_T_YEARS = 1 / 365
/** _FALLBACK_IV (:53): when no strike's IV inverts. */
const FALLBACK_IV = 0.15
/** DEFAULT_INTEREST_RATES (option_greeks_service.py:63-68) is 0 on every exchange. */
const INTEREST_RATE = 0

/** The ATM row's K + C − P to 2 places; null (the spot) when the row lacks a leg (conflict 24). */
function atmForward(rows: readonly ChainRow[], atm: number): number | null {
  const row = rows.find((r) => r.strike === atm)
  if (!row?.ce || !row.pe) return null
  return pyRound(atm + row.ce.ltp - row.pe.ltp, 2)
}

/** The 1σ and 2σ levels around the spot for a σ move (_band :306-313). */
function band(spot: number, sigma: number): ExpectedMoveBand {
  return {
    sigma_move: pyRound(sigma, 2),
    one_sigma_low: pyRound(spot - sigma, 2),
    one_sigma_high: pyRound(spot + sigma, 2),
    two_sigma_low: pyRound(spot - 2 * sigma, 2),
    two_sigma_high: pyRound(spot + 2 * sigma, 2),
  }
}

export async function gammaDensity(
  q: ToolQuery,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<GammaDensityResponse> {
  const chain = await d.options.chain({ ...q, strike_count: STRIKES }, { signal: o.signal })
  const rows = chain.chain
  const spot = chain.underlying_ltp
  const atm = chain.atm_strike
  if (!(spot > 0) || rows.length === 0) {
    throw routeError(404, 'Spot price or option chain unavailable')
  }

  // _expiry_datetime (:71-97) raises on a code that is not a date: the service's own 500
  const expiryMs = expiryInstantMs(q.expiry_date, q.exchange)
  if (expiryMs === null) throw routeError(500, 'Error computing gamma density')
  const { years: tYears, days: dteDays } = serverYears(expiryMs, d.now())
  const tIntraday = tYears > 0 ? Math.min(tYears, INTRADAY_T_YEARS) : INTRADAY_T_YEARS
  const r = INTEREST_RATE / 100
  // `forward or spot_price` (:212): a forward of 0 is no forward
  const F = atmForward(rows, atm) || spot

  // Pass one: per-strike IV and the ATM IV.
  const strikes: {
    strike: number
    ce_oi: number
    pe_oi: number
    ce_iv: number | null
    pe_iv: number | null
    strike_iv: number | null
  }[] = []
  const validIvs: number[] = []
  let atmIv: number | null = null
  for (const item of rows) {
    const K = item.strike
    if (!(K > 0)) continue
    const ceIv = rawIv(item.ce?.ltp ?? 0, F, K, r, tYears, 'c')
    const peIv = rawIv(item.pe?.ltp ?? 0, F, K, r, tYears, 'p')
    const sides = [ceIv, peIv].filter((v) => v !== null)
    const strikeIv = sides.length > 0 ? pySum(sides) / sides.length : null
    if (strikeIv !== null) validIvs.push(strikeIv)
    if (K === atm && strikeIv !== null) atmIv = strikeIv
    strikes.push({
      strike: K,
      ce_oi: item.ce?.oi ?? 0,
      pe_oi: item.pe?.oi ?? 0,
      ce_iv: ceIv,
      pe_iv: peIv,
      strike_iv: strikeIv,
    })
  }
  // the median, `sorted(valid_ivs)[len // 2]`, else the fallback
  const sorted = [...validIvs].sort((a, b) => a - b)
  const iv = atmIv ?? sorted[Math.floor(sorted.length / 2)] ?? FALLBACK_IV

  // Pass two: gamma at both horizons, as Γ×OI.
  const density: GammaDensityStrike[] = []
  let maxIntraday = 0
  let maxExpiry = 0
  let peakIntraday: number | null = null
  let peakExpiry: number | null = null
  for (const s of strikes) {
    const K = s.strike
    const ceSigma = s.ce_iv || iv
    const peSigma = s.pe_iv || iv
    const densityExpiry =
      rawGamma('c', F, K, tYears, r, ceSigma) * s.ce_oi +
      rawGamma('p', F, K, tYears, r, peSigma) * s.pe_oi
    const densityIntraday =
      rawGamma('c', F, K, tIntraday, r, ceSigma) * s.ce_oi +
      rawGamma('p', F, K, tIntraday, r, peSigma) * s.pe_oi
    if (densityExpiry > maxExpiry) {
      maxExpiry = densityExpiry
      peakExpiry = K
    }
    if (densityIntraday > maxIntraday) {
      maxIntraday = densityIntraday
      peakIntraday = K
    }
    density.push({
      strike: K,
      ce_oi: s.ce_oi,
      pe_oi: s.pe_oi,
      iv: s.strike_iv !== null ? pyRound(s.strike_iv * 100, 2) : null,
      density_intraday: densityIntraday,
      density_expiry: densityExpiry,
    })
  }

  // The expected-move bands: the daily and the to-expiry 1σ moves on the cash spot.
  const intraday = band(spot, spot * iv * Math.sqrt(INTRADAY_T_YEARS))
  const expiry = band(spot, spot * iv * Math.sqrt(Math.max(tYears, 1e-9)))

  return {
    status: 'success',
    underlying: chain.underlying,
    exchange: q.exchange,
    expiry_date: q.expiry_date,
    spot_price: pyRound(spot, 2),
    forward_price: pyRound(F, 2),
    atm_strike: atm,
    atm_iv: pyRound(iv * 100, 2),
    dte_days: pyRound(dteDays, 2),
    interest_rate: pyRound(INTEREST_RATE, 2),
    peak_intraday_strike: peakIntraday,
    peak_expiry_strike: peakExpiry,
    // the stat cards show the daily band
    ...intraday,
    intraday_band: intraday,
    expiry_band: expiry,
    chain: density,
  }
}
