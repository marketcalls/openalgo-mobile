// The mock's option universe: the expiries, the strike ladder, Black-76 premiums and the
// optionchain body (plan 0.2.0 E, contract of services/option_chain_service.py at c8b2896).
// Everything is a pure function of the clock, so a test passes `nowMs` and a running mock
// uses Date.now().
import { hash32, r05, UNDERLYING } from './prices.mjs'

export const OPTION_UNDERLYINGS = {
  NIFTY: { exchange: 'NSE_INDEX', fo: 'NFO', step: 50, lot: 65 },
  BANKNIFTY: { exchange: 'NSE_INDEX', fo: 'NFO', step: 100, lot: 30 },
  SENSEX: { exchange: 'BSE_INDEX', fo: 'BFO', step: 100, lot: 20 },
}
// Exchange freeze quantities, as database/qty_freeze_db.py carries them.
const FREEZE = { NIFTY: 1800, BANKNIFTY: 900, SENSEX: 1000 }

export const STRIKES_EACH_SIDE = 40
const IST_MS = 19_800_000
const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS
const CUTOFF_MS = (15 * 60 + 30) * 60_000 // 15:30 IST, the expiry instant on NFO and BFO
const TUESDAY = 2
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const FORWARD_RATE = 0.065
const SIGMA_ATM = 0.12
const SIGMA_SMILE = 0.3

// A calendar date is held as the UTC midnight of that date: `day` below.
const istToday = (nowMs) => Math.floor((nowMs + IST_MS) / DAY_MS) * DAY_MS
const expiryMs = (day) => day + CUTOFF_MS - IST_MS
const pad = (n) => String(n).padStart(2, '0')
const label = (day) => {
  const d = new Date(day)
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${pad(d.getUTCFullYear() % 100)}`
}

function lastTuesday(year, month) {
  let day = Date.UTC(year, month + 1, 0)
  while (new Date(day).getUTCDay() !== TUESDAY) day -= DAY_MS
  return day
}

const monthOf = (nowMs) => {
  const d = new Date(istToday(nowMs))
  return [d.getUTCFullYear(), d.getUTCMonth()]
}

/** 'DD-MMM-YY' or 'DDMMMYY' to the expiry instant in epoch ms (15:30 IST), or null. */
export function expiryInstant(expiry) {
  const m = /^(\d{2})-?([A-Z]{3})-?(\d{2})$/.exec(String(expiry).toUpperCase())
  const month = m ? MONTHS.indexOf(m[2]) : -1
  return month < 0 ? null : expiryMs(Date.UTC(2000 + Number(m[3]), month, Number(m[1])))
}

/**
 * The option expiries listed at `nowMs`: the next three Tuesdays (one is gone once 15:30 IST
 * has passed) and the last Tuesday of next month, as the master holds them ('DD-MMM-YY').
 */
export function optionExpiries(nowMs) {
  const days = new Set()
  for (let day = istToday(nowMs); days.size < 3; day += DAY_MS) {
    if (new Date(day).getUTCDay() === TUESDAY && expiryMs(day) > nowMs) days.add(day)
  }
  const [y, m] = monthOf(nowMs)
  days.add(lastTuesday(y, m + 1))
  return [...days].sort((a, b) => a - b).map(label)
}

/** Future expiries: the last Tuesday of this month (else next) and the two after. */
export function futureExpiries(nowMs) {
  const [y, m] = monthOf(nowMs)
  const first = expiryMs(lastTuesday(y, m)) > nowMs ? m : m + 1
  return [0, 1, 2].map((i) => label(lastTuesday(y, first + i)))
}

// Abramowitz and Stegun 7.1.26: |error| < 1.5e-7.
function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-z * z)
  return 0.5 * (1 + (x < 0 ? -erf : erf))
}

/** Black-76 (no discounting) on a smile, σ = 0.12 + 0.3·ln(K/F)²; tick 0.05, at least 0.05. */
export function premium({ F, K, years, type }) {
  let value
  if (years <= 0) {
    value = type === 'CE' ? Math.max(0, F - K) : Math.max(0, K - F)
  } else {
    const sigma = SIGMA_ATM + SIGMA_SMILE * Math.log(K / F) ** 2
    const sd = sigma * Math.sqrt(years)
    const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd
    const d2 = d1 - sd
    value =
      type === 'CE'
        ? F * normalCdf(d1) - K * normalCdf(d2)
        : K * normalCdf(-d2) - F * normalCdf(-d1)
  }
  return Math.max(0.05, Number((Math.round(value * 20) / 20).toFixed(2)))
}

export const forward = (spot, years) => spot * (1 + FORWARD_RATE * Math.max(0, years))
export const yearsTo = (expiryTs, nowMs) => (expiryTs - nowMs) / YEAR_MS
const r2 = (x) => Math.round(x * 100) / 100
export const OPTION_SYMBOL = /^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/

/**
 * What the master and the price book know of a universe option symbol: whole-lot open interest
 * and volume from a hash of the symbol, and its Black-76 premium on `spot` at `nowMs`.
 * Undefined for anything that is not an option on an underlying of the universe.
 */
export function legFacts(symbol, spot, nowMs) {
  const m = OPTION_SYMBOL.exec(symbol)
  const u = m && OPTION_UNDERLYINGS[m[1]]
  const ts = m && expiryInstant(m[2])
  if (!u || ts === null) return undefined
  const years = yearsTo(ts, nowMs)
  return {
    lot: u.lot,
    oi: u.lot * (200 + (hash32(symbol) % 20_000)),
    volume: u.lot * (hash32(`${symbol}#volume`) % 3000),
    premium: premium({ F: forward(spot, years), K: Number(m[3]), years, type: m[4] }),
  }
}

