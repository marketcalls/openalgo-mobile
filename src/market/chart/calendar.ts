// The chart's session calendar, built from OpenAlgo's own market calendar (design 7.9.3). A port
// of frontend/src/lib/trading/sessionHours.ts:32-121 (c8b2896), reading the app's key-bearing
// /api/v1 `market/timings` and `market/holidays` where the web page reads its admin timings.
// Nothing here may stop a chart drawing: every failure gives the server's default hours.
import type { Api } from '~/core/http/api'
import { log } from '~/core/log/logger'
import { istDate } from '~/core/realtime/marketHours'
import type { CalendarSpecJson } from '~/dom/bridge/protocol'
import { type HolidayRow, HolidaysSchema, type Timing, TimingsSchema } from './schemas'

export const IST_OFFSET_MS = 19_800_000
const DAY_MS = 86_400_000
const NSE_OPEN_MS = 33_300_000
const NSE_WINDOW_MS = 22_500_000
const SKEW_STEP_MS = 900_000
const SKEW_LIMIT_MS = 50_400_000
/** Walk back at most this many timings calls to find a day the exchanges traded. */
const MAX_TIMINGS_CALLS = 3
/** Exchanges that trade round the clock, every day, with no holidays. */
const ROUND_THE_CLOCK = new Set(['CRYPTO'])
/** The cash market's pre-open, a fixed exchange rule the server does not store. */
const PRE_OPEN_MINUTES: Record<string, number> = { NSE: 15, BSE: 15 }

export type TimingRow = { exchange: string; start_offset: number; end_offset: number }

const row = (exchange: string, start: number, end: number): TimingRow => ({
  exchange,
  start_offset: start,
  end_offset: end,
})

/** The server's defaults (database/market_calendar_db.py:57-73), offsets from IST midnight. */
export const DEFAULT_TIMINGS: readonly TimingRow[] = [
  row('NSE', 33_300_000, 55_800_000),
  row('BSE', 33_300_000, 55_800_000),
  row('NFO', 33_300_000, 56_400_000),
  row('BFO', 33_300_000, 56_400_000),
  row('CDS', 32_400_000, 61_200_000),
  row('BCD', 32_400_000, 61_200_000),
  row('MCX', 32_400_000, 86_100_000),
  row('NCO', 32_400_000, 86_100_000),
  row('CRYPTO', 0, DAY_MS),
]

const validWindow = (r: TimingRow) =>
  0 <= r.start_offset && r.start_offset < r.end_offset && r.end_offset <= DAY_MS

/**
 * Today's rows as offsets from the IST midnight of `dateIst`. The server builds ordinary rows
 * from a naive midnight in its own time zone, so a server not on IST sends shifted rows: the NSE
 * (else BSE) row is the check. Null when no exchange hours can be trusted.
 */
export function timingOffsets(rows: Timing[], dateIst: string): TimingRow[] | null {
  const midnight = Date.parse(`${dateIst}T00:00:00Z`) - IST_OFFSET_MS
  const anchor = rows.find((r) => r.exchange === 'NSE') ?? rows.find((r) => r.exchange === 'BSE')
  if (!anchor || Number.isNaN(midnight)) return null
  const skew = anchor.start_time - midnight - NSE_OPEN_MS
  if (skew !== 0) {
    const window = anchor.end_time - anchor.start_time
    if (window !== NSE_WINDOW_MS || skew % SKEW_STEP_MS !== 0 || Math.abs(skew) > SKEW_LIMIT_MS) {
      log.info('chart', 'timings not in IST hours: defaults')
      return null
    }
  }
  const out: TimingRow[] = []
  for (const r of rows) {
    const got = row(r.exchange, r.start_time - midnight - skew, r.end_time - midnight - skew)
    if (validWindow(got)) out.push(got)
    else {
      const fallback = DEFAULT_TIMINGS.find((d) => d.exchange === r.exchange)
      if (fallback) out.push(fallback)
    }
  }
  return out
}

