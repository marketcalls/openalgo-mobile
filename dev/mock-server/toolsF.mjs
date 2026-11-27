// The mock's side of plan F (0.2.0 M5): the futures universe beyond the index options, leg
// history with open interest for any master symbol, and the answer to a basket order. Pure
// functions of the clock and the request, so a test passes `nowMs` and a running mock uses
// Date.now().
import { istDateOf } from './chart.mjs'
import {
  expiryInstant,
  forward,
  futureExpiries,
  OPTION_SYMBOL,
  OPTION_UNDERLYINGS,
  premium,
  yearsTo,
} from './options.mjs'
import { hash32, r05, UNDERLYING } from './prices.mjs'

/** The underlyings that have futures, by exchange: three monthly FUT each (futureExpiries). */
export const FUTURES_UNIVERSE = Object.freeze({
  NFO: Object.freeze(['NIFTY', 'BANKNIFTY', 'RELIANCE', 'INFY', 'SBIN']),
  MCX: Object.freeze(['CRUDEOIL', 'GOLD']),
})

// Lot sizes of the other underlyings; the index options' lots come from OPTION_UNDERLYINGS. Read
// at call time: this module may load while options.mjs is still being evaluated.
const OTHER_LOTS = { RELIANCE: 500, INFY: 400, SBIN: 750, CRUDEOIL: 100, GOLD: 1 }
const lotOf = (name) => OPTION_UNDERLYINGS[name]?.lot ?? OTHER_LOTS[name] ?? 1

