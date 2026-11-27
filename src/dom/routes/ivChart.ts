// The Option Greeks route (the IV chart), answered on the phone: POST /ivchart/api/iv-data
// (blueprints/ivchart.py:20-66 at c8b2896), a port of services/iv_chart_service.py
// get_iv_chart_data (:137-382) and _calculate_iv_series (:385-475).
// - The ATM legs and the underlying's LTP come from a 1-strike chain. The server quotes the
//   underlying and finds the ATM in its master instead; the two agree at one instant (the
//   harness serves the quote from the same chain, preflight F conflict 6).
// - The reference charted is the chain's own pair (2.0.2.0), else resolveReference: an index on
//   its index exchange, a no-spot venue's near future, CRYPTO's perpetual (RF 4).
// - One history batch of three: the reference, the CE and the PE, at the page's interval over
//   the trading window. Each leg is joined to the reference on their common candle times.
// - Per candle, at t years from the candle to the expiry cut-off (the server's floor of 1e-4; 0
//   from the cut-off on), the IV inverts the option's close at F = the reference's close (r = 0),
//   and the Greeks are priced at it, both as opengreeks does (rawIvAny, rawGreeks).
import { z } from 'zod'
import type { IVChartResponse, IVDataPoint, IVSeries } from '@/api/iv-chart'
import { ApiError } from '~/core/http/errors'
import type { HistoryRow } from '~/market/chart/schemas'
import { fetchHistoryBatch } from '~/market/history/batch'
import { rawGreeks, rawIvAny } from '~/market/options/black76'
import type { Flag } from '~/market/options/engine'
import { expiryInstantMs, optionsExchangeOf, serverYears } from '~/market/options/expiry'
import { pyRound } from '~/market/options/pyRound'
import type { ChainLeg } from '~/market/options/schemas'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { EXPIRY_COPY, PyInt, ToolQuerySchema } from './query'
import { quoteExchange, resolveReference } from './reference'
import { capLastNDates, closesByTime, optionSymbol, tradingWindow } from './series'

/** The days of candles the page may ask: the page offers 1 to 15. */
const MIN_DAYS = 1
const MAX_DAYS = 30
/** One strike a side: the ATM row is all the route reads of the chain. */
const ATM_ONLY = 1

/**
 * The route's body (ivchart.py:42-46): the tool query, the interval (5m when none is sent) and
 * days, int() of it (1 when none is sent), kept within 1..30. The interval must be one the broker
 * offers, which ivChart checks against the screen's /intervals read.
 */
export const IvChartQuery = ToolQuerySchema.and(
  z.object({
    interval: z
      .string()
      .default('5m')
      .transform((s) => s.trim()),
    days: PyInt.default(MIN_DAYS).transform((n) => Math.min(Math.max(n, MIN_DAYS), MAX_DAYS)),
  }),
)

export type IvChartQueryOut = z.output<typeof IvChartQuery>

const abortError = () =>
  Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })

/**
 * _calculate_iv_series: one point per time both series have, ascending. An option close or a
 * reference close at or under 0, or no time left, gives no IV; a solved σ (its floor, 1e-6,
 * included) gives the four Greeks.
 */
function ivSeries(
  option: readonly HistoryRow[],
  reference: ReadonlyMap<number, number>,
  o: { strike: number; expiryMs: number; flag: Flag },
): IVDataPoint[] {
  const points: IVDataPoint[] = []
  for (const [sec, price] of closesByTime(option)) {
    const F = reference.get(sec)
    if (F === undefined) continue
    const ms = sec * 1000
    // calculate_time_to_expiry_at: nothing left once the candle is at the cut-off or past it
    const t = o.expiryMs > ms ? serverYears(o.expiryMs, ms).years : 0
    const sigma = t > 0 && price > 0 && F > 0 ? rawIvAny(price, F, o.strike, 0, t, o.flag) : null
    const g = sigma === null ? null : rawGreeks(o.flag, F, o.strike, t, 0, sigma)
    points.push({
      time: sec,
      iv: sigma === null ? null : pyRound(sigma * 100, 2),
      delta: g ? pyRound(g.delta, 4) : null,
      gamma: g ? pyRound(g.gamma, 6) : null,
      theta: g ? pyRound(g.theta, 4) : null,
      vega: g ? pyRound(g.vega, 4) : null,
      option_price: price,
      underlying_price: F,
    })
  }
  return points
}

