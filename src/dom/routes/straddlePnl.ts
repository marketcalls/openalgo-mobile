// The Straddle PnL routes, answered on the phone: POST /straddlepnl/api/simulate and GET
// /straddlepnl/api/lotsize (blueprints/custom_straddle.py:21-113 at c8b2896), a port of
// services/custom_straddle_service.py get_custom_straddle_simulation (:48-405).
// - The reference, strikes and option history as the Straddle Chart reads them (straddle.ts),
//   for the reference's last N dates only: the service simulates those and no other
//   (:197-204), so no older date is ever read.
// - Each day sells the ATM straddle at its first candle with both legs, rolls to the new ATM when
//   it is adjustment_points or more from the strike held (booking the old straddle's P&L), and
//   closes at the day's last candle. A candle missing a held leg keeps the last unrealized P&L.
//   The loop is the service's (:188-399) line for line: its additions in its order, Python's
//   round, and max and min that keep the first of equals.
// - The lot size is the master's first row LIKE the underlying with a lot; with no master stored,
//   a leg's of the nearest expiry's one-strike chain.
import { z } from 'zod'
import type { CustomStraddleResponse, PnLDataPoint, TradeEntry } from '@/api/custom-straddle'
import { toDdmmmyy } from '~/market/options/expiry'
import { pyRound } from '~/market/options/pyRound'
import { type RouteDeps, type RouteOptions, routeError } from './deps'
import { PyInt, ToolQuerySchema } from './query'
import { istDay } from './series'
import {
  type AtmData,
  atmHistories,
  daysToExpiry,
  referenceLtp,
  type StraddleCopy,
  seriesFields,
  straddleSetup,
} from './straddle'

const SIMULATE_COPY: StraddleCopy = {
  noPerpetual: (base) => `No perpetual futures found for ${base}`,
  unknown: 'Unknown',
  noHistory: 'No underlying history data',
  noAtm: 'Could not determine ATM strikes',
}
/** custom_straddle.py get_lotsize's refusal. */
const LOT_REQUIRED_COPY = 'underlying and exchange required'

/**
 * The simulation's body (custom_straddle.py:44-62): the tool query, the interval and days (1 when
 * none is sent), and int() of adjustment_points (50), lot_size (65) and lots (1); then, after the
 * required fields, adjustment_points must be 1 or more, and so must lot_size and lots.
 */
export const SimulateQuery = ToolQuerySchema.and(
  z
    .object({
      ...seriesFields(1),
      adjustment_points: PyInt.default(50),
      lot_size: PyInt.default(65),
      lots: PyInt.default(1),
    })
    .superRefine((q, ctx) => {
      if (q.adjustment_points < 1) {
        ctx.addIssue({ code: 'custom', message: 'adjustment_points must be >= 1' })
      } else if (q.lot_size < 1 || q.lots < 1) {
        ctx.addIssue({ code: 'custom', message: 'lot_size and lots must be >= 1' })
      }
    }),
)

export type SimulateQueryOut = z.output<typeof SimulateQuery>

type Candle = AtmData['candles'][number]

/**
 * Python's max() and min() of a non-empty list: each keeps the first of equal values, 0 and -0
 * among them (min([0.0, -0.0]) is 0.0 where Math.min(0, -0) is -0).
 */
// biome-ignore lint/complexity/useMathMinMax: Math.max ranks 0 above -0; Python keeps the first
const firstMax = (xs: readonly number[]) => xs.reduce((best, x) => (x > best ? x : best))
// biome-ignore lint/complexity/useMathMinMax: Math.min ranks -0 below 0; Python keeps the first
const firstMin = (xs: readonly number[]) => xs.reduce((best, x) => (x < best ? x : best))

