// The chart's server side in the mock: intervals, history bars, market timings and holidays
// (plan D K2). History is deterministic per symbol and bar time; the last bar closes at the
// mock's current price, so the chart agrees with the quotes and the WS ticks.
import { hash32, r05 } from './prices.mjs'

const IST_MS = 19_800_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** What `intervals` answers: the codes the mock's history serves. */
export const MOCK_INTERVALS = Object.freeze({
  seconds: [],
  minutes: ['1m', '3m', '5m', '10m', '15m', '30m'],
  hours: ['1h'],
  days: ['D'],
  weeks: ['W'],
  months: ['M'],
})

/** HistorySchema's OneOf at 2.0.0.0 (plan D conflict 6): what history validates before it asks the broker. */
export const HISTORY_INTERVALS = Object.freeze(
  '1s 5s 10s 15s 30s 45s 1m 2m 3m 5m 10m 15m 20m 30m 1h 2h 3h 4h D W M'.split(' '),
)

const STEP_MS = Object.freeze({
  '1m': MINUTE_MS,
  '3m': 3 * MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '10m': 10 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
})

// database/market_calendar_db.py:57-73 as offsets from midnight (the defaults, in ms).
const hm = (h, m) => (h * 60 + m) * MINUTE_MS
const DEFAULTS = Object.freeze({
  NSE: [hm(9, 15), hm(15, 30)],
  BSE: [hm(9, 15), hm(15, 30)],
  NFO: [hm(9, 15), hm(15, 40)],
  BFO: [hm(9, 15), hm(15, 40)],
  CDS: [hm(9, 0), hm(17, 0)],
  BCD: [hm(9, 0), hm(17, 0)],
  MCX: [hm(9, 0), hm(23, 55)],
  NCO: [hm(9, 0), hm(23, 55)],
  CRYPTO: [0, 86_399_000],
})
// The session an exchange without its own row keeps.
const SESSION_OF = Object.freeze({
  NSE_INDEX: 'NSE',
  BSE_INDEX: 'BSE',
  MCX_INDEX: 'MCX',
  GLOBAL_INDEX: 'NSE',
  NCDEX: 'MCX',
})
const sessionKey = (exchange) => SESSION_OF[exchange] ?? exchange
const F_AND_O = ['NFO', 'BFO', 'MCX', 'CDS']

const istMidnight = (dateIst) => Date.parse(`${dateIst}T00:00:00Z`) - IST_MS
const istDateOf = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10)
const addDays = (dateIst, n) => istDateOf(istMidnight(dateIst) + n * DAY_MS + IST_MS)
const isWeekend = (dateIst) => [0, 6].includes(new Date(`${dateIst}T00:00:00Z`).getUTCDay())

const holidayRow = (date, holiday_type, closed_exchanges, open_exchanges) => ({
  date,
  holiday_type,
  closed_exchanges,
  open_exchanges,
})
/** The fixture calendar: a trading holiday, and a Sunday special session in absolute epochs. */
export const MOCK_HOLIDAYS = Object.freeze([
  holidayRow(
    '2026-01-26',
    'TRADING_HOLIDAY',
    ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCO'],
    [],
  ),
  holidayRow(
    '2026-11-08',
    'SPECIAL_SESSION',
    [],
    ['NSE', 'BSE'].map((exchange) => ({
      exchange,
      start_time: istMidnight('2026-11-08') + 18 * HOUR_MS,
      end_time: istMidnight('2026-11-08') + 19 * HOUR_MS,
    })),
  ),
])

const holidayOn = (dateIst) => MOCK_HOLIDAYS.find((h) => h.date === dateIst)

/**
 * The day's market timings as the server builds them (K2): defaults from a naive midnight in the
 * server's zone, which `skewMs` moves (19_800_000 is a server on UTC); a weekend lists CRYPTO
 * only; a holiday lists its open exchanges, in stored absolute epochs that skew never moves.
 */
