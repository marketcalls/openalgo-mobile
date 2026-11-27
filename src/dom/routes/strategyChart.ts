// The Strategy Builder's two chart tabs, answered on the phone: POST
// /strategybuilder/api/strategy-chart and /multi-strike-oi (blueprints/strategy_chart.py:32-179 at
// c8b2896), ports of services/strategy_chart_service.py get_strategy_chart_data (:204-449) and
// multi_strike_oi_service.py get_multi_strike_oi_data (:32-239):
// - The legs that count are the active OPTION legs with a symbol, BUY or SELL and an exchange
//   (_normalize_leg): a future's price level is not a premium.
// - The reference is the chain's own pair when the page sends one (2.0.2.0), else the index on
//   its index exchange, a stock on NSE or BSE, a no-spot venue's near future or CRYPTO's
//   perpetual (resolveReference, RF 4).
// - One history batch reads the reference, then each (symbol, exchange) once, in leg order, over
//   the trading window or the explicit one a chart paging back asks for. A failed or empty
//   reference read charts the legs alone (underlying_available false).
// - The series keep the last `days` IST dates, except for an explicit window.
// - The page waits while the screen is hidden: no history read starts then (design 7.5).
import { z } from 'zod'
import type {
  MultiStrikeOIData,
  MultiStrikeOILeg,
  OIPoint,
  StrategyChartPoint,
  StrategyChartResponse,
} from '@/api/strategy-chart'
import { isRecord } from '~/core/http/errors'
import { istDate } from '~/core/realtime/marketHours'
import type { JSONValue } from '~/dom/bridge/protocol'
import type { HistoryRow } from '~/market/chart/schemas'
import { fetchHistoryBatch, type HistoryRequest, type HistoryResult } from '~/market/history/batch'
import { pyRound, pySum } from '~/market/options/pyRound'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { FAILED_COPY, PAIR_REQUIRED_COPY, PyInt } from './query'
import { resolveReference } from './reference'
import { capLastNDates, closesByTime, tradingWindow, tsSeconds } from './series'
import { referenceLtp, throwIfAborted } from './straddle'

/** strategy_chart.py MAX_DAYS. */
const MAX_DAYS = 30
const DEFAULT_DAYS = 3
const DEFAULT_INTERVAL = '5m'
/** The phone's bounds on a body, which the server does not set: every leg is a history read. */
const MAX_LEGS = 30
const MAX_SYMBOL = 64
/** strategy_chart_service.py MAX_WINDOW_DAYS and EARLIEST_START. */
const MAX_WINDOW_DAYS = 400
const EARLIEST_START = '2000-01-01'
const DAY_MS = 86_400_000

const LEGS_COPY = 'At least one leg is required'
const TOO_MANY_LEGS_COPY = `A strategy cannot have more than ${MAX_LEGS} legs`
const SYMBOL_COPY = `A leg's symbol cannot be longer than ${MAX_SYMBOL} characters`
const NO_LEGS_COPY = 'No active option legs provided'
const NO_OVERLAP_COPY =
  'No overlapping history across legs — option data may be unavailable for the selected range'

/** A value Python's `v or fallback` replaces: None, False, 0, '', [] and {}. */
const pyFalsy = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === false ||
  v === 0 ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isRecord(v) && Object.keys(v).length === 0)

/**
 * `(data.get(name) or fallback).strip()`: a falsy value reads as `fallback`; any other value that
 * is not a string is what `.strip()` raises on (the route's 500).
 */
const orText = (fallback = '') =>
  z.preprocess((v) => (pyFalsy(v) ? fallback : v), z.string()).transform((s) => s.trim())

/** A leg as the page posts it, each field as sent: _normalize_leg reads it (preflight F 23). */
const Leg = z.object({
  symbol: z.unknown().optional(),
  exchange: z.unknown().optional(),
  side: z.unknown().optional(),
  segment: z.unknown().optional(),
  active: z.unknown().optional(),
  price: z.unknown().optional(),
  strike: z.unknown().optional(),
  optionType: z.unknown().optional(),
  expiry: z.unknown().optional(),
})

type LegIn = z.output<typeof Leg>

