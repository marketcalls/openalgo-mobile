// The golden cases and the /api/v1 calls recorded for each (design 9.2). A recorded reply is
// stored under its request key, which the harness (scripts/golden/harness.py) and the
// TypeScript fake Api (test/helpers/golden.ts) look answers up by.

/** The cases. `realOnly` ones need a real server: the mock lists no MCX options. */
export const CASES = Object.freeze([
  { id: 'nifty', underlying: 'NIFTY', exchange: 'NFO', pick: 'nearest' },
  { id: 'banknifty', underlying: 'BANKNIFTY', exchange: 'NFO', pick: 'monthly' },
  { id: 'sensex', underlying: 'SENSEX', exchange: 'BFO', pick: 'nearest' },
  { id: 'crudeoil', underlying: 'CRUDEOIL', exchange: 'MCX', pick: 'nearest', realOnly: true },
])

/** The strike counts the five ported services fetch (OI Tracker and Gamma Density, IV Smile, GEX). */
export const CHAIN_COUNTS = Object.freeze([23, 25, 45])
/** The chain the legs, the with_greeks golden and serverNowMs come from. */
export const LEGS_CHAIN = 25
/** Strategy Builder's chain (plan F), recorded on servers from 2.0.2.0. */
export const GREEKS_CHAIN = 20

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** JSON with object keys sorted at every depth: src/core/http/api.ts `stableJson`, copied. */
export function stableJson(v) {
  return JSON.stringify(v, (_k, x) =>
    isRecord(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
}

/** `${endpoint} ${stableJson(body without apikey)}`, as the app's Api dedupes a read. */
export function requestKey(endpoint, body) {
  const { apikey: _key, ...rest } = body
  return `${endpoint} ${stableJson(rest)}`
}

/** The two expiry reads, sent before the expiry and the future are known. */
export function expiryCalls(c) {
  const read = (instrumenttype) => ({
    endpoint: 'expiry',
    body: { symbol: c.underlying, exchange: c.exchange, instrumenttype },
  })
  return [read('options'), read('futures')]
}

/**
 * The chain read at `strike_count` for `expiry` (DDMMMYY): with no with_greeks key, or with
 * `with_greeks: true` when `withGreeks` (a 2.0.2.0 field, never sent as false).
 */
export function chainCall(c, expiry, strikeCount, { withGreeks = false } = {}) {
  const body = {
    underlying: c.underlying,
    exchange: c.exchange,
    expiry_date: expiry,
    strike_count: strikeCount,
  }
  return { endpoint: 'optionchain', body: withGreeks ? { ...body, with_greeks: true } : body }
}

/** A history read: `window` is { start_date, end_date }, both IST YYYY-MM-DD. */
export function historyCall(symbol, exchange, interval, window) {
  return { endpoint: 'history', body: { symbol, exchange, interval, ...window } }
}

/** A quote read. */
export function quotesCall(symbol, exchange) {
  return { endpoint: 'quotes', body: { symbol, exchange } }
}

/**
 * Every call recorded for a case, in order: the two expiry reads, the chains at 23, 25 and
 * 45, the with_greeks chain at 20 when `withGreeks` (a real server from 2.0.2.0), then the
 * future's quote when there is one (`fut` null: no futures listed).
 */
export function recordedCalls(c, expiry, fut, { withGreeks = false } = {}) {
  const calls = [...expiryCalls(c), ...CHAIN_COUNTS.map((n) => chainCall(c, expiry, n))]
  if (withGreeks) calls.push(chainCall(c, expiry, GREEKS_CHAIN, { withGreeks }))
  if (fut) calls.push(quotesCall(fut, c.exchange))
  return calls
}