/** The simulation loop (:188-368): the P&L series, the trade log and the summary's figures. */
function simulate(a: AtmData, days: number, adjustmentPoints: number, quantity: number) {
  const close = (strike: number | null, side: 'ce' | 'pe', sec: number) =>
    strike === null ? undefined : a.legs.get(strike)?.[side].get(sec)

  // daily_candles: the candles of each IST date, in time order
  const daily = new Map<string, Candle[]>()
  for (const c of a.candles) {
    const day = istDay(c.sec)
    const list = daily.get(day)
    if (list) list.push(c)
    else daily.set(day, [c])
  }

  let cumulativeRealized = 0
  let totalAdjustments = 0
  const pnlSeries: PnLDataPoint[] = []
  const trades: TradeEntry[] = []

  const tradingDays = [...daily.keys()].sort().slice(-Math.max(1, days))
  for (const day of tradingDays) {
    const candles = daily.get(day) ?? []
    let entryStrike: number | null = null
    let entryCe = 0
    let entryPe = 0
    let dayRealized = 0
    let dayAdjustments = 0
    let lastUnrealized = 0

    for (const [i, c] of candles.entries()) {
      const spot = c.close
      const atm = c.atm
      if (atm === null || !a.legs.has(atm)) continue
      const isLast = i === candles.length - 1

      if (entryStrike === null) {
        // ENTRY: the first candle of the day with both ATM legs
        const ce = close(atm, 'ce', c.sec)
        const pe = close(atm, 'pe', c.sec)
        if (ce === undefined || pe === undefined) continue
        entryStrike = atm
        entryCe = ce
        entryPe = pe
        trades.push({
          time: c.sec,
          type: 'ENTRY',
          strike: atm,
          ce_price: pyRound(ce, 2),
          pe_price: pyRound(pe, 2),
          straddle: pyRound(ce + pe, 2),
          spot: pyRound(spot, 2),
          leg_pnl: 0,
          cumulative_pnl: pyRound(cumulativeRealized, 2),
        })
      } else if (Math.abs(atm - entryStrike) >= adjustmentPoints) {
        // ADJUSTMENT: book the held straddle, sell the new ATM one
        const oldCe = close(entryStrike, 'ce', c.sec)
        const oldPe = close(entryStrike, 'pe', c.sec)
        const newCe = close(atm, 'ce', c.sec)
        const newPe = close(atm, 'pe', c.sec)
        if (
          oldCe !== undefined &&
          oldPe !== undefined &&
          newCe !== undefined &&
          newPe !== undefined
        ) {
          const legPnl = (entryCe - oldCe + (entryPe - oldPe)) * quantity
          dayRealized += legPnl
          dayAdjustments += 1
          trades.push({
            time: c.sec,
            type: 'ADJUSTMENT',
            old_strike: entryStrike,
            strike: atm,
            exit_ce: pyRound(oldCe, 2),
            exit_pe: pyRound(oldPe, 2),
            exit_straddle: pyRound(oldCe + oldPe, 2),
            ce_price: pyRound(newCe, 2),
            pe_price: pyRound(newPe, 2),
            straddle: pyRound(newCe + newPe, 2),
            spot: pyRound(spot, 2),
            leg_pnl: pyRound(legPnl, 2),
            cumulative_pnl: pyRound(cumulativeRealized + dayRealized, 2),
          })
          entryStrike = atm
          entryCe = newCe
          entryPe = newPe
        }
      }

      // the held straddle's P&L now, else the last one known
      const curCe = close(entryStrike, 'ce', c.sec)
      const curPe = close(entryStrike, 'pe', c.sec)
      let unrealized: number
      if (curCe !== undefined && curPe !== undefined) {
        unrealized = (entryCe - curCe + (entryPe - curPe)) * quantity
        lastUnrealized = unrealized
      } else {
        unrealized = lastUnrealized
      }
      const totalPnl = cumulativeRealized + dayRealized + unrealized

      // the ATM straddle for display: a missing leg is 0, and the synthetic then the spot
      const atmCe = close(atm, 'ce', c.sec) ?? 0
      const atmPe = close(atm, 'pe', c.sec) ?? 0
      const syntheticFuture = atmCe && atmPe ? pyRound(atm + atmCe - atmPe, 2) : pyRound(spot, 2)
      pnlSeries.push({
        time: c.sec,
        pnl: pyRound(totalPnl, 2),
        spot: pyRound(spot, 2),
        atm_strike: atm,
        entry_strike: entryStrike,
        ce_price: pyRound(atmCe, 2),
        pe_price: pyRound(atmPe, 2),
        straddle: pyRound(atmCe + atmPe, 2),
        synthetic_future: syntheticFuture,
        adjustments: totalAdjustments + dayAdjustments,
      })

      // EXIT at the day's last candle
      if (isLast) {
        const exitCe = close(entryStrike, 'ce', c.sec)
        const exitPe = close(entryStrike, 'pe', c.sec)
        const legPnl =
          exitCe !== undefined && exitPe !== undefined
            ? (entryCe - exitCe + (entryPe - exitPe)) * quantity
            : lastUnrealized
        trades.push({
          time: c.sec,
          type: 'EXIT',
          strike: entryStrike,
          ce_price: pyRound(exitCe ?? 0, 2),
          pe_price: pyRound(exitPe ?? 0, 2),
          straddle: pyRound((exitCe ?? 0) + (exitPe ?? 0), 2),
          spot: pyRound(spot, 2),
          leg_pnl: pyRound(legPnl, 2),
          cumulative_pnl: pyRound(cumulativeRealized + dayRealized + legPnl, 2),
        })
      }
    }

    // the day settles at its last candle, held legs or not
    const last = candles[candles.length - 1]
    if (entryStrike !== null && last) {
      const finalCe = close(entryStrike, 'ce', last.sec)
      const finalPe = close(entryStrike, 'pe', last.sec)
      const finalLeg =
        finalCe !== undefined && finalPe !== undefined
          ? (entryCe - finalCe + (entryPe - finalPe)) * quantity
          : lastUnrealized
      cumulativeRealized += dayRealized + finalLeg
    }
    totalAdjustments += dayAdjustments
  }
  return { pnlSeries, trades, cumulativeRealized, totalAdjustments }
}

