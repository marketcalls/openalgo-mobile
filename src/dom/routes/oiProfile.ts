// The OI Profile route, answered on the phone: POST /oiprofile/api/profile-data
// (blueprints/oiprofile.py:28-96 at c8b2896), a port of services/oi_profile_service.py
// get_oi_profile_data (:247-430) over /api/v1, in its order:
// 1. One 20-strike chain: each strike's current OI and the lot size (the first leg's, else 1).
//    Every leg with OI gets a daily read.
// 2. The future: the same-expiry FUT when the /expiry futures list has one, else the first
//    (CRYPTO: the perpetual), as _find_futures_symbol (:71-130) finds it; any failure there is no
//    future. Its candles at the page's interval over the trading window, cut to `days` dates.
// 3. Previous-day OI (_fetch_daily_oi_changes :134-244): each leg's daily candles over the last
//    14 IST days, data[-2]'s OI, through the history lane. A failed read counts as 0, as the
//    server's; a 429 is not loaded (the server retries it, the phone reads it on Refresh). A leg
//    cached for the day the future's candles say is the legs' data[-2] (prevOi.ts) is not read.
// 4. The answer comes when every leg is in, or OI_FIRST_ANSWER_MS after the daily reads start:
//    the change then shows for the legs loaded, with a note. The reads go on under the screen's
//    lifetime into the cache, so a Refresh after a full load costs 2 calls (RF 3). A hidden screen
//    starts none (design 7.5), and they stop after OI_BACKGROUND_MS of the screen shown. A load
//    while an earlier one's reads are out shares them in the scheduler (one read per body), and
//    the progress line follows the latest load.
import { z } from 'zod'
import type { CandleData, OIProfileChainItem, OIProfileDataResponse } from '@/api/oi-profile'
import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import { istDate } from '~/core/realtime/marketHours'
import type { HistoryRow } from '~/market/chart/schemas'
import { fetchHistoryBatch, type HistoryResult, lastCompletedDay } from '~/market/history/batch'
import { oiDayKey } from '~/market/history/prevOi'
import { optionsExchangeOf, toDdmmmyy } from '~/market/options/expiry'
import type { OptionChain } from '~/market/options/schemas'
import type { RouteDeps, RouteOptions } from './deps'
import { PyInt, ToolQuerySchema } from './query'
import { resolveReference } from './reference'
import { capLastNDates, tradingWindow, tsSeconds } from './series'

/** How long the page waits for the previous-day OI before it gets what has loaded. */
export const OI_FIRST_ANSWER_MS = 8_000
/** How long the daily reads may go on, counting only the time the screen is shown. */
export const OI_BACKGROUND_MS = 180_000

export const oiPartialNote = (loaded: number, requested: number) =>
  `Previous-day OI is still loading: the change shows for ${loaded} of ${requested} contracts. Tap Refresh when the bar above says it has loaded.`

const TAG = 'oiprofile'
const PROGRESS_LABEL = 'Previous-day OI'
/** oiprofile.py ALLOWED_INTERVALS, and its refusal, which lists them sorted. */
const INTERVALS: readonly string[] = ['1m', '5m', '15m']
const INTERVAL_COPY = `Invalid interval. Allowed: ${[...INTERVALS].sort().join(', ')}`
const DEFAULT_DAYS = 5
const MAX_DAYS = 30
const CHAIN_STRIKES = 20
/** The daily reads' window: today and the 14 IST days before it (:159-160). */
const DAILY_LOOKBACK_DAYS = 14
const DAY_MS = 86_400_000
/** How often the background's budget looks at whether the screen is shown. */
const TICK_MS = 1_000

/**
 * The route's body (oiprofile.py:47-75): the tool query; the interval trimmed and cut to 5
 * (5m when none is sent), one of 1m, 5m and 15m; days, int() of it (5 when none is sent), at
 * most 30. A value its `.strip()` or int() raises on is the route's 500.
 */
export const OiProfileQuery = ToolQuerySchema.and(
  z
    .object({
      interval: z
        .string()
        .default('5m')
        .transform((s) => s.trim().slice(0, 5)),
      days: PyInt.default(DEFAULT_DAYS).transform((n) => Math.min(n, MAX_DAYS)),
    })
    .superRefine((q, ctx) => {
      if (!INTERVALS.includes(q.interval)) ctx.addIssue({ code: 'custom', message: INTERVAL_COPY })
    }),
)

export type OiProfileQueryOut = z.output<typeof OiProfileQuery>

/** A leg's previous-day OI, or null when it is not loaded: cut short, or refused with a 429. */
type Outcome = number | null

