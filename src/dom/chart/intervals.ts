// The chart's intervals: which of the server's codes the widget can show, and which it opens on.
// Ports of frontend/src/lib/chart/intervalRegistry.ts:27-66 and
// frontend/src/lib/trading/intervals.ts:126-132 (openalgo c8b2896).
import { type CalendarUnit, isKnownInterval, registerInterval } from 'openalgo-charts'

/** Codes above a week, and the calendar unit each one buckets by. */
const CALENDAR_UNITS: Readonly<Record<string, CalendarUnit>> = {
  M: 'month',
  Q: 'quarter',
  Y: 'year',
}

/** An optional count then a calendar letter: `M`, `3M`, `Q`, `2Q`, `Y`, `2Y`. */
const CALENDAR_TOKEN = /^(\d*)([MQY])$/

/** A minute code, e.g. `1m` or `15m`. */
const MINUTES = /^\d+m$/

/**
 * Makes sure the engine can resolve `code`, registering it if it is a calendar timeframe it has
 * not been told about (the engine knows seconds to weeks; a month is no fixed number of seconds).
 * False for a code nothing can resolve, so a caller can leave it out instead of meeting the throw.
 */
export function ensureInterval(code: string): boolean {
  const token = code.trim()
  if (!token) return false
  if (isKnownInterval(token)) return true

  const match = CALENDAR_TOKEN.exec(token)
  const unit = match?.[2] === undefined ? undefined : CALENDAR_UNITS[match[2]]
  if (!match || unit === undefined) return false
  const count = match[1] === '' ? 1 : Number(match[1])
  if (!Number.isInteger(count) || count <= 0) return false

  registerInterval({ code: token, bucketing: { mode: 'calendar', unit, count } })
  return true
}

/** The server's codes the widget can show, in the server's order, once each. */
export function widgetIntervals(codes: readonly string[]): string[] {
  return [...new Set(codes.map((c) => c.trim()))].filter(ensureInterval)
}

/**
 * The interval to open on: the saved one if it is still offered, else 5m, else the first minute
 * interval, else whatever exists, else D.
 */
export function pickInterval(codes: readonly string[], saved: string | null): string {
  if (saved && codes.includes(saved)) return saved
  if (codes.includes('5m')) return '5m'
  return codes.find((c) => MINUTES.test(c)) ?? codes[0] ?? 'D'
}