/**
 * Both charts' body, as strategy_chart.py:57-87 (and :132-162) reads it: underlying and exchange
 * trimmed and both required; underlying_symbol, underlying_exchange, start_date and end_date
 * trimmed, absent when blank; the interval '5m' when none is sent; days int() of it (3 for what
 * int() refuses) kept within 1..30; and a non-empty list of legs, each an object or nothing
 * (_normalize_leg drops what is not a dict). The phone also refuses more than 30 legs and a
 * symbol over 64 characters.
 */
export const StrategyChartQuery = z
  .object({
    underlying: orText(),
    exchange: orText(),
    underlying_symbol: orText(),
    underlying_exchange: orText(),
    interval: orText(DEFAULT_INTERVAL),
    days: PyInt.catch(DEFAULT_DAYS).transform((n) => Math.min(Math.max(n, 1), MAX_DAYS)),
    start_date: orText(),
    end_date: orText(),
    legs: z.unknown().optional(),
  })
  .transform((b, ctx) => {
    const refuse = (message: string) => {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    if (!b.underlying || !b.exchange) return refuse(PAIR_REQUIRED_COPY)
    const listed = pyFalsy(b.legs) ? [] : b.legs
    if (!Array.isArray(listed) || listed.length === 0) return refuse(LEGS_COPY)
    if (listed.length > MAX_LEGS) return refuse(TOO_MANY_LEGS_COPY)
    // an object always reads: every field is unknown
    const legs = listed.map((v): LegIn | null => (isRecord(v) ? Leg.parse(v) : null))
    const long = (l: LegIn | null) =>
      typeof l?.symbol === 'string' && l.symbol.trim().length > MAX_SYMBOL
    if (legs.some(long)) return refuse(SYMBOL_COPY)
    return {
      underlying: b.underlying,
      exchange: b.exchange,
      underlying_symbol: b.underlying_symbol || undefined,
      underlying_exchange: b.underlying_exchange || undefined,
      interval: b.interval,
      days: b.days,
      start_date: b.start_date || undefined,
      end_date: b.end_date || undefined,
      legs,
    }
  })

export type StrategyChartQueryOut = z.output<typeof StrategyChartQuery>

/** strptime's %Y-%m-%d (CPython _strptime): four year digits, a month and a day of one or two. */
const YMD = /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])$/

/** _parse_ymd: the date, YYYY-MM-DD, or the 400 for one strptime or date() refuses. */
function parseYmd(value: string, field: string): string {
  const m = YMD.exec(value)
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  // date() refuses year 0 and a day the month does not have (31 Nov rolls over here)
  if (!m || year < 1 || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw routeError(400, `${field} must be a date in YYYY-MM-DD form`)
  }
  return d.toISOString().slice(0, 10)
}

/**
 * _resolve_explicit_window: null without a start (an end alone is no window); else the start and
 * the end (today in IST when none is sent), each strptime's YYYY-MM-DD, from 2000-01-01, the end
 * not before the start and at most 400 days after it. A refused window is the service's 400.
 */
export function explicitWindow(
  start: string | undefined,
  end: string | undefined,
  nowMs: number,
): { start_date: string; end_date: string } | null {
  if (!start) return null
  const from = parseYmd(start, 'start_date')
  const to = end ? parseYmd(end, 'end_date') : istDate(nowMs)
  if (from < EARLIEST_START) {
    throw routeError(400, `start_date cannot be earlier than ${EARLIEST_START}`)
  }
  if (to < from) throw routeError(400, 'end_date cannot be earlier than start_date')
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  )
  if (days > MAX_WINDOW_DAYS) {
    throw routeError(400, `the window cannot be wider than ${MAX_WINDOW_DAYS} days`)
  }
  return { start_date: from, end_date: to }
}

/** `(v or "")`, or the service's 500 where `.strip()` or `.upper()` raises (not a string). */
function legText(v: unknown): string {
  if (pyFalsy(v)) return ''
  if (typeof v === 'string') return v
  throw routeError(500, FAILED_COPY)
}

/** What Python's float() reads of a string, short of underscores and the words. */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** `float(v or 0)`, 0.0 for what float() refuses. */
function legPrice(v: unknown): number {
  if (typeof v === 'number') return v
  if (v === true) return 1
  if (typeof v !== 'string') return 0
  const t = v.trim()
  return FLOAT.test(t) ? Number(t) : 0
}

type StrategyLeg = {
  symbol: string
  exchange: string
  side: 'BUY' | 'SELL'
  /** SELL +1 (a credit), BUY −1. */
  sign: 1 | -1
  entryPrice: number
}