/** The load of each tool screen's lifetime that reports progress: its latest. */
const reporters = new WeakMap<AbortSignal, object>()

const abortError = () =>
  Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })

/** Resolves after `ms`; rejects when `signal` aborts, and the timer goes with it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolves once the screen has been shown for `ms` in all, looked at each second. */
async function shownFor(ms: number, d: RouteDeps, signal: AbortSignal): Promise<void> {
  let left = ms
  while (left > 0) {
    if (!d.active()) await d.untilActive(signal)
    const step = Math.min(TICK_MS, left)
    await sleep(step, signal)
    if (d.active()) left -= step
  }
}

/**
 * Settles with `work`, or after `ms` (never for Infinity), whichever is first; rejects when the
 * page's request aborts.
 */
function firstOf(work: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = (then: () => void) => () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      then()
    }
    const onAbort = end(() => reject(abortError()))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (Number.isFinite(ms)) timer = setTimeout(end(resolve), ms)
    work.then(end(resolve), end(resolve))
  })
}

/** The chain's rows as the service reads them, and the legs to read, with their symbols. */
function currentOi(chain: OptionChain) {
  let lot = 0
  const symbols: string[] = []
  const rows = chain.chain.map((row) => {
    const side = (leg: OptionChain['chain'][number]['ce']) => {
      const oi = leg?.oi ?? 0
      if (!lot && leg?.lotsize) lot = leg.lotsize
      if (leg?.symbol && oi > 0) symbols.push(leg.symbol)
      return { oi, symbol: leg?.symbol || null }
    }
    return { strike: row.strike, ce: side(row.ce), pe: side(row.pe) }
  })
  return { rows, symbols: [...new Set(symbols)], lot: lot || 1 }
}

/** The future the candles are of, or null where the service finds none. */
async function futureOf(
  base: string,
  exchange: string,
  expiry: string,
  d: RouteDeps,
): Promise<{ symbol: string; exchange: string } | null> {
  try {
    if (exchange === 'CRYPTO') return await resolveReference(base, exchange, d)
    const listed = await d.options.expiries(exchange, base, 'futures')
    const pick = listed.find((e) => toDdmmmyy(e) === expiry) ?? listed[0]
    const code = pick === undefined ? null : toDdmmmyy(pick)
    return code === null ? null : { symbol: `${base}${code}FUT`, exchange }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    log.warn(TAG, `no future found for ${base} on ${exchange}`, e.kind)
    return null
  }
}

type Candle = HistoryRow & { time: number }

/** The future's candles with their `time` in seconds, uncut; none when the read fails. */
async function futureCandles(
  future: { symbol: string; exchange: string },
  q: OiProfileQueryOut,
  d: RouteDeps,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const window = tradingWindow(q.days, d.now())
  const [rows] = await fetchHistoryBatch(
    d.api,
    [{ symbol: future.symbol, exchange: future.exchange, interval: q.interval, ...window }],
    { signal },
  )
  if (signal?.aborted) throw abortError()
  return Array.isArray(rows) ? rows.map((r) => ({ ...r, time: tsSeconds(r.timestamp) })) : []
}

/** What a leg's daily read comes to: data[-2]'s OI (0 with fewer rows, or when it failed). */
function outcomeOf(r: HistoryResult, batch: AbortSignal): Outcome {
  if (Array.isArray(r)) return r.length >= 2 ? (r[r.length - 2]?.oi ?? 0) : 0
  return batch.aborted || r.kind === 'RateLimited' ? null : 0
}

/**
 * Reads the daily candles of `symbols` in one batch, under the screen's lifetime: each leg's
 * outcome goes to `onLoaded` when it is loaded, and to the cache when it has a data[-2]. Settles
 * when every read has.
 */
