// `/optionchain` replies for the native tests, as services/option_chain_service.py sends them:
// a strike ladder around a spot, each leg priced with a smooth time value so that every leg inverts
// to an implied volatility. `old` is a server before 2.0.2.0 (b7cdf2636): no quote identity, no
// expiry instant and no server clock.

export type ChainSpec = {
  underlying?: string
  /** DDMMMYY. */
  expiry?: string
  spot?: number
  /** Strikes below and above the ATM strike. */
  each?: number
  step?: number
  lot?: number
  /** Added to every LTP, so two replies tell apart. */
  bump?: number
  /** The 2.0.0.0 body: no underlying_symbol, underlying_exchange, expiry_ts or server_ts. */
  old?: boolean
  underlyingExchange?: string
  /** epoch seconds; the 15:30 IST cut-off of `expiry` by default. */
  expiryTs?: number
  serverTs?: number
  optionsExchange?: string
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** 15:30 IST of a DDMMMYY expiry, epoch seconds. */
export function cutoffSec(ddmmmyy: string): number {
  const dd = Number(ddmmmyy.slice(0, 2))
  const month = MONTHS.indexOf(ddmmmyy.slice(2, 5))
  const yy = Number(ddmmmyy.slice(5, 7))
  return Date.UTC(2000 + yy, month, dd, 10, 0) / 1000
}

const round05 = (x: number) => Math.round(x * 20) / 20

/** A leg's LTP: its intrinsic value plus a time value that falls away from the money. */
function premium(type: 'CE' | 'PE', K: number, spot: number, bump: number): number {
  const intrinsic = type === 'CE' ? Math.max(spot - K, 0) : Math.max(K - spot, 0)
  const away = (K - spot) / 300
  return round05(intrinsic + 6 + 140 * Math.exp(-away * away) + bump)
}

/** The raw JSON body; the api fakes parse it with the app's own schema. */
export function chainReply(s: ChainSpec = {}): Record<string, unknown> {
  const underlying = s.underlying ?? 'NIFTY'
  const expiry = s.expiry ?? '02DEC26'
  const spot = s.spot ?? 24567.8
  const each = s.each ?? 10
  const step = s.step ?? 50
  const lot = s.lot ?? 75
  const bump = s.bump ?? 0
  const atm = Math.round(spot / step) * step
  const chain = []
  for (let i = -each; i <= each; i++) {
    const strike = atm + i * step
    const leg = (type: 'CE' | 'PE') => {
      const ltp = premium(type, strike, spot, bump)
      const away = (type === 'CE' ? 1 : -1) * (strike - atm)
      return {
        symbol: `${underlying}${expiry}${strike}${type}`,
        label: away === 0 ? 'ATM' : `${away < 0 ? 'ITM' : 'OTM'}${Math.abs(away / step)}`,
        ltp,
        bid: round05(ltp - 0.05),
        ask: round05(ltp + 0.05),
        bid_qty: lot * 4,
        ask_qty: lot * 6,
        open: ltp,
        high: round05(ltp * 1.05),
        low: round05(ltp * 0.95),
        prev_close: round05(ltp * 0.98),
        volume: 1000 * (each + 1 - Math.abs(i)),
        oi: 25_000 * (each + 2 - Math.abs(i)) + (type === 'PE' ? 5_000 : 0),
        lotsize: lot,
        tick_size: 0.05,
      }
    }
    chain.push({ strike, ce: leg('CE'), pe: leg('PE') })
  }
  const body: Record<string, unknown> = {
    status: 'success',
    underlying,
    underlying_ltp: spot,
    underlying_prev_close: round05(spot - 120),
    expiry_date: expiry,
    atm_strike: atm,
    chain,
  }
  if (!s.old) {
    Object.assign(body, {
      underlying_symbol: underlying,
      underlying_exchange: s.underlyingExchange ?? 'NSE_INDEX',
      expiry_ts: s.expiryTs ?? cutoffSec(expiry),
      server_ts: s.serverTs ?? Math.floor(Date.now() / 1000),
      quotes_included: true,
      greeks_included: false,
      forward_price: null,
    })
  }
  return body
}