const ladder = (name) => {
  const { step } = OPTION_UNDERLYINGS[name]
  const atm = Math.round(UNDERLYING[name] / step) * step
  return Array.from(
    { length: 2 * STRIKES_EACH_SIDE + 1 },
    (_, i) => atm + (i - STRIKES_EACH_SIDE) * step,
  )
}

/**
 * The master rows of the universe at `nowMs`: for each underlying, CE and PE at 81 strikes for
 * every option expiry, and the three futures. Fields as the instrument master holds them.
 */
export function universeRows(nowMs) {
  const rows = []
  Object.entries(OPTION_UNDERLYINGS).forEach(([name, u], n) => {
    // A token is the underlying, the expiry's day number and the leg: stable and unique.
    const tokenOf = (expiry, leg) =>
      String((n + 1) * 1_000_000_000 + Math.round(expiryInstant(expiry) / DAY_MS) * 1000 + leg)
    const row = (symbol, expiry, strike, type, leg, tick) => ({
      symbol,
      brsymbol: symbol,
      name,
      exchange: u.fo,
      brexchange: u.fo,
      token: tokenOf(expiry, leg),
      lotsize: u.lot,
      tick_size: tick,
      freeze_qty: FREEZE[name],
      instrumenttype: type,
      expiry,
      strike,
    })
    for (const expiry of optionExpiries(nowMs)) {
      const code = expiry.replaceAll('-', '')
      ladder(name).forEach((strike, i) => {
        for (const [k, type] of ['CE', 'PE'].entries()) {
          rows.push(row(`${name}${code}${strike}${type}`, expiry, strike, type, 2 * i + k, 0.05))
        }
      })
    }
    for (const expiry of futureExpiries(nowMs)) {
      rows.push(row(`${name}${expiry.replaceAll('-', '')}FUT`, expiry, 0, 'FUT', 999, 0.1))
    }
  })
  return rows
}

