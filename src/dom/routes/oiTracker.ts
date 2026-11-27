// The OI Tracker, OI Range and Max Pain routes, answered on the phone:
// - POST /oitracker/api/oi-data (blueprints/oitracker.py:25-74 at openalgo.ref):
//   services/oi_tracker_service.py get_oi_data (:120-223);
// - POST /oitracker/api/maxpain (oitracker.py:77-126): calculate_max_pain (:234-332).
// Both read /api/v1/optionchain at 23 strikes a side, then the futures price as
// _get_nearest_futures_price (:24-117) finds it (OptionsData.futuresPrice). Totals add with plain
// `+=`, values round where the service rounds them, and the first minimum wins.
import type { MaxPainResponse, OIChainItem, OIDataResponse, PainDataItem } from '@/api/oi-tracker'
import { pyRound } from '~/market/options/pyRound'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import type { ToolQuery } from './query'

/** 23 each side of ATM: 94 symbols, inside the fyers multiquote OI bucket (:141-149). */
const STRIKES = 23

type OIData = Required<Omit<OIDataResponse, 'message'>>

export async function oiData(
  q: ToolQuery,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<OIDataResponse> {
  return readOi(q, d, o)
}

async function readOi(q: ToolQuery, d: RouteDeps, o: RouteOptions): Promise<OIData> {
  const chain = await d.options.chain({ ...q, strike_count: STRIKES }, { signal: o.signal })

  let totalCeOi = 0
  let totalPeOi = 0
  let totalCeVolume = 0
  let totalPeVolume = 0
  let lotSize: number | null = null
  for (const item of chain.chain) {
    if (item.ce) {
      totalCeOi += item.ce.oi
      totalCeVolume += item.ce.volume
      if (lotSize === null && item.ce.lotsize) lotSize = item.ce.lotsize
    }
    if (item.pe) {
      totalPeOi += item.pe.oi
      totalPeVolume += item.pe.volume
      if (lotSize === null && item.pe.lotsize) lotSize = item.pe.lotsize
    }
  }
  const pcrOi = totalCeOi > 0 ? pyRound(totalPeOi / totalCeOi, 2) : 0
  const pcrVolume = totalCeVolume > 0 ? pyRound(totalPeVolume / totalCeVolume, 2) : 0

  const oiChain: OIChainItem[] = chain.chain.map((item) => ({
    strike: item.strike,
    ce_oi: item.ce?.oi ?? 0,
    pe_oi: item.pe?.oi ?? 0,
  }))

  // q.exchange is already the options exchange (NFO, BFO) the page picked
  const futuresPrice = await d.options.futuresPrice(
    q.underlying,
    q.exchange,
    q.expiry_date,
    chain.underlying_ltp,
  )

  return {
    status: 'success',
    underlying: chain.underlying,
    spot_price: chain.underlying_ltp,
    futures_price: futuresPrice,
    lot_size: lotSize || 1,
    pcr_oi: pcrOi,
    pcr_volume: pcrVolume,
    total_ce_oi: totalCeOi,
    total_pe_oi: totalPeOi,
    atm_strike: chain.atm_strike,
    expiry_date: q.expiry_date,
    chain: oiChain,
  }
}

/**
 * The strike where option writers lose least: per candidate, CE writers pay
 * (candidate − strike) × CE OI on every strike below it and PE writers (strike − candidate) ×
 * PE OI on every strike above. min() compares the pains rounded to 2 places, first one wins.
 */
export async function maxPain(
  q: ToolQuery,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<MaxPainResponse> {
  const oi = await readOi(q, d, o)
  if (oi.chain.length === 0) throw routeError(404, 'No OI data available')
  const chain = oi.chain.filter((item) => item.strike > 0)
  if (chain.length === 0) throw routeError(404, 'No valid strike data available')

  const painData: PainDataItem[] = chain.map((candidate) => {
    let cePain = 0
    let pePain = 0
    for (const item of chain) {
      if (candidate.strike > item.strike && item.ce_oi > 0) {
        cePain += (candidate.strike - item.strike) * item.ce_oi
      }
      if (candidate.strike < item.strike && item.pe_oi > 0) {
        pePain += (item.strike - candidate.strike) * item.pe_oi
      }
    }
    const totalPain = cePain + pePain
    return {
      strike: candidate.strike,
      ce_pain: pyRound(cePain, 2),
      pe_pain: pyRound(pePain, 2),
      total_pain: pyRound(totalPain, 2),
      // in crores, for display
      total_pain_cr: pyRound(totalPain / 10_000_000, 2),
    }
  })

  let least = painData[0] as PainDataItem
  for (const p of painData) if (p.total_pain < least.total_pain) least = p

  return {
    status: 'success',
    underlying: oi.underlying,
    spot_price: oi.spot_price,
    futures_price: oi.futures_price,
    atm_strike: oi.atm_strike,
    max_pain_strike: least.strike,
    lot_size: oi.lot_size,
    pcr_oi: oi.pcr_oi,
    pcr_volume: oi.pcr_volume,
    expiry_date: q.expiry_date,
    pain_data: painData,
  }
}
