// What plan F's series routes (Option Greeks, OI Profile, both straddles, the strategy charts)
// share, as the server's services compute it: the history window and the last-N-dates cap
// (strategy_chart_service.py:42-57 and 125-141, which the others import), candle times
// (oi_profile_service.py:370-377), the ATM strike and the option symbol
// (option_symbol_service.py:382-411 and 590-621).
import { istDate } from '~/core/realtime/marketHours'
import type { HistoryRow } from '~/market/chart/schemas'

/** A candle time in epoch seconds: a value over 1e12 is milliseconds. */
export const tsSeconds = (t: number): number => (t > 1e12 ? Math.floor(t / 1000) : Math.trunc(t))

/** The IST date, YYYY-MM-DD, of a time in epoch seconds. */
export const istDay = (sec: number): string => istDate(sec * 1000)

/**
 * _resolve_trading_window: today in IST and max(2, 3·days + 2) calendar days before it, a window
 * wide enough to hold `days` trading dates in any market; capLastNDates trims what comes back.
 */
export function tradingWindow(
  days: number,
  nowMs: number,
): { start_date: string; end_date: string } {
  const end = istDate(nowMs)
  const start = new Date(`${end}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - Math.max(2, days * 3 + 2))
  return { start_date: start.toISOString().slice(0, 10), end_date: end }
}

/**
 * _cap_last_n_trading_dates: the rows whose IST date is among the last `n` distinct dates the
 * series has, in their order. Days with no rows do not count, so a weekend-closed market and a
 * 24×7 one both get `n` dates. `n` ≤ 0 keeps every row.
 */
export function capLastNDates<T extends { time: number }>(rows: readonly T[], n: number): T[] {
  if (rows.length === 0 || n <= 0) return [...rows]
  const days = rows.map((r) => istDay(r.time))
  const keep = new Set([...new Set(days)].sort().reverse().slice(0, n))
  return rows.filter((_, i) => keep.has(days[i] as string))
}

/**
 * find_atm_strike_from_actual: the strike nearest `ltp`, the first of two at the same distance
 * (Python's min); null with no strikes or an `ltp` that is not a finite number.
 */
export function nearestStrike(ltp: number, strikes: readonly number[]): number | null {
  if (strikes.length === 0 || !Number.isFinite(ltp)) return null
  let best = strikes[0] as number
  let bestGap = Math.abs(best - ltp)
  for (const k of strikes) {
    const gap = Math.abs(k - ltp)
    if (gap < bestGap) {
      best = k
      bestGap = gap
    }
  }
  return best
}

/**
 * construct_option_symbol: a whole strike without its decimals (24000), any other as Python's
 * str() writes it (83.5), which JavaScript's shortest form equals from 1e-4 to 1e16.
 */
export function optionSymbol(
  base: string,
  ddmmmyy: string,
  strike: number,
  type: 'CE' | 'PE',
): string {
  return `${base}${ddmmmyy}${String(strike)}${type}`
}

/**
 * The services' close per candle (`lookup[ts] = close` over the time-sorted frame): epoch seconds
 * to close, ascending; a time seen twice keeps the later row's close.
 */
export function closesByTime(rows: readonly HistoryRow[]): Map<number, number> {
  const sorted = rows
    .map((r) => ({ sec: tsSeconds(r.timestamp), close: r.close }))
    .sort((a, b) => a.sec - b.sec)
  const out = new Map<number, number>()
  for (const r of sorted) out.set(r.sec, r.close)
  return out
}