async function readDaily(
  symbols: readonly string[],
  exchange: string,
  d: RouteDeps,
  lifetime: AbortSignal,
  onLoaded: (symbol: string, prevOi: number) => void,
): Promise<void> {
  const batch = new AbortController()
  const stop = () => batch.abort()
  if (lifetime.aborted) stop()
  else lifetime.addEventListener('abort', stop, { once: true })
  // the background's budget counts the time the screen is shown only
  void shownFor(OI_BACKGROUND_MS, d, batch.signal).then(stop, () => {})

  const today = istDate(d.now())
  const start = new Date(Date.parse(`${today}T00:00:00Z`) - DAILY_LOOKBACK_DAYS * DAY_MS)
  const window = { start_date: start.toISOString().slice(0, 10), end_date: today }
  try {
    await fetchHistoryBatch(
      d.api,
      symbols.map((symbol) => ({ symbol, exchange, interval: 'D', ...window })),
      {
        signal: batch.signal,
        // a hidden screen starts no read until it is shown again
        gate: (s) => (d.active() ? Promise.resolve() : d.untilActive(s)),
        onSettle: (i, r) => {
          const symbol = symbols[i] as string
          const o = outcomeOf(r, batch.signal)
          if (o === null) return
          const day = Array.isArray(r) ? lastCompletedDay(r) : null
          if (day !== null) {
            d.prevOi
              .put(exchange, [{ symbol, day, prevOi: o }])
              .catch((e: unknown) => log.warn(TAG, 'could not cache the previous-day OI', e))
          }
          onLoaded(symbol, o)
        },
      },
    )
  } catch (e) {
    log.warn(TAG, 'the previous-day OI reads failed', e)
  } finally {
    lifetime.removeEventListener('abort', stop)
    stop()
  }
}

/**
 * Every leg's previous-day OI the answer can show, from the cache or read, as far as the reads
 * have come when every leg is in or `firstAnswerMs` has passed. The progress line counts the legs
 * loaded of those asked, while this is the screen's latest load and its lifetime lasts.
 */
async function previousDayOi(
  symbols: readonly string[],
  exchange: string,
  day: string | null,
  d: RouteDeps,
  lifetime: AbortSignal,
  o: { firstAnswerMs: number; signal?: AbortSignal },
): Promise<ReadonlyMap<string, number>> {
  const loaded = new Map<string, number>()
  const unread: string[] = []
  for (const symbol of symbols) {
    const hit = day === null ? null : await d.prevOi.get(exchange, symbol, day).catch(() => null)
    if (hit === null) unread.push(symbol)
    else loaded.set(symbol, hit)
  }
  if (unread.length === 0) return loaded

  const me = {}
  reporters.set(lifetime, me)
  const report = () => {
    if (!lifetime.aborted && reporters.get(lifetime) === me) {
      d.progress({ label: PROGRESS_LABEL, done: loaded.size, total: symbols.length })
    }
  }
  report()
  const reads = readDaily(unread, exchange, d, lifetime, (symbol, prevOi) => {
    loaded.set(symbol, prevOi)
    report()
  })
  await firstOf(reads, o.firstAnswerMs, o.signal)
  return new Map(loaded)
}

export async function oiProfile(
  q: OiProfileQueryOut,
  d: RouteDeps,
  o: RouteOptions & { firstAnswerMs?: number } = {},
): Promise<OIProfileDataResponse> {
  // this load's: the screen's next load gets a new one
  const lifetime = d.lifetime
  const exchange = optionsExchangeOf(q.exchange)
  const chain = await d.options.chain(
    {
      underlying: q.underlying,
      exchange: q.exchange,
      expiry_date: q.expiry_date,
      strike_count: CHAIN_STRIKES,
    },
    { signal: o.signal },
  )
  const { rows, symbols, lot } = currentOi(chain)

  const future = await futureOf(q.underlying, exchange, q.expiry_date, d)
  const candles = future ? await futureCandles(future, q, d, o.signal) : []

  const previous = await previousDayOi(symbols, exchange, oiDayKey(candles), d, lifetime, {
    firstAnswerMs: o.firstAnswerMs ?? OI_FIRST_ANSWER_MS,
    signal: o.signal,
  })
  const change = (leg: { oi: number; symbol: string | null }) => {
    const before = leg.symbol === null ? undefined : previous.get(leg.symbol)
    return before === undefined ? 0 : leg.oi - before
  }
  const oiChain: OIProfileChainItem[] = rows.map(({ strike, ce, pe }) => ({
    strike,
    ce_oi: ce.oi,
    pe_oi: pe.oi,
    ce_oi_change: change(ce),
    pe_oi_change: change(pe),
  }))

  const reply: OIProfileDataResponse & { oi_change_loaded?: number; oi_change_requested?: number } =
    {
      status: 'success',
      underlying: chain.underlying,
      spot_price: chain.underlying_ltp,
      atm_strike: chain.atm_strike,
      lot_size: lot,
      expiry_date: q.expiry_date,
      futures_symbol: future?.symbol ?? null,
      interval: q.interval,
      // the broker's candles as they came, each with its time added (:365-378)
      candles: capLastNDates(candles, q.days) as CandleData[],
      oi_chain: oiChain,
    }
  if (previous.size < symbols.length) {
    reply.message = oiPartialNote(previous.size, symbols.length)
    reply.oi_change_loaded = previous.size
    reply.oi_change_requested = symbols.length
  }
  return reply
}
