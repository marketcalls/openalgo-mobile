// The native Option Chain's live layer (design 7.8, 17.4): the polled chain with the feed's ticks
// merged in and every leg repriced from them, a port of the web's useOptionChainLive.ts:31-171
// (withGreeks and mergeOptionChainMarketData) on the web's own Black-76 (lib/optionGreeks.ts). The
// screen prices one row at a time (`mergeRow`, `priceRow`) so a tick re-renders its row alone; the
// forward and the years left (`livePricing`) are shared by every row. `liveChain` is the whole chain
// at once, the form the compat suite holds to the web's merge.
import {
  chainGreeks,
  forwardFromParity,
  type Greeks,
  priceForGreeks,
  yearsToExpiry,
} from '@/lib/optionGreeks'
import type { Quote } from '~/core/realtime/protocol'
import { expiryInstantMs, toDdmmmyy } from './expiry'
import type { ChainLeg, ChainRow, OptionChain } from './schemas'

/** OptionChain.tsx:50-56. */
export const STRIKE_COUNTS = [5, 10, 15, 20, 25] as const
export type StrikeCount = (typeof STRIKE_COUNTS)[number]
export const DEFAULT_STRIKE_COUNT: StrikeCount = 10
/** OI and volume come from the poll: with the live feed, this often (OptionChain.tsx:614). */
export const CHAIN_REFRESH_LIVE_MS = 30_000
/** The forward, the years left and the spot's marks move at most this often. */
export const FORWARD_THROTTLE_MS = 1000

/** The default rate (option_greeks_service DEFAULT_INTEREST_RATES), as the web prices at. */
const RATE_PCT = 0

/** The quote of a store key (`EX:SYM`); undefined when the feed carries none. */
export type QuoteOf = (key: string) => Quote | undefined

export type LiveOptions = {
  optionsExchange: string
  /** The underlying's quote key (`underlyingOf`). */
  underlyingKey: string
  /** Server minus device, ms (ServerClock.offsetMs). */
  clockOffsetMs: number
}

/**
 * The expiry instant in epoch seconds: the server's `expiry_ts` (2.0.2.0+), else the exchange's
 * cut-off on the `DDMMMYY` date (RF 4). Null when neither gives one.
 */
export function chainExpiryTs(c: OptionChain, optionsExchange: string): number | null {
  if (typeof c.expiry_ts === 'number') return c.expiry_ts
  const ms = expiryInstantMs(c.expiry_date, optionsExchange)
  return ms === null ? null : ms / 1000
}

/**
 * roundToTickSize (useOptionChainLive.ts:10-18): broker ticks are not always on the tick grid.
 * The web's own arithmetic, toFixed(2) included, so both chains agree to the paisa.
 */
function roundToTick(price: number | undefined, tick: number): number | undefined {
  if (price === undefined) return undefined
  if (!tick || tick <= 0) return price
  return Number((Math.round(price / tick) * tick).toFixed(2))
}

/**
 * A leg with its tick merged in (useOptionChainLive.ts:127-144): the LTP, and the top of the book
 * from depth level 0, else the quote's own bid and ask, each on the leg's tick; the chain's values
 * where the tick has none.
 */
export function mergeLeg(leg: ChainLeg, q: Quote | undefined): ChainLeg {
  if (!q) return leg
  const buy = q.depth?.buy[0]
  const sell = q.depth?.sell[0]
  const ltp = roundToTick(q.ltp, leg.tick_size)
  const { ltpMissing: _missing, ...priced } = leg
  return {
    ...(ltp === undefined ? leg : priced),
    ltp: ltp ?? leg.ltp,
    bid: roundToTick(buy?.price ?? q.bid, leg.tick_size) ?? leg.bid,
    ask: roundToTick(sell?.price ?? q.ask, leg.tick_size) ?? leg.ask,
    bid_qty: buy?.quantity ?? leg.bid_qty,
    ask_qty: sell?.quantity ?? leg.ask_qty,
  }
}

const legKey = (optionsExchange: string, leg: ChainLeg) => `${optionsExchange}:${leg.symbol}`

export function mergeRow(row: ChainRow, quote: QuoteOf, optionsExchange: string): ChainRow {
  return {
    ...row,
    ce: row.ce ? mergeLeg(row.ce, quote(legKey(optionsExchange, row.ce))) : null,
    pe: row.pe ? mergeLeg(row.pe, quote(legKey(optionsExchange, row.pe))) : null,
  }
}

/**
 * What every leg is priced at: the underlying's live price, the forward from the ATM pair's
 * parity (else the spot), and the years to expiry on the server's clock. `forward` is null when
 * the chain cannot be priced (expired, or nothing to price from): its legs then keep the server's
 * Greeks.
 */
export type ChainPricing = { spot: number; forward: number | null; years: number }

/** withGreeks (useOptionChainLive.ts:31-56) up to the Greeks themselves. */
export function livePricing(c: OptionChain, quote: QuoteOf, o: LiveOptions): ChainPricing {
  const spot = quote(o.underlyingKey)?.ltp ?? c.underlying_ltp
  const years = yearsToExpiry(chainExpiryTs(c, o.optionsExchange), o.clockOffsetMs)
  if (years <= 0) return { spot, forward: null, years }
  const atm = c.chain.find((r) => r.strike === c.atm_strike)
  const merged = atm ? mergeRow(atm, quote, o.optionsExchange) : null
  const forward = forwardFromParity(
    c.atm_strike,
    merged?.ce ? priceForGreeks(merged.ce.ltp, merged.ce.bid, merged.ce.ask) : 0,
    merged?.pe ? priceForGreeks(merged.pe.ltp, merged.pe.bid, merged.pe.ask) : 0,
    spot,
  )
  return { spot, forward: forward > 0 ? forward : null, years }
}

