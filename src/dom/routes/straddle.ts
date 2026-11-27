// The Straddle Chart route, answered on the phone: POST /straddle/api/straddle-data
// (blueprints/straddle_chart.py:20-66 at c8b2896), a port of services/straddle_chart_service.py
// get_straddle_chart_data (:104-357), and what it shares with Straddle PnL (straddlePnl.ts):
// - The reference is the underlying's spot on its quote exchange, a no-spot venue's near future
//   or CRYPTO's perpetual (resolveReference); the strikes are the master's calls for the expiry,
//   or, with no master stored, one 40-strike chain's.
// - Trim first (atmHistories): the server reads CE and PE over the whole trading window for every
//   ATM strike any reference candle has, merges, then keeps the last N dates. The phone reads them
//   for the ATM strikes of the reference's newest N dates only, and an older date's new strikes
//   only while the merge lacks a date. A candle's merge needs only its own ATM strike's history
//   (read over the same window), so the answer is the server's, for 2K reads where K is the ATM
//   strikes of the kept dates (the plan's request budget).
// - Each candle with both legs is a point: the straddle CE + PE and the synthetic future K + CE −
//   PE at its ATM strike K. days_to_expiry counts whole days to 15:30 IST of the expiry; the LTP
//   is the reference's quote (0 when it fails).
// - The page waits while the screen is hidden: no history read starts then (design 7.5).
import { z } from 'zod'
import type { StraddleChartResponse, StraddleDataPoint } from '@/api/straddle-chart'
import { ApiError } from '~/core/http/errors'
import { QuotesSchema } from '~/core/http/schemas'
import { fetchHistoryBatch, type HistoryRequest, type HistoryResult } from '~/market/history/batch'
import { expiryInstantMs, optionsExchangeOf } from '~/market/options/expiry'
import { pyRound } from '~/market/options/pyRound'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { PresentQuerySchema, PyInt, type ToolQuery } from './query'
import { quoteExchange, resolveReference } from './reference'
import {
  capLastNDates,
  closesByTime,
  istDay,
  nearestStrike,
  optionSymbol,
  tradingWindow,
  tsSeconds,
} from './series'

/** The days of candles the page may ask: it offers 1, 3 and 5. */
const MIN_DAYS = 1
const MAX_DAYS = 30
/** Strikes a side of the chain that lists them when no master is stored. */
const LADDER_STRIKES = 40
const DAY_MS = 86_400_000

/**
 * The series fields of both straddle bodies (straddle_chart.py:45-46, custom_straddle.py:47-48):
 * the interval trimmed, '1m' when none is sent, and days, int() of it, kept within 1..30. The
 * interval must be one the broker offers, which the services check against the screen's
 * /intervals read (offeredInterval).
 */
export const seriesFields = (defaultDays: number) => ({
  interval: z
    .string()
    .default('1m')
    .transform((s) => s.trim()),
  days: PyInt.default(defaultDays).transform((n) => Math.min(Math.max(n, MIN_DAYS), MAX_DAYS)),
})

/**
 * The chart's body: the three fields read for presence only (no pattern, so M&M and BAJAJ-AUTO
 * are charted), the interval and days (5 when none is sent).
 */
export const StraddleQuery = PresentQuerySchema.and(z.object(seriesFields(5)))

export type StraddleQueryOut = z.output<typeof StraddleQuery>

/** What tells the two services' refusals apart: Straddle PnL words some its own way. */
export type StraddleCopy = {
  noPerpetual: (base: string, exchange: string) => string
  /** `resp_u.get('message', …)`'s fallback. */
  unknown: string
  noHistory: string
  noAtm: string
}

const CHART_COPY: StraddleCopy = {
  noPerpetual: (base, exchange) => `No perpetual futures found for ${base} on ${exchange}`,
  unknown: 'Unknown error',
  noHistory: 'No underlying history data available',
  noAtm: 'Could not determine any ATM strikes',
}

const abortError = () =>
  Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })

/** An aborted page request rejects with an AbortError, so the router answers nothing. */
export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError()
}

/**
 * The interval as the broker offers it (its seconds, minutes and hours, which the page lists),
 * else the 400 the IV chart answers; the server's route would send it to the broker.
 */
async function offeredInterval(interval: string, d: RouteDeps): Promise<void> {
  const { seconds = [], minutes = [], hours = [] } = await d.intervals()
  const offered = [...seconds, ...minutes, ...hours]
  if (!offered.includes(interval)) {
    throw routeError(400, `Invalid interval. Allowed: ${offered.join(', ')}`)
  }
}

/**
 * get_available_strikes(base, expiry, 'CE', exchange): the master's call strikes, ascending; with
 * no master stored, those of one 40-strike chain that list a call.
 */