const isSide = (s: string): s is StrategyLeg['side'] => s === 'BUY' || s === 'SELL'

/**
 * _normalize_leg, read in its order: nothing for an inactive leg (active false only), a segment
 * other than OPTION (the default), or a leg without a symbol, BUY or SELL and an exchange.
 */
function normalizeLeg(leg: LegIn | null): StrategyLeg | null {
  if (leg === null || leg.active === false) return null
  const segment = (legText(leg.segment) || 'OPTION').toUpperCase()
  if (segment !== 'OPTION') return null
  const symbol = legText(leg.symbol).trim()
  const side = legText(leg.side).toUpperCase()
  const exchange = legText(leg.exchange).trim().toUpperCase()
  if (!symbol || !isSide(side) || !exchange) return null
  return { symbol, exchange, side, sign: side === 'SELL' ? 1 : -1, entryPrice: legPrice(leg.price) }
}

const keyOf = (l: { symbol: string; exchange: string }) => `${l.symbol}\u0000${l.exchange}`

/** A history read's candles, as the service's frame holds them: by time, empty when it failed. */
const sortedRows = (r: HistoryResult | undefined): HistoryRow[] =>
  Array.isArray(r) ? [...r].sort((a, b) => tsSeconds(a.timestamp) - tsSeconds(b.timestamp)) : []

type StrategyReads = {
  base: string
  explicit: boolean
  /** The page's legs, each normalized or null, in its order. */
  normalized: (StrategyLeg | null)[]
  legs: StrategyLeg[]
  ref: { symbol: string; exchange: string }
  /** The reference's candles by time; null when its read failed or had none. */
  refRows: HistoryRow[] | null
  /** Each contract's candles by time, by keyOf. */
  legRows: Map<string, HistoryRow[]>
}

/**
 * Both services' first steps, in their order: the window, the legs (none left is the 400), the
 * reference (none is the 404), then one history batch for it and the legs' contracts.
 */
async function readStrategy(
  q: StrategyChartQueryOut,
  d: RouteDeps,
  o: RouteOptions,
): Promise<StrategyReads> {
  const nowMs = d.now()
  const explicit = explicitWindow(q.start_date, q.end_date, nowMs)
  const window = explicit ?? tradingWindow(q.days, nowMs)
  const base = q.underlying.toUpperCase()
  const normalized = q.legs.map(normalizeLeg)
  const legs = normalized.filter((l) => l !== null)
  if (legs.length === 0) throw routeError(400, NO_LEGS_COPY)

  const ref = await resolveReference(base, q.exchange, d, {
    symbol: q.underlying_symbol,
    exchange: q.underlying_exchange,
  })
  if (!ref) {
    throw routeError(404, `No unexpired futures found for ${base} on ${q.exchange.toUpperCase()}`)
  }

  const contracts = [...new Map(legs.map((l) => [keyOf(l), l])).values()]
  const ask = (c: { symbol: string; exchange: string }): HistoryRequest => ({
    symbol: c.symbol,
    exchange: c.exchange,
    interval: q.interval,
    ...window,
  })
  const [refRead, ...legReads] = await fetchHistoryBatch(d.api, [ref, ...contracts].map(ask), {
    signal: o.signal,
    // a hidden screen starts no read until it is shown again
    gate: (s) => (d.active() ? Promise.resolve() : d.untilActive(s)),
  })
  throwIfAborted(o.signal)
  const refRows = sortedRows(refRead)
  return {
    base,
    explicit: explicit !== null,
    normalized,
    legs,
    ref,
    refRows: refRows.length > 0 ? refRows : null,
    legRows: new Map(contracts.map((c, i) => [keyOf(c), sortedRows(legReads[i])])),
  }
}

/** `sorted(set.intersection(*ts_sets))`: the times every contract has a close at, ascending. */
function commonTimes(closes: readonly Map<number, number>[]): number[] {
  const [first, ...rest] = closes
  if (!first) return []
  return [...first.keys()].filter((t) => rest.every((c) => c.has(t))).sort((a, b) => a - b)
}

/**
 * get_strategy_chart_data: a point for each reference candle (without one, each time every
 * contract has, ascending) at which every leg has a close: the signed premiums added in leg
 * order (SELL +, BUY −), and its absolute value. The entry premium is sum() of the legs' signed
 * prices, which tags the strategy.
 */