const priceOf = (leg: ChainLeg | null) => (leg ? priceForGreeks(leg.ltp, leg.bid, leg.ask) : 0)

/** A fresh leg with these Greeks; none where the leg could not be priced (the web's `?.`). */
const withGreeks = (leg: ChainLeg, g: Greeks | null | undefined): ChainLeg => ({
  ...leg,
  implied_volatility: g?.iv,
  delta: g?.delta,
  gamma: g?.gamma,
  theta: g?.theta,
  vega: g?.vega,
})

/**
 * A row's legs with the Greeks of their own price (the mid, else the LTP) at `p`; the row as it
 * is when the chain cannot be priced. Fresh objects: the polled row is never changed.
 */
export function priceRow(row: ChainRow, p: ChainPricing): ChainRow {
  if (p.forward === null) return row
  const g = chainGreeks(
    [{ strike: row.strike, cePrice: priceOf(row.ce), pePrice: priceOf(row.pe) }],
    p.forward,
    p.years,
    RATE_PCT,
  )[0]
  return {
    ...row,
    ce: row.ce ? withGreeks(row.ce, g?.ce) : null,
    pe: row.pe ? withGreeks(row.pe, g?.pe) : null,
  }
}

/**
 * mergeOptionChainMarketData (useOptionChainLive.ts:107-171): the chain with every tick merged,
 * each leg repriced, the underlying's live LTP, and the forward the legs were priced at (the
 * server's while no tick has come for this chain).
 */
export function liveChain(c: OptionChain, quote: QuoteOf, o: LiveOptions): OptionChain {
  const p = livePricing(c, quote, o)
  const ticked =
    quote(o.underlyingKey) !== undefined ||
    c.chain.some(
      (r) =>
        (r.ce && quote(legKey(o.optionsExchange, r.ce))) ||
        (r.pe && quote(legKey(o.optionsExchange, r.pe))),
    )
  const repriced = p.forward ?? c.forward_price ?? null
  return {
    ...c,
    underlying_ltp: p.spot,
    forward_price: ticked ? repriced : (c.forward_price ?? repriced),
    chain: c.chain.map((r) => priceRow(mergeRow(r, quote, o.optionsExchange), p)),
  }
}

/** iv_chart_service.py:41-53: the index underlyings quoted on their index exchange. */
const NSE_INDEX_SYMBOLS: ReadonlySet<string> = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'NIFTYIT',
  'NIFTYPHARMA',
  'NIFTYBANK',
])
const BSE_INDEX_SYMBOLS: ReadonlySet<string> = new Set(['SENSEX', 'BANKEX', 'SENSEX50'])
/** option_symbol_service.py NO_SPOT_EXCHANGES: the underlying is quoted as its near future. */
const NO_SPOT_EXCHANGES: ReadonlySet<string> = new Set(['MCX', 'CDS', 'BCD', 'NCDEX', 'NCO'])
const CRYPTO_EXCHANGES: ReadonlySet<string> = new Set(['CRYPTO'])

/**
 * The quote the feed holds for a chain's underlying: the server's own identity when it names one
 * (2.0.2.0+); else as iv_chart_service.py:84-97 _get_quote_exchange derives it (an index on its
 * index exchange, a stock on NSE or BSE), and on MCX and CDS the near future from the `/expiry`
 * futures list (resolve_underlying_quote). CRYPTO has none: the chain poll's underlying_ltp is
 * the price there.
 */
export function underlyingOf(
  underlying: string,
  optionsExchange: string,
  c: OptionChain,
  futures: readonly string[],
): { symbol: string; exchange: string } | null {
  if (c.underlying_symbol && c.underlying_exchange) {
    return { symbol: c.underlying_symbol, exchange: c.underlying_exchange }
  }
  const ex = optionsExchange.toUpperCase()
  if (CRYPTO_EXCHANGES.has(ex)) return null
  if (NO_SPOT_EXCHANGES.has(ex)) {
    const code = futures[0] === undefined ? null : toDdmmmyy(futures[0])
    return code === null ? null : { symbol: `${underlying}${code}FUT`, exchange: ex }
  }
  if (NSE_INDEX_SYMBOLS.has(underlying)) return { symbol: underlying, exchange: 'NSE_INDEX' }
  if (BSE_INDEX_SYMBOLS.has(underlying)) return { symbol: underlying, exchange: 'BSE_INDEX' }
  if (ex === 'NFO') return { symbol: underlying, exchange: 'NSE' }
  if (ex === 'BFO') return { symbol: underlying, exchange: 'BSE' }
  return { symbol: underlying, exchange: ex }
}

/** Whether the underlying's quote needs the futures list (`underlyingOf` on MCX or CDS). */
export const needsFutures = (c: OptionChain, optionsExchange: string): boolean =>
  !(c.underlying_symbol && c.underlying_exchange) &&
  NO_SPOT_EXCHANGES.has(optionsExchange.toUpperCase())