const IST_MS = 19_800_000
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const OPEN_MS = (9 * 60 + 15) * MINUTE_MS
const LAST_MINUTE_MS = (15 * 60 + 29) * MINUTE_MS
const MAX_ROWS = 2000
const FUT_SYMBOL = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})FUT$/
const STEP_MIN = { '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60 }

/**
 * The master rows of the futures universe at `nowMs` that options.mjs does not already list:
 * NIFTY and BANKNIFTY futures are in the option universe, so they are merged, not repeated.
 */
export function futuresRows(nowMs) {
  const rows = []
  Object.entries(FUTURES_UNIVERSE).forEach(([exchange, names], x) => {
    names.forEach((name, n) => {
      if (OPTION_UNDERLYINGS[name]) return
      for (const expiry of futureExpiries(nowMs)) {
        const day = Math.round(expiryInstant(expiry) / DAY_MS)
        rows.push({
          symbol: `${name}${expiry.replaceAll('-', '')}FUT`,
          brsymbol: `${name}${expiry.replaceAll('-', '')}FUT`,
          name,
          exchange,
          brexchange: exchange,
          // Above every token options.mjs hands out, unique per name and expiry.
          token: String((10 + x * 10 + n) * 1_000_000_000 + day * 1000 + 999),
          lotsize: lotOf(name),
          tick_size: exchange === 'MCX' ? 1 : 0.05,
          freeze_qty: 0,
          instrumenttype: 'FUT',
          expiry,
          strike: 0,
        })
      }
    })
  })
  return rows
}

// --- Leg history -------------------------------------------------------------------------

const unit = (key) => hash32(key) / 4294967296
// Value noise in [-1, 1]: smooth in x, a pure function of the key.
function noise(key, x) {
  const i = Math.floor(x)
  const f = x - i
  const w = f * f * (3 - 2 * f)
  const a = unit(`${key}:${i}`)
  const b = unit(`${key}:${i + 1}`)
  return (a + (b - a) * w) * 2 - 1
}

const baseSpot = (name) => UNDERLYING[name] ?? 100 + (hash32(`${name}#base`) % 4900)

/** A deterministic walk of an underlying: continuous in time and equal for every leg on it. */
const spotAt = (name, tMs) =>
  baseSpot(name) *
  (1 +
    0.015 * noise(`${name}#d`, tMs / DAY_MS) +
    0.004 * noise(`${name}#h`, tMs / (2 * 3_600_000)) +
    0.0008 * noise(`${name}#m`, tMs / (5 * MINUTE_MS)))

/** What a master symbol is for pricing: its underlying, and how its price follows the spot. */
function describe(symbol) {
  const opt = OPTION_SYMBOL.exec(symbol)
  if (opt && OPTION_UNDERLYINGS[opt[1]]) {
    const ts = expiryInstant(opt[2])
    const lot = OPTION_UNDERLYINGS[opt[1]].lot
    const price = (t) =>
      premium({
        F: forward(spotAt(opt[1], t), yearsTo(ts, t)),
        K: Number(opt[3]),
        years: yearsTo(ts, t),
        type: opt[4],
      })
    return { lot, price, derivative: true }
  }
  const fut = FUT_SYMBOL.exec(symbol)
  const ts = fut && expiryInstant(fut[2])
  if (fut && ts !== null) {
    return {
      lot: lotOf(fut[1]),
      price: (t) => r05(forward(spotAt(fut[1], t), yearsTo(ts, t))),
      derivative: true,
    }
  }
  return { lot: 1, price: (t) => r05(spotAt(symbol, t)), derivative: false }
}

const istMidnight = (dateIst) => Date.parse(`${dateIst}T00:00:00Z`) - IST_MS
const isWeekday = (dateIst) => ![0, 6].includes(new Date(`${dateIst}T00:00:00Z`).getUTCDay())
function addDays(dateIst, n) {
  return istDateOf(istMidnight(dateIst) + n * DAY_MS + IST_MS)
}

/** Whether `legHistory` serves this request: an option or future, on an interval it can build. */
export function servesLegHistory({ symbol, interval }) {
  return (
    (interval === 'D' || interval in STEP_MIN) &&
    (OPTION_SYMBOL.test(symbol) || FUT_SYMBOL.test(symbol))
  )
}

/**
 * OHLCV and open interest rows, ascending, as `history` answers them, for any master symbol.
 * Minute candles run 09:15 to 15:29 IST on weekdays in [start_date, end_date] and stop at
 * `nowMs`; 'D' is one row per weekday, today's from 09:15 IST. Option closes are `premium()` on
 * a deterministic spot walk of the underlying. `oi` is whole lots from a hash of symbol and
 * date (0 for a symbol that is not a derivative). At most the newest 2,000 rows.
 */
export function legHistory(body, { nowMs }) {
  const { symbol, interval } = body
  const leg = describe(symbol)
  const stepMs = (STEP_MIN[interval] ?? 0) * MINUTE_MS
  const today = istDateOf(nowMs)
  const last = [body.end_date, today].sort()[0]
  const rows = []
  for (let d = body.start_date; d <= last && rows.length <= MAX_ROWS * 4; d = addDays(d, 1)) {
    if (!isWeekday(d)) continue
    const midnight = istMidnight(d)
    const oi = leg.derivative ? leg.lot * (200 + (hash32(`${symbol}#${d}`) % 20_000)) : 0
    const row = (t, open, close, span) => ({
      timestamp: Math.floor(t / 1000),
      open,
      high: r05(Math.max(open, close) * (1 + unit(`${symbol}:${t}:h`) * span)),
      low: r05(Math.min(open, close) * (1 - unit(`${symbol}:${t}:l`) * span)),
      close,
      volume: leg.lot * (1 + (hash32(`${symbol}:${t}:v`) % 2000)),
      oi,
    })
    if (interval === 'D') {
      if (midnight + OPEN_MS > nowMs) continue
      const close = leg.price(Math.min(nowMs, midnight + LAST_MINUTE_MS))
      rows.push(row(midnight, leg.price(midnight + OPEN_MS), close, 0.01))
      continue
    }
    for (let t = midnight + OPEN_MS; t + stepMs - MINUTE_MS <= midnight + LAST_MINUTE_MS; ) {
      if (t > nowMs) break
      rows.push(row(t, leg.price(t), leg.price(t + stepMs), 0.002))
      t += stepMs
    }
  }
  return rows.slice(-MAX_ROWS)
}

// --- Baskets -----------------------------------------------------------------------------

/**
 * The answer to a loaded basketorder body. The legs are placed SELL first (the server sends BUY
 * first and its threads finish in any order, so a client must not rely on the order of results).
 * `place(leg)` books one leg and answers its order id, or `{ error }`. `failSymbol` answers
 * "Insufficient funds" for that leg only. In semi-auto the basket is queued whole, as the router
 * queues any order, with `pendingId`.
 * @returns {[number, object]} the status and the body
 */
export function basketReply(body, { analyze, semiAuto, failSymbol, place, pendingId }) {
  if (semiAuto) {
    return [
      200,
      {
        status: 'success',
        message: 'Order queued for approval in Action Center',
        mode: 'semi_auto',
        pending_order_id: pendingId,
      },
    ]
  }
  const legs = body.orders
  const sorted = [
    ...legs.filter((l) => l.action.toUpperCase() === 'SELL'),
    ...legs.filter((l) => l.action.toUpperCase() !== 'SELL'),
  ]
  const results = sorted.map((leg) => {
    if (leg.symbol === failSymbol) {
      return { symbol: leg.symbol, status: 'error', message: 'Insufficient funds' }
    }
    const placed = place(leg)
    if (placed.error) return { symbol: leg.symbol, status: 'error', message: placed.error }
    return {
      symbol: leg.symbol,
      exchange: leg.exchange,
      product: leg.product,
      status: 'success',
      orderid: placed.orderid,
    }
  })
  return [200, { ...(analyze ? { mode: 'analyze' } : {}), status: 'success', results }]
}