export async function strikeLadder(
  base: string,
  ddmmmyy: string,
  optionsExchange: string,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<number[]> {
  const listed = await d.master.strikes(optionsExchange, base, ddmmmyy, 'CE')
  if (listed !== null) return listed
  const chain = await d.options.chain(
    {
      underlying: base,
      exchange: optionsExchange,
      expiry_date: ddmmmyy,
      strike_count: LADDER_STRIKES,
    },
    { signal: o.signal },
  )
  const strikes = chain.chain.filter((r) => r.ce !== null).map((r) => r.strike)
  return [...new Set(strikes)].sort((a, b) => a - b)
}

export type StraddleSetup = {
  base: string
  /** DDMMMYY, upper-cased. */
  ddmmmyy: string
  optionsExchange: string
  ref: { symbol: string; exchange: string }
  ladder: number[]
}

/**
 * Both services' first steps, in their order (straddle_chart_service.py:137-186,
 * custom_straddle_service.py:71-113): the reference, then the strikes; a venue with no spot and
 * no future, or no strike listed, is the service's 404.
 */
export async function straddleSetup(
  q: ToolQuery & { interval: string },
  d: RouteDeps,
  copy: StraddleCopy,
  o: RouteOptions = {},
): Promise<StraddleSetup> {
  await offeredInterval(q.interval, d)
  const base = q.underlying.toUpperCase()
  const venue = q.exchange.toUpperCase()
  const ddmmmyy = q.expiry_date.toUpperCase()
  const optionsExchange = optionsExchangeOf(quoteExchange(base, venue))

  const ref = await resolveReference(base, venue, d)
  if (!ref) {
    throw routeError(
      404,
      venue === 'CRYPTO'
        ? copy.noPerpetual(base, q.exchange)
        : `No unexpired futures found for ${base} on ${venue}`,
    )
  }
  const ladder = await strikeLadder(base, ddmmmyy, optionsExchange, d, o)
  if (ladder.length === 0) {
    throw routeError(404, `No strikes found for ${base} ${q.expiry_date} on ${optionsExchange}`)
  }
  return { base, ddmmmyy, optionsExchange, ref, ladder }
}

/** What atmHistories reads: straddleSetup's answer, the page's interval and days, and the
 *  service's refusals; `signal` is the page's request. */
export type AtmAsk = {
  base: string
  ddmmmyy: string
  ref: { symbol: string; exchange: string }
  optionsExchange: string
  interval: string
  days: number
  ladder: readonly number[]
  copy: StraddleCopy
  signal?: AbortSignal
}

/** A reference candle in time order, with its ATM strike; the legs' closes by second, per strike. */
export type AtmData = {
  candles: { sec: number; close: number; atm: number | null }[]
  legs: Map<number, { ce: Map<number, number>; pe: Map<number, number> }>
}

const closesOf = (r: HistoryResult | undefined): Map<number, number> =>
  Array.isArray(r) ? closesByTime(r) : new Map()

/**
 * The reference's candles over tradingWindow(days) and the option history they need, trimmed
 * first: `candles` holds the reference's newest `days` IST dates, and `legs` the CE and PE of every
 * ATM strike those candles have, each read over the whole window in one batch. While `need` says
 * so and older dates remain, the next older date joins, with a batch of its new strikes only.
 *
 * The reference's refusals are the service's: a failed read 400 (its message, else
 * `copy.unknown`), no candle 404, no candle with an ATM strike 400, checked over the whole window
 * as the server does. An aborted page request rejects with an AbortError.
 */
export async function atmHistories(
  o: AtmAsk,
  d: RouteDeps,
  need: (a: AtmData) => boolean,
): Promise<AtmData> {
  const window = tradingWindow(o.days, d.now())
  const ask = (symbol: string, exchange: string): HistoryRequest => ({
    symbol,
    exchange,
    interval: o.interval,
    ...window,
  })
  const read = async (reqs: HistoryRequest[]) => {
    const out = await fetchHistoryBatch(d.api, reqs, {
      signal: o.signal,
      // a hidden screen starts no read until it is shown again
      gate: (s) => (d.active() ? Promise.resolve() : d.untilActive(s)),
    })
    throwIfAborted(o.signal)
    return out
  }

  const [ref] = await read([ask(o.ref.symbol, o.ref.exchange)])
  if (!Array.isArray(ref)) {
    const message = ref?.serverMessage ?? o.copy.unknown
    throw routeError(400, `Failed to fetch underlying history: ${message}`)
  }
  if (ref.length === 0) throw routeError(404, o.copy.noHistory)
  // the frame sorted by time (_convert_timestamp_to_ist), each candle's ATM (:215-222)
  const all = ref
    .map((r) => ({ sec: tsSeconds(r.timestamp), close: r.close }))
    .sort((a, b) => a.sec - b.sec)
    .map((c) => ({ ...c, atm: nearestStrike(c.close, o.ladder) }))
  if (!all.some((c) => c.atm !== null)) throw routeError(400, o.copy.noAtm)

  const newestFirst = [...new Set(all.map((c) => istDay(c.sec)))].sort().reverse()
  const data: AtmData = { candles: [], legs: new Map() }
  let taken = 0
  const take = async (n: number) => {
    const kept = new Set(newestFirst.slice(0, taken + n))
    taken = kept.size
    data.candles = all.filter((c) => kept.has(istDay(c.sec)))
    const strikes = [
      ...new Set(data.candles.flatMap((c) => (c.atm === null ? [] : [c.atm]))),
    ].filter((k) => !data.legs.has(k))
    strikes.sort((a, b) => a - b)
    const legs = await read(
      strikes.flatMap((k) => [
        ask(optionSymbol(o.base, o.ddmmmyy, k, 'CE'), o.optionsExchange),
        ask(optionSymbol(o.base, o.ddmmmyy, k, 'PE'), o.optionsExchange),
      ]),
    )
    // a failed or empty read is no candle, as the service's empty lookup (:263-279)
    strikes.forEach((k, i) => {
      data.legs.set(k, { ce: closesOf(legs[2 * i]), pe: closesOf(legs[2 * i + 1]) })
    })
  }
  await take(o.days)
  while (taken < newestFirst.length && need(data)) await take(1)
  return data
}

/** Step 7 (:281-313): a point for each candle whose ATM strike has both legs at its time. */
function straddleSeries(a: AtmData): StraddleDataPoint[] {
  const series: StraddleDataPoint[] = []
  for (const c of a.candles) {
    const leg = c.atm === null ? undefined : a.legs.get(c.atm)
    if (c.atm === null || !leg) continue
    const ce = leg.ce.get(c.sec)
    const pe = leg.pe.get(c.sec)
    if (ce === undefined || pe === undefined) continue
    series.push({
      time: c.sec,
      spot: pyRound(c.close, 2),
      atm_strike: c.atm,
      ce_price: pyRound(ce, 2),
      pe_price: pyRound(pe, 2),
      straddle: pyRound(ce + pe, 2),
      synthetic_future: pyRound(c.atm + ce - pe, 2),
    })
  }
  return series
}

const datesIn = (series: readonly { time: number }[]) =>
  new Set(series.map((p) => istDay(p.time))).size

/**
 * _calculate_days_to_expiry: whole days (timedelta.days, floored) from `nowMs` to 15:30 IST of the
 * expiry, whatever its exchange; 0 once it is past, or for a date strptime refuses.
 */
export function daysToExpiry(ddmmmyy: string, nowMs: number): number {
  // 15:30 IST: the equity cut-off, which expiryInstantMs gives NFO
  const close = expiryInstantMs(ddmmmyy, 'NFO')
  if (close === null) return 0
  return Math.max(0, Math.floor((close - nowMs) / DAY_MS))
}

/** The reference's LTP for display (:328-334): 0 when the quote fails. */
export async function referenceLtp(
  ref: { symbol: string; exchange: string },
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<number> {
  try {
    const q = await d.api.call(
      'quotes',
      { symbol: ref.symbol, exchange: ref.exchange },
      QuotesSchema,
      { signal: o.signal },
    )
    return q.ltp ?? 0
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    throwIfAborted(o.signal)
    return 0
  }
}

export async function straddleData(
  q: StraddleQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<StraddleChartResponse> {
  const setup = await straddleSetup(q, d, CHART_COPY, o)
  // the server's merge then trim: older dates join while the merge holds fewer than `days`
  const data = await atmHistories(
    { ...setup, interval: q.interval, days: q.days, copy: CHART_COPY, signal: o.signal },
    d,
    (a) => datesIn(straddleSeries(a)) < q.days,
  )
  const series = straddleSeries(data)
  if (series.length === 0) {
    throw routeError(404, 'No straddle data available (option history may be missing)')
  }
  const underlyingLtp = await referenceLtp(setup.ref, d, o)
  return {
    status: 'success',
    data: {
      underlying: setup.base,
      underlying_ltp: underlyingLtp,
      expiry_date: setup.ddmmmyy,
      interval: q.interval,
      days_to_expiry: daysToExpiry(setup.ddmmmyy, d.now()),
      series: capLastNDates(series, q.days),
    },
  }
}