function unavailable(b, u) {
  const fo = String(b.exchange).toUpperCase()
  if (!u || ((fo === 'NFO' || fo === 'BFO') && fo !== u.fo)) {
    return `Option chain is not available for ${b.underlying} on ${b.exchange}`
  }
  return null
}

/**
 * The optionchain answer for a request body: `[status, body]`, the c8b2896 shape. Legs are
 * priced by Black-76 on the live underlying; from 2.0.2.0 the body carries the expiry instant
 * and server clock, and no Greeks (the app computes them).
 */
export function chainBody(b, { prices, version, nowMs }) {
  const name = String(b.underlying).toUpperCase()
  const u = OPTION_UNDERLYINGS[name]
  const failure = unavailable(b, u)
  if (failure) return [404, { status: 'error', message: failure }]
  const expiry = optionExpiries(nowMs).find((e) => e.replaceAll('-', '') === b.expiry_date)
  if (!expiry) {
    return [
      404,
      { status: 'error', message: `No option contracts found for ${name} expiry ${b.expiry_date}` },
    ]
  }
  // The quote identity is the index (option_chain_service.py:77-83), not the request's exchange.
  const und = prices.read(name, u.exchange)
  const expiryTs = expiryInstant(expiry)
  const years = yearsTo(expiryTs, nowMs)
  const prevForward = forward(und.close, years)
  const strikes = ladder(name)
  const atmIndex = Math.min(
    strikes.length - 1,
    Math.max(0, Math.round((und.ltp - strikes[0]) / u.step)),
  )
  const count = Number.isInteger(b.strike_count) ? Math.max(0, b.strike_count) : strikes.length
  const code = expiry.replaceAll('-', '')

  const leg = (index, type) => {
    const strike = strikes[index]
    const symbol = `${name}${code}${strike}${type}`
    const away = (type === 'CE' ? 1 : -1) * (index - atmIndex)
    const facts = legFacts(symbol, und.ltp, nowMs)
    const h = hash32(`${symbol}#day`)
    const ltp = facts.premium
    const prevClose = premium({ F: prevForward, K: strike, years, type })
    const open = r05(prevClose * (1 + ((h % 11) - 5) / 200))
    return {
      symbol,
      label: away === 0 ? 'ATM' : `${away < 0 ? 'ITM' : 'OTM'}${Math.abs(away)}`,
      ltp,
      bid: ltp > 0.05 ? r2(ltp - 0.05) : 0,
      ask: r2(ltp + 0.05),
      bid_qty: u.lot * (1 + (h % 40)),
      ask_qty: u.lot * (1 + ((h >>> 8) % 40)),
      open,
      high: r05(Math.max(open, ltp, prevClose) * 1.03),
      low: r05(Math.min(open, ltp, prevClose) * 0.97),
      prev_close: prevClose,
      volume: facts.volume,
      oi: facts.oi,
      lotsize: u.lot,
      tick_size: 0.05,
    }
  }
  const chain = []
  const from = Math.max(0, atmIndex - count)
  const to = Math.min(strikes.length, atmIndex + count + 1)
  for (let i = from; i < to; i++) {
    chain.push({ strike: strikes[i], ce: leg(i, 'CE'), pe: leg(i, 'PE') })
  }
  const out = {
    status: 'success',
    underlying: name,
    underlying_ltp: und.ltp,
    underlying_prev_close: und.close,
    expiry_date: b.expiry_date,
    atm_strike: strikes[atmIndex],
    chain,
  }
  if (version.withGreeks) {
    // S10: 2.0.2.0 adds these. The mock computes no Greeks, so greeks_included stays false.
    Object.assign(out, {
      underlying_symbol: name,
      underlying_exchange: u.exchange,
      expiry_ts: expiryTs / 1000,
      server_ts: Math.floor(nowMs / 1000),
      quotes_included: true,
      greeks_included: false,
      forward_price: null,
    })
  }
  return [200, out]
}

export { instrumentsCsv } from './instruments.mjs'
