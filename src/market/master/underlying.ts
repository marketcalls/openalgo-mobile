// The underlying of an OpenAlgo F&O symbol, as the server's symbol cache derives it
// (database/token_db_enhanced.py:20-88 at openalgo.ref): NIFTY28MAR2420800CE → NIFTY.

/** utils/constants.py FNO_EXCHANGES, CRYPTO_EXCHANGES included. */
const FNO_EXCHANGES: ReadonlySet<string> = new Set([
  'NFO',
  'BFO',
  'MCX',
  'CDS',
  'BCD',
  'NCDEX',
  'NCO',
  'CRYPTO',
])
const CRYPTO_EXCHANGES: ReadonlySet<string> = new Set(['CRYPTO'])

/**
 * _UNDERLYING_PATTERN (:25-30), on the upper-cased symbol: the shortest run before a DDMMMYY
 * date, then an optional strike and FUT, CE or PE to the end. So M&M and BAJAJ-AUTO parse.
 */
const UNDERLYING =
  /^(.+?)(\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2})(?:\d+(?:\.\d+)?)?(?:FUT|CE|PE)?$/
/** _CRYPTO_UNDERLYING_PATTERN (:40): the letters and digits before the first DDMMMYY. */
const CRYPTO_UNDERLYING = /^([A-Z0-9]+?)(?=\d{2}[A-Z]{3}\d{2})/
/** A perpetual's quote currency (:79-81), tried in this order. */
const PERPETUAL_SUFFIXES = ['USDT', 'USD', '_INR', 'INR'] as const

/**
 * extract_underlying_from_symbol (:45-88): null for an exchange outside F&O, or a symbol with no
 * DDMMMYY in it. A CRYPTO perpetual (BTCUSD.P, ETHUSDT) is its symbol without `.P` and the quote
 * currency, or the whole symbol.
 */
export function extractUnderlying(symbol: string, exchange: string): string | null {
  if (!symbol || !FNO_EXCHANGES.has(exchange)) return null
  const upper = symbol.toUpperCase()
  if (CRYPTO_EXCHANGES.has(exchange)) {
    const m = CRYPTO_UNDERLYING.exec(upper)
    if (m?.[1]) return m[1]
    const bare = upper.endsWith('.P') ? upper.slice(0, -2) : upper
    for (const suffix of PERPETUAL_SUFFIXES) {
      if (bare.endsWith(suffix) && bare.length > suffix.length) return bare.slice(0, -suffix.length)
    }
    return bare
  }
  return UNDERLYING.exec(upper)?.[1] ?? null
}