/** The exchange whose calendar an instrument follows: an index trades the hours of its exchange. */
export function calendarExchange(exchange: string): string {
  return exchange.endsWith('_INDEX') ? exchange.slice(0, -'_INDEX'.length) : exchange
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}${pad(minutes % 60)}`

/** Minutes after IST midnight and the IST date of an epoch in milliseconds. */
function istClock(ms: number): { date: string; minutes: number } {
  const shifted = new Date(ms + IST_OFFSET_MS)
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** A special session's window on its own date, or null when the row does not describe one. */
function sessionWindow(start: number, end: number, date: string): string | null {
  if (!(end > start)) return null
  const open = istClock(start)
  if (open.date !== date) return null
  const close = istClock(end)
  if (open.minutes === close.minutes) return null
  return `${hhmm(open.minutes)}-${hhmm(close.minutes)}`
}

/**
 * The calendar spec for one exchange, or null when `timings` has no hours for it. A holiday
 * closes the exchanges it lists; a special session is its own window; a settlement holiday
 * changes nothing.
 */
export function calendarSpec(
  exchange: string,
  timings: readonly TimingRow[],
  holidays: readonly HolidayRow[],
): CalendarSpecJson | null {
  const code = calendarExchange(exchange)
  const r = timings.find((t) => t.exchange === code)
  if (!r) return null
  const start = Number(r.start_offset)
  const end = Number(r.end_offset)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > DAY_MS || end <= start)
    return null
  const allDay = ROUND_THE_CLOCK.has(code)
  // 00:00 to 23:59:59 is how the server writes a day without a close.
  const window =
    start === 0 && end >= DAY_MS - 60_000
      ? '0000-0000'
      : `${hhmm(Math.floor(start / 60_000))}-${hhmm(Math.floor(end / 60_000))}`
  const exceptions: Record<string, string[]> = {}
  if (!allDay) {
    for (const h of holidays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date) || h.holiday_type === 'SETTLEMENT_HOLIDAY') continue
      const open = h.open_exchanges
        .filter((o) => o.exchange === code)
        .map((o) => sessionWindow(o.start_time, o.end_time, h.date))
        .filter((w): w is string => w !== null)
      // A special session lists the exchanges that open; the others stay shut that day.
      if (open.length) exceptions[h.date] = open
      else if (h.closed_exchanges.includes(code) || h.holiday_type === 'SPECIAL_SESSION')
        exceptions[h.date] = []
    }
  }
  return {
    timezone: allDay ? 'UTC' : 'Asia/Kolkata',
    sessions: [allDay ? window : `${window}:23456`],
    exceptions,
    ...(PRE_OPEN_MINUTES[code] ? { preMarketMinutes: PRE_OPEN_MINUTES[code] } : {}),
  }
}

/** The years a calendar needs on `dateIst`: a January chart reaches back, a December one ahead. */
export function yearsAround(dateIst: string): number[] {
  const year = Number(dateIst.slice(0, 4))
  const month = Number(dateIst.slice(5, 7))
  return month === 1 ? [year - 1, year] : month === 12 ? [year, year + 1] : [year]
}

export type Calendars = {
  calendars: Record<string, CalendarSpecJson>
  source: 'server' | 'defaults'
}

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCO', 'CRYPTO'] as const

const build = (timings: readonly TimingRow[], holidays: readonly HolidayRow[]) => {
  // An exchange the reply lacks (NCO and CRYPTO on 2.0.0.0, or a closed one) takes its default.
  const rows = EXCHANGES.flatMap((e) => {
    const found =
      timings.find((t) => t.exchange === e) ?? DEFAULT_TIMINGS.find((t) => t.exchange === e)
    return found ? [found] : []
  })
  const calendars: Record<string, CalendarSpecJson> = {}
  for (const e of EXCHANGES) {
    const spec = calendarSpec(e, rows, holidays)
    if (spec) calendars[e] = spec
  }
  return calendars
}

const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())

const previousDay = (day: string) => istDate(Date.parse(`${day}T00:00:00Z`) - DAY_MS)

/** True when a day's rows would be absolute special-session or holiday epochs, not the weekly hours. */
const isUnusual = (day: string, holidays: readonly HolidayRow[]) =>
  holidays.some(
    (h) =>
      h.date === day &&
      (h.holiday_type === 'SPECIAL_SESSION' || h.holiday_type === 'TRADING_HOLIDAY'),
  )

/**
 * The calendars for every exchange, today in IST. Today's timings answer first, then earlier
 * weekdays (not holidays or special sessions) until a reply holds NSE or BSE, in at most three
 * calls. Any failure, `Unsupported` included, gives the defaults.
 */
export async function loadCalendars(api: Pick<Api, 'call'>, now: number): Promise<Calendars> {
  const today = istDate(now)
  let holidays: HolidayRow[] = []
  try {
    const years = await Promise.all(
      yearsAround(today).map((year) => api.call('market/holidays', { year }, HolidaysSchema)),
    )
    holidays = years.flat()
    let day = today
    for (let calls = 0, steps = 0; calls < MAX_TIMINGS_CALLS && steps < 14; steps++) {
      if (!isWeekend(day) && !isUnusual(day, holidays)) {
        calls++
        const rows = await api.call('market/timings', { date: day }, TimingsSchema)
        if (rows.some((r) => r.exchange === 'NSE' || r.exchange === 'BSE')) {
          const offsets = timingOffsets(rows, day)
          if (!offsets) break
          return { calendars: build(offsets, holidays), source: 'server' }
        }
      }
      day = previousDay(day)
    }
  } catch (e) {
    log.info('chart', 'calendar read failed: defaults', e)
  }
  return { calendars: build(DEFAULT_TIMINGS, holidays), source: 'defaults' }
}
