// The IV Smile route, answered on the phone: POST /ivsmile/api/iv-smile-data
// (blueprints/ivsmile.py:24-78 at openalgo.ref), a port of services/iv_smile_service.py
// get_iv_smile_data (:18-181) over /api/v1/optionchain at 25 strikes a side. Each priced leg's IV
// is calculate_greeks' at F = the spot (spotGreeks, on the server's clock); an IV of 0 or an
// error reply is null. ATM IV is the mean of the ATM legs, and the skew compares the legs nearest
// 5% out of the money on either side.
import type { IVSmileChainItem, IVSmileDataResponse } from '@/api/iv-smile'
import { spotGreeks } from '~/market/options/black76'
import { optionsExchangeOf } from '~/market/options/expiry'
import { pyRound } from '~/market/options/pyRound'
import type { ChainLeg } from '~/market/options/schemas'
import { NO_SPOT, type RouteDeps, type RouteOptions, routeError } from './deps'
import type { ToolQuery } from './query'

/** 25 strikes around ATM, "sufficient for IV smile" (:37-44). */
const STRIKES = 25
/** Strikes about 5% from ATM stand in for the 25-delta legs (:133-134). */
const SKEW_DISTANCE = 0.05

/**
 * The first row of `sorted(rows, key=abs(strike - target))` that `keep` accepts: the nearest
 * kept row, the earlier one of two as near (Python's sort is stable).
 */
function nearest(
  rows: readonly IVSmileChainItem[],
  target: number,
  keep: (r: IVSmileChainItem) => boolean,
): IVSmileChainItem | undefined {
  let best: IVSmileChainItem | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const r of rows) {
    const distance = Math.abs(r.strike - target)
    if (keep(r) && distance < bestDistance) {
      best = r
      bestDistance = distance
    }
  }
  return best
}

export async function ivSmile(
  q: ToolQuery,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<IVSmileDataResponse> {
  const chain = await d.options.chain({ ...q, strike_count: STRIKES }, { signal: o.signal })
  const spot = chain.underlying_ltp
  const atm = chain.atm_strike
  if (!(spot > 0)) throw routeError(500, NO_SPOT)

  const exchange = optionsExchangeOf(q.exchange)
  const nowMs = d.now()
  const ivOf = (leg: ChainLeg | null): number | null => {
    if (!leg?.symbol || !(leg.ltp > 0)) return null
    const g = spotGreeks({ symbol: leg.symbol, exchange, spot, price: leg.ltp, nowMs })
    return g && g.iv > 0 ? pyRound(g.iv, 2) : null
  }

  const ivChain: IVSmileChainItem[] = []
  let atmCeIv: number | null = null
  let atmPeIv: number | null = null
  for (const item of chain.chain) {
    const ceIv = ivOf(item.ce)
    const peIv = ivOf(item.pe)
    if (item.strike === atm) {
      atmCeIv = ceIv
      atmPeIv = peIv
    }
    ivChain.push({ strike: item.strike, ce_iv: ceIv, pe_iv: peIv })
  }

  const atmIv =
    atmCeIv !== null && atmPeIv !== null
      ? pyRound((atmCeIv + atmPeIv) / 2, 2)
      : (atmCeIv ?? atmPeIv)

  let skew: number | null = null
  if (atm && ivChain.length > 0) {
    const distance = atm * SKEW_DISTANCE
    const put = nearest(ivChain, atm - distance, (r) => r.strike < atm && r.pe_iv !== null)
    const call = nearest(ivChain, atm + distance, (r) => r.strike > atm && r.ce_iv !== null)
    const putIv = put?.pe_iv ?? null
    const callIv = call?.ce_iv ?? null
    if (putIv !== null && callIv !== null) skew = pyRound(putIv - callIv, 2)
  }

  return {
    status: 'success',
    underlying: chain.underlying,
    spot_price: spot,
    atm_strike: atm,
    atm_iv: atmIv,
    skew,
    expiry_date: q.expiry_date,
    chain: ivChain,
  }
}