export async function ivChart(
  q: IvChartQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<IVChartResponse> {
  const { seconds = [], minutes = [], hours = [] } = await d.intervals()
  const offered = [...seconds, ...minutes, ...hours]
  if (!offered.includes(q.interval)) {
    throw routeError(400, `Invalid interval. Allowed: ${offered.join(', ')}`)
  }

  const base = q.underlying.toUpperCase()
  const venue = q.exchange.toUpperCase()
  const expiry = q.expiry_date.toUpperCase()
  const optionsExchange = optionsExchangeOf(quoteExchange(base, venue))

  const chain = await d.options.chain(
    { underlying: base, exchange: q.exchange, expiry_date: expiry, strike_count: ATM_ONLY },
    { signal: o.signal },
  )
  const ltp = chain.underlying_ltp
  if (!ltp) throw routeError(400, 'Could not get underlying LTP')
  const atm = chain.atm_strike
  const row = chain.chain.find((r) => r.strike === atm)
  if (!row) {
    throw routeError(404, `No strikes found for ${base} ${expiry} on ${optionsExchange}`)
  }
  const symbolOf = (leg: ChainLeg | null, type: 'CE' | 'PE') =>
    leg?.symbol || optionSymbol(base, expiry, atm, type)
  const ceSymbol = symbolOf(row.ce, 'CE')
  const peSymbol = symbolOf(row.pe, 'PE')
  // parse_option_symbol's expiry: the day at the options exchange's cut-off
  const expiryMs = expiryInstantMs(expiry, optionsExchange)
  if (expiryMs === null) throw routeError(400, EXPIRY_COPY)

  const reference = await resolveReference(base, venue, d, {
    symbol: chain.underlying_symbol,
    exchange: chain.underlying_exchange,
  })
  if (!reference) {
    throw routeError(
      404,
      venue === 'CRYPTO'
        ? `No perpetual futures found for ${base} on ${q.exchange}`
        : `No unexpired futures found for ${base} on ${venue}`,
    )
  }

  const window = tradingWindow(q.days, d.now())
  const ask = (symbol: string, exchange: string) => ({
    symbol,
    exchange,
    interval: q.interval,
    ...window,
  })
  const [ref, ce, pe] = await fetchHistoryBatch(
    d.api,
    [
      ask(reference.symbol, reference.exchange),
      ask(ceSymbol, optionsExchange),
      ask(peSymbol, optionsExchange),
    ],
    { signal: o.signal },
  )
  if (o.signal?.aborted) throw abortError()
  if (ref instanceof ApiError || ref === undefined) {
    const message = ref?.serverMessage ?? 'Unknown error'
    throw routeError(400, `Failed to fetch underlying history: ${message}`)
  }
  if (ref.length === 0) throw routeError(404, 'No underlying history data available for today')

  const closes = closesByTime(ref)
  const series: IVSeries[] = []
  const legs = [
    [ceSymbol, 'CE', ce],
    [peSymbol, 'PE', pe],
  ] as const
  for (const [symbol, type, rows] of legs) {
    // a failed or empty read leaves the leg out (:311-346)
    if (!Array.isArray(rows) || rows.length === 0) continue
    const points = ivSeries(rows, closes, {
      strike: atm,
      expiryMs,
      flag: type === 'CE' ? 'c' : 'p',
    })
    series.push({
      symbol,
      option_type: type,
      strike: atm,
      iv_data: capLastNDates(points, q.days),
    })
  }
  if (series.length === 0) throw routeError(404, 'No option history data available for today')

  return {
    status: 'success',
    data: {
      underlying: base,
      underlying_ltp: ltp,
      atm_strike: atm,
      ce_symbol: ceSymbol,
      pe_symbol: peSymbol,
      interval: q.interval,
      series,
    },
  }
}