export async function strategyChart(
  q: StrategyChartQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<StrategyChartResponse> {
  const s = await readStrategy(q, d, o)
  const closes = new Map([...s.legRows].map(([k, rows]) => [k, closesByTime(rows)]))
  const times: { sec: number; spot: number | null }[] = s.refRows
    ? s.refRows.map((r) => ({ sec: tsSeconds(r.timestamp), spot: r.close }))
    : commonTimes([...closes.values()]).map((sec) => ({ sec, spot: null }))

  const series: StrategyChartPoint[] = []
  for (const { sec, spot } of times) {
    let signed = 0
    let every = true
    for (const leg of s.legs) {
      const price = closes.get(keyOf(leg))?.get(sec)
      if (price === undefined) {
        every = false
        break
      }
      signed += leg.sign * price
    }
    if (!every) continue
    series.push({
      time: sec,
      net_premium: pyRound(signed, 2),
      combined_premium: pyRound(Math.abs(signed), 2),
      ...(spot === null ? {} : { underlying: pyRound(spot, 2) }),
    })
  }
  if (series.length === 0) throw routeError(404, NO_OVERLAP_COPY)

  const entryNet = pySum(s.legs.map((l) => l.sign * l.entryPrice))
  const underlyingLtp = await referenceLtp(s.ref, d, o)
  return {
    status: 'success',
    data: {
      underlying: s.base,
      underlying_ltp: underlyingLtp,
      interval: q.interval,
      tag: entryNet > 0 ? 'credit' : entryNet < 0 ? 'debit' : 'flat',
      entry_net_premium: pyRound(entryNet, 2),
      entry_abs_premium: pyRound(Math.abs(entryNet), 2),
      legs_used: s.legs.length,
      underlying_available: s.refRows !== null,
      series: s.explicit ? series : capLastNDates(series, q.days),
    },
  }
}

/** A leg of the multi-strike reply: the page's strike, optionType and expiry as it sent them,
 *  null for one it did not send (`raw.get`). */
export type MultiStrikeLeg = Omit<MultiStrikeOILeg, 'strike' | 'option_type' | 'expiry'> & {
  strike: JSONValue
  option_type: JSONValue
  expiry: JSONValue
}

export type MultiStrikeReply = {
  status: 'success'
  data: Omit<MultiStrikeOIData, 'legs'> & { legs: MultiStrikeLeg[] }
}

/** A field the page sent, as JSON; null when it sent none. */
const sent = (v: unknown): JSONValue => (v === undefined ? null : (v as JSONValue))

/**
 * get_multi_strike_oi_data: the reference's closes, and each leg's OI by candle (0 where the
 * broker gives none), the legs in the page's order. has_oi says whether any OI is above 0 over
 * the whole window, before the series keep their last `days` dates (preflight F conflict 23).
 */
export async function multiStrikeOi(
  q: StrategyChartQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<MultiStrikeReply> {
  const s = await readStrategy(q, d, o)
  const cap = <T extends { time: number }>(rows: T[]) =>
    s.explicit ? rows : capLastNDates(rows, q.days)
  const underlyingSeries: OIPoint[] = (s.refRows ?? []).map((r) => ({
    time: tsSeconds(r.timestamp),
    value: pyRound(r.close, 2),
  }))
  const oi = new Map(
    [...s.legRows].map(([k, rows]) => [
      k,
      rows.map((r) => ({ time: tsSeconds(r.timestamp), value: pyRound(r.oi ?? 0, 2) })),
    ]),
  )
  const legs: MultiStrikeLeg[] = []
  q.legs.forEach((raw, i) => {
    const leg = s.normalized[i]
    if (!raw || !leg) return
    const series = oi.get(keyOf(leg)) ?? []
    legs.push({
      symbol: leg.symbol,
      exchange: leg.exchange,
      side: leg.side,
      strike: sent(raw.strike),
      option_type: sent(raw.optionType),
      expiry: sent(raw.expiry),
      has_oi: series.some((p) => p.value > 0),
      series: cap(series),
    })
  })
  const underlyingLtp = await referenceLtp(s.ref, d, o)
  return {
    status: 'success',
    data: {
      underlying: s.base,
      underlying_ltp: underlyingLtp,
      interval: q.interval,
      underlying_available: s.refRows !== null,
      underlying_series: cap(underlyingSeries),
      legs,
    },
  }
}
