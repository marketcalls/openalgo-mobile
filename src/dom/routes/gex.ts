// The GEX route, answered on the phone: POST /gex/api/gex-data (blueprints/gex.py:24-78 at
// openalgo.ref), a port of services/gex_service.py get_gex_data (:19-186) over
// /api/v1/optionchain at 45 strikes a side. A leg with a price and OI takes calculate_greeks'
// gamma at F = the spot (spotGreeks, on the server's clock), already rounded to 6 places, and its
// GEX is gamma × OI × lot size; the totals add the rounded rows with Python's sum().
import type { GEXChainItem, GEXDataResponse } from '@/api/gex'
import { spotGreeks } from '~/market/options/black76'
import { optionsExchangeOf } from '~/market/options/expiry'
import { pyRound, pySum } from '~/market/options/pyRound'
import type { ChainLeg } from '~/market/options/schemas'
import { NO_SPOT, type RouteDeps, type RouteOptions, routeError } from './deps'
import type { ToolQuery } from './query'

/** 45 strikes around ATM (:40-47). */
const STRIKES = 45

export async function gexData(
  q: ToolQuery,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<GEXDataResponse> {
  const chain = await d.options.chain({ ...q, strike_count: STRIKES }, { signal: o.signal })
  const spot = chain.underlying_ltp
  if (!(spot > 0)) throw routeError(500, NO_SPOT)

  const exchange = optionsExchangeOf(q.exchange)
  const nowMs = d.now()
  /** One side of a strike: its OI, lot size, (rounded) gamma and GEX, 0 where it has none. */
  const side = (leg: ChainLeg) => {
    const oi = leg.oi
    const lot = leg.lotsize || 1
    let gamma = 0
    let gex = 0
    if (leg.ltp > 0 && oi > 0) {
      const g = spotGreeks({ symbol: leg.symbol, exchange, spot, price: leg.ltp, nowMs })
      if (g) {
        gamma = g.gamma || 0
        gex = gamma * oi * lot
      }
    }
    return { oi, lot, gamma, gex }
  }

  const gexChain: GEXChainItem[] = []
  let lotSize: number | null = null
  for (const item of chain.chain) {
    const ce = item.ce?.symbol ? side(item.ce) : null
    const pe = item.pe?.symbol ? side(item.pe) : null
    lotSize ??= ce?.lot ?? pe?.lot ?? null
    const ceGex = ce?.gex ?? 0
    const peGex = pe?.gex ?? 0
    gexChain.push({
      strike: item.strike,
      ce_oi: ce?.oi ?? 0,
      pe_oi: pe?.oi ?? 0,
      ce_gamma: pyRound(ce?.gamma ?? 0, 6),
      pe_gamma: pyRound(pe?.gamma ?? 0, 6),
      ce_gex: pyRound(ceGex, 2),
      pe_gex: pyRound(peGex, 2),
      net_gex: pyRound(ceGex - peGex, 2),
    })
  }

  const futuresPrice = await d.options.futuresPrice(
    q.underlying,
    q.exchange,
    q.expiry_date,
    chain.underlying_ltp,
  )

  const total = (k: 'ce_oi' | 'pe_oi' | 'ce_gex' | 'pe_gex' | 'net_gex') =>
    pySum(gexChain.map((r) => r[k]))
  const totalCeOi = total('ce_oi')
  const totalPeOi = total('pe_oi')

  return {
    status: 'success',
    underlying: chain.underlying,
    spot_price: spot,
    futures_price: futuresPrice,
    lot_size: lotSize || 1,
    atm_strike: chain.atm_strike,
    expiry_date: q.expiry_date,
    pcr_oi: totalCeOi > 0 ? pyRound(totalPeOi / totalCeOi, 2) : 0,
    total_ce_oi: totalCeOi,
    total_pe_oi: totalPeOi,
    total_ce_gex: pyRound(total('ce_gex'), 2),
    total_pe_gex: pyRound(total('pe_gex'), 2),
    total_net_gex: pyRound(total('net_gex'), 2),
    chain: gexChain,
  }
}