export function timingsFor(dateIst, skewMs = 0) {
  const holiday = holidayOn(dateIst)
  if (holiday) return holiday.open_exchanges.map((r) => ({ ...r }))
  const midnight = istMidnight(dateIst) + skewMs
  const keys = isWeekend(dateIst) ? ['CRYPTO'] : Object.keys(DEFAULTS)
  return keys.map((exchange) => ({
    exchange,
    start_time: midnight + DEFAULTS[exchange][0],
    end_time: midnight + DEFAULTS[exchange][1],
  }))
}

/** The `[start, end)` epoch ms an exchange trades on an IST date, or null. */
function sessionOn(exchange, dateIst) {
  const key = sessionKey(exchange)
  if (key === 'CRYPTO') return [istMidnight(dateIst), istMidnight(dateIst) + DEFAULTS.CRYPTO[1]]
  const row = timingsFor(dateIst).find((r) => r.exchange === key)
  return row ? [row.start_time, row.end_time] : null
}

function barStarts(session, interval, dateIst) {
  const [start, end] = session
  if (interval === 'D' || interval === 'W' || interval === 'M') return [istMidnight(dateIst)]
  const step = STEP_MS[interval]
  const out = []
  for (let t = start; t < end; t += step) out.push(t)
  return out
}

const periodStart = (interval, dateIst) => {
  if (interval === 'W')
    return addDays(dateIst, -((new Date(`${dateIst}T00:00:00Z`).getUTCDay() + 6) % 7))
  return interval === 'M' ? `${dateIst.slice(0, 8)}01` : dateIst
}

const MAX_BARS = 2000
const MAX_DAYS = 40_000

/** Bar start times (epoch ms), ascending: inside the sessions, up to `nowMs`, the newest 2,000. */
function barTimes({ exchange, interval, startDate, endDate, nowMs }) {
  const last = [endDate, istDateOf(nowMs)].sort()[0]
  const daily = !(interval in STEP_MS)
  const out = []
  let lastKey = null
  for (let d = last, n = 0; d >= startDate && n < MAX_DAYS && out.length <= MAX_BARS; n++) {
    const session = sessionOn(exchange, d)
    if (session) {
      if (daily) {
        const key = periodStart(interval, d)
        if (key !== lastKey) {
          out.push(istMidnight(key))
          lastKey = key
        }
      } else {
        const starts = barStarts(session, interval, d).filter((t) => t <= nowMs)
        for (let i = starts.length - 1; i >= 0; i--) out.push(starts[i])
      }
    }
    d = addDays(d, -1)
  }
  return out.reverse().slice(-MAX_BARS)
}

const unit = (symbol, t, salt) => hash32(`${symbol}:${t}:${salt}`) / 4294967296

/**
 * OHLCV rows, ascending, as `history` answers them (timestamp in epoch seconds). Deterministic
 * from the symbol and each bar's time; the last close is `lastClose`.
 */
export function historySeries({
  symbol,
  exchange,
  interval,
  startDate,
  endDate,
  lastClose,
  nowMs,
}) {
  const times = barTimes({ exchange, interval, startDate, endDate, nowMs })
  const closes = times.map((t, i) =>
    i === times.length - 1 ? lastClose : r05(lastClose * (1 + (unit(symbol, t, 'c') - 0.5) * 0.03)),
  )
  const derivative = F_AND_O.includes(exchange)
  return times.map((t, i) => {
    const close = closes[i]
    const open = i === 0 ? r05(close * (1 + (unit(symbol, t, 'o') - 0.5) * 0.004)) : closes[i - 1]
    return {
      timestamp: Math.floor(t / 1000),
      open,
      high: r05(Math.max(open, close) * (1 + unit(symbol, t, 'h') * 0.002)),
      low: r05(Math.min(open, close) * (1 - unit(symbol, t, 'l') * 0.002)),
      close,
      volume: 1000 + Math.floor(unit(symbol, t, 'v') * 50_000),
      oi: derivative ? 75 * (1000 + Math.floor(unit(symbol, t, 'i') * 100_000)) : 0,
    }
  })
}

/** The holidays of a year, as `market/holidays` answers them. */
export const holidaysOf = (year) =>
  MOCK_HOLIDAYS.filter((h) => h.date.startsWith(`${year}-`)).map((h) => structuredClone(h))

export { istDateOf }