export async function straddleSimulate(
  q: SimulateQueryOut,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<CustomStraddleResponse> {
  const setup = await straddleSetup(q, d, SIMULATE_COPY, o)
  // the last N reference dates are all it simulates: never an older one
  const data = await atmHistories(
    { ...setup, interval: q.interval, days: q.days, copy: SIMULATE_COPY, signal: o.signal },
    d,
    () => false,
  )
  const quantity = q.lot_size * q.lots
  const run = simulate(data, q.days, q.adjustment_points, quantity)
  if (run.pnlSeries.length === 0) {
    throw routeError(404, 'No simulation data (option history may be missing)')
  }
  const underlyingLtp = await referenceLtp(setup.ref, d, o)
  const pnlValues = run.pnlSeries.map((p) => p.pnl)
  return {
    status: 'success',
    data: {
      underlying: setup.base,
      underlying_ltp: underlyingLtp,
      expiry_date: setup.ddmmmyy,
      interval: q.interval,
      days_to_expiry: daysToExpiry(setup.ddmmmyy, d.now()),
      adjustment_points: q.adjustment_points,
      lot_size: q.lot_size,
      lots: q.lots,
      quantity,
      pnl_series: run.pnlSeries,
      trades: run.trades,
      summary: {
        total_pnl: pyRound(run.cumulativeRealized, 2),
        total_adjustments: run.totalAdjustments,
        max_pnl: pyRound(firstMax(pnlValues), 2),
        min_pnl: pyRound(firstMin(pnlValues), 2),
      },
    },
  }
}

/**
 * get_lotsize (custom_straddle.py:83-113): `underlying` and `exchange` trimmed and upper-cased,
 * both required; the lot of the master's first row whose symbol starts with the underlying, null
 * when none has one. With no master stored, the first leg's lot of the nearest expiry's one-strike
 * chain, null when no expiry is listed or no leg has a lot.
 */
export async function lotSize(
  underlying: string,
  exchange: string,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<{ status: 'success'; lotsize: number | null }> {
  const u = underlying.trim().toUpperCase()
  const ex = exchange.trim().toUpperCase()
  if (!u || !ex) throw routeError(400, LOT_REQUIRED_COPY)
  const listed = await d.master.lotSizeLike(ex, u)
  if (listed !== undefined) return { status: 'success', lotsize: listed }

  const [nearest] = await d.options.expiries(ex, u, 'options')
  const code = nearest === undefined ? null : toDdmmmyy(nearest)
  if (code === null) return { status: 'success', lotsize: null }
  const chain = await d.options.chain(
    { underlying: u, exchange: ex, expiry_date: code, strike_count: 1 },
    { signal: o.signal },
  )
  const legs = chain.chain.flatMap((r) => [r.ce, r.pe])
  const lot = legs.find((leg) => leg !== null && leg.lotsize > 0)?.lotsize ?? null
  return { status: 'success', lotsize: lot }
}
