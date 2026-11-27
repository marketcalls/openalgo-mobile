// Expiry instants and option symbology as the server derives them (design 7.8, "server
// conventions"): services/option_greeks_service.py at openalgo.ref, cited by function.

/** IST cut-off (hour, minute) per options exchange: EXCHANGE_EXPIRY_TIMES. */
export const EXPIRY_CUTOFF_IST: Readonly<Record<string, readonly [number, number]>> = Object.freeze(
  { MCX: [23, 30], CDS: [12, 30] } as const,
)

/** DEFAULT_EXPIRY_TIME: NFO, BFO and any other exchange follow the equity session. */
const DEFAULT_CUTOFF: readonly [number, number] = [15, 30]
/** The cut-offs by exact exchange code, as dict.get looks them up ('constructor' included). */
const CUTOFFS = new Map(Object.entries(EXPIRY_CUTOFF_IST))

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** IST is UTC+05:30 all year. */
const IST_OFFSET_MS = 330 * 60_000

type ExpiryParts = { dd: string; mmm: string; yy: string }

/** The day, month and two-digit year of an expiry in either form, trimmed and upper-cased. */
function expiryParts(e: string): ExpiryParts | null {
  const m = /^(\d{2})(-?)([A-Z]{3})(-?)(\d{2})$/.exec(e.trim().toUpperCase())
  if (!m) return null
  const [, dd, dash1, mmm, dash2, yy] = m
  // Both dashes or none: '28-NOV25' is neither form.
  if (!dd || !mmm || !yy || dash1 !== dash2 || !MONTHS.includes(mmm)) return null
  return { dd, mmm, yy }
}

/** The expiry day at an IST wall-clock time as epoch ms; null if the day is not in the month. */
function istInstant(p: ExpiryParts, hour: number, minute: number): number | null {
  const year = 2000 + Number(p.yy)
  const month = MONTHS.indexOf(p.mmm)
  const day = Number(p.dd)
  const utc = Date.UTC(year, month, day, hour, minute)
  const d = new Date(utc)
  // Date.UTC rolls 31 NOV over to 1 DEC, where Python's datetime() raises.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    return null
  }
  return utc - IST_OFFSET_MS
}

/** '28-NOV-25' (the expiry service's form) or '28NOV25' → '28NOV25' (the request form). */
export function toDdmmmyy(e: string): string | null {
  const p = expiryParts(e)
  return p ? `${p.dd}${p.mmm}${p.yy}` : null
}

/** Either form → '28-NOV-25', as the web's expiry pickers show it. */
export function toDashed(e: string): string | null {
  const p = expiryParts(e)
  return p ? `${p.dd}-${p.mmm}-${p.yy}` : null
}

/**
 * get_expiry_datetime: the expiry day at the exchange's IST cut-off, as epoch ms, or null when
 * the code is not a calendar date. Either expiry form is accepted.
 */
export function expiryInstantMs(ddmmmyy: string, exchange: string): number | null {
  const p = expiryParts(ddmmmyy)
  if (!p) return null
  const [hour, minute] = CUTOFFS.get(exchange) ?? DEFAULT_CUTOFF
  return istInstant(p, hour, minute)
}

/**
 * calculate_time_to_expiry: 0 once the expiry is past (the server's "Option has expired");
 * otherwise days = seconds / 86400 and years = days / 365, floored at 1e-4 years.
 */
export function serverYears(expiryMs: number, nowMs: number): { years: number; days: number } {
  if (expiryMs < nowMs) return { years: 0, days: 0 }
  const days = (expiryMs - nowMs) / 1000 / 86400
  const years = days / 365
  // "Less than ~1 hour": the server prices at the floor and reports the floor's days.
  if (years < 0.0001) return { years: 0.0001, days: 0.0001 * 365 }
  return { years, days }
}

/** parse_option_symbol's pattern, applied to the upper-cased symbol. */
const OPTION_SYMBOL = /^([A-Z0-9&-]+?)(\d{2})([A-Z]{3})(\d{2})([\d.]+)(CE|PE)$/

/**
 * parse_option_symbol: underlying, DDMMMYY expiry, strike and type, or null where the server
 * answers "Failed to parse option symbol": no match, an unknown month, a strike float() refuses,
 * or a day that is not in the month.
 */
export function parseOptionSymbol(
  s: string,
): { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
  const m = OPTION_SYMBOL.exec(s.toUpperCase())
  if (!m) return null
  const [, underlying, dd, mmm, yy, strikeText, type] = m
  if (!underlying || !dd || !mmm || !yy || !strikeText || (type !== 'CE' && type !== 'PE')) {
    return null
  }
  const strike = Number(strikeText)
  const parts = { dd, mmm, yy }
  if (Number.isNaN(strike) || !MONTHS.includes(mmm) || istInstant(parts, 0, 0) === null) {
    return null
  }
  return { underlying, expiry: `${dd}${mmm}${yy}`, strike, type }
}

/** The options exchange of an underlying's exchange, as the chain services derive it. */
export function optionsExchangeOf(ex: string): string {
  const up = ex.toUpperCase()
  if (up === 'NSE' || up === 'NSE_INDEX') return 'NFO'
  if (up === 'BSE' || up === 'BSE_INDEX') return 'BFO'
  return up
}
