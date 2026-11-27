// Plan F's golden recordings (design 9.2): what record-fixtures adds to each case for the ten
// session routes plan F answers on the phone (Strike Profile through the Arbitrage universe),
// and the one rule a superset recording answers a read by (preflight 5a). The harness
// (scripts/golden/harness.py, Recording.chain and Recording.history) serves the server's Python
// by the same rule, and golden.test.mjs checks the two on one fixture.
import {
  chainCall,
  expiryCalls,
  historyCall,
  quotesCall,
  requestKey,
  stableJson,
} from './golden-keys.mjs'

/** What the harness asks each route for, as the pages send it (plan F T2). */
export const F_PARAMS = Object.freeze({
  interval: '5m',
  straddleInterval: '1m',
  ranges: Object.freeze([5, null]),
  profileExpiries: 6,
  surfaceExpiries: 4,
  surfaceStrikes: 40,
  days: Object.freeze({ ivchart: 1, oiprofile: 5, straddle: 3, straddlepnl: 1, strategy: 3 }),
})

/** strike_profile_service.py DEFAULT_STRIKE_COUNT (its probe, and OI Profile's chain) and MAX. */
const PROBE = 20
const MAX_STRIKES = 40
/** oi_profile_service.py:159-160: the daily reads run 14 days back to today. */
const DAILY_DAYS = 14
const IST_MS = 19_800_000
const DAY_MS = 86_400_000
/** The underlyings quoted on an index exchange (iv_chart_service.py:41-53, and its siblings). */
const NSE_INDEX = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'NIFTYIT',
  'NIFTYPHARMA',
  'NIFTYBANK',
])
const BSE_INDEX = new Set(['SENSEX', 'BANKEX', 'SENSEX50'])
/** option_symbol_service.py NO_SPOT_EXCHANGES: the near-month future is the reference. */
const NO_SPOT = new Set(['MCX', 'CDS', 'BCD', 'NCDEX', 'NCO'])
/** What option_chain_service._attach_chain_greeks adds to a leg. */
const GREEKS = ['implied_volatility', 'delta', 'gamma', 'theta', 'vega']
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** option_greeks_service.py EXCHANGE_EXPIRY_TIMES (IST); every other exchange 15:30. */
const CUTOFF = new Map([
  ['MCX', [23, 30]],
  ['CDS', [12, 30]],
])

/** A read the recording has no reply for: gen-golden refuses the case rather than bake a 500. */
export class NotRecorded extends Error {}

const compact = (d) => d.replaceAll('-', '')
const dashed = (e) => `${e.slice(0, 2)}-${e.slice(2, 5)}-${e.slice(5)}`
const byCharCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** The IST calendar date (YYYY-MM-DD) of an instant in epoch ms. */
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10)
const addDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
/** A history row's IST date: its timestamp in seconds, or in ms when over 1e12. */
const rowDate = (row) => {
  const t = row?.timestamp
  return isNumber(t) ? istDate(t > 1e12 ? t : t * 1000) : null
}

/** A DD-MMM-YY expiry at an IST wall time, epoch ms; null when it is not such a date. */
function expiryAt(expiry, hour, minute) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(String(expiry).trim().toUpperCase())
  const month = m ? MONTHS.indexOf(m[2]) : -1
  if (!m || month < 0) return null
  return Date.UTC(2000 + Number(m[3]), month, Number(m[1]), hour, minute) - IST_MS
}

/** A DD-MMM-YY expiry's instant on `exchange` (get_expiry_datetime), epoch ms, or null. */
function expiryInstantMs(expiry, exchange) {
  const [hour, minute] = CUTOFF.get(exchange) ?? [15, 30]
  return expiryAt(expiry, hour, minute)
}

/** A DD-MMM-YY expiry as YYYY-MM-DD (datetime.strptime(e, '%d-%b-%y').date()), or null. */
function expiryDay(expiry) {
  const at = expiryAt(expiry, 0, 0)
  return at === null ? null : istDate(at)
}

/** _resolve_trading_window (strategy_chart_service.py:42-57): max(2, 3·days + 2) days to today. */
export function tradingWindow(days, nowMs) {
  const today = istDate(nowMs)
  return { start_date: addDays(today, -Math.max(2, days * 3 + 2)), end_date: today }
}

/**
 * _strike_count_for_window (strike_profile_service.py:192-206): the strikes a side the probe
 * chain needs to cover spot ± rangePct, 5..40; every strike (40) for no range, the probe's 20
 * when the chain has no step.
 */
export function wantedStrikes(chain, spot, rangePct) {
  if (!rangePct) return MAX_STRIKES
  const strikes = [...new Set((chain?.chain ?? []).map((row) => row.strike))].sort((a, b) => a - b)
  if (strikes.length < 2) return PROBE
  let step = 0
  for (let i = 1; i < strikes.length; i++) {
    const d = strikes[i] - strikes[i - 1]
    if (d > 0 && (step === 0 || d < step)) step = d
  }
  if (step <= 0) return PROBE
  const needed = Math.ceil((spot * rangePct) / 100 / step) + 1
  return Math.max(5, Math.min(needed, MAX_STRIKES))
}

/** find_atm_strike_from_actual: the strike nearest `ltp`, the first of two equally near. */
function nearestStrike(ltp, strikes) {
  if (!isNumber(ltp)) return null
  let best = null
  for (const k of strikes) if (best === null || Math.abs(k - ltp) < Math.abs(best - ltp)) best = k
  return best
}

/** construct_option_symbol: a whole strike without its '.0'. */
const optionSymbol = (base, expiry, strike, type) => `${base}${expiry}${String(strike)}${type}`

/** The ATM row's two legs' symbols, or none. */
function atmSymbols(chain) {
  const row = (chain?.chain ?? []).find((r) => r.strike === chain.atm_strike)
  return [row?.ce?.symbol, row?.pe?.symbol].filter(Boolean)
}

// --- The superset rule (preflight 5a) --------------------------------------------------

function recordedBodies(input, endpoint) {
  const prefix = `${endpoint} `
  return Object.entries(input.responses)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, reply]) => ({ body: JSON.parse(key.slice(prefix.length)), reply }))
}

const chainBase = ({ strike_count: _n, with_greeks: _g, ...rest }) => stableJson(rest)

/**
 * The chain reply for `ask` (an optionchain body): the recorded chain of the same expiry (and
 * underlying and exchange) with the same with_greeks and the smallest strike_count ≥ the asked,
 * else the other kind with the smallest such count; its rows cut to strike_count each side of
 * its own atm_strike by index (get_strikes_with_labels, option_chain_service.py:111-116), the
 * Greeks taken out when they were not asked for, and `server_ts` the case instant. A with_greeks
 * ask answered by a chain without them is left without (the phone computes them; the harness
 * attaches the server's own). NotRecorded when no recorded chain is wide enough.
 */
export function servedChain(input, ask) {
  const n = ask.strike_count
  const greeks = ask.with_greeks === true
  const want = chainBase(ask)
  let same = null
  let other = null
  if (isNumber(n)) {
    for (const { body, reply } of recordedBodies(input, 'optionchain')) {
      const count = body.strike_count
      if (chainBase(body) !== want || !isNumber(count) || count < n) continue
      if ((body.with_greeks === true) === greeks) {
        if (!same || count < same.count) same = { count, reply }
      } else if (!other || count < other.count) other = { count, reply }
    }
  }
  const source = same ?? other
  if (!source) throw new NotRecorded(`no recorded reply for optionchain ${stableJson(ask)}`)
  const reply = structuredClone(source.reply)
  const rows = Array.isArray(reply.chain) ? reply.chain : []
  const at = rows.findIndex((row) => row.strike === reply.atm_strike)
  if (at >= 0) reply.chain = rows.slice(Math.max(0, at - n), Math.min(rows.length, at + n + 1))
  if (!greeks && source === other) {
    for (const row of reply.chain ?? []) {
      for (const leg of [row.ce, row.pe]) if (leg) for (const k of GREEKS) delete leg[k]
    }
    reply.forward_price = null
    reply.greeks_included = false
  }
  reply.server_ts = Math.floor(input.serverNowMs / 1000)
  return reply
}

/**
 * The history reply for `ask`: the recorded read of the same symbol, exchange and interval
 * (case-folded), the widest if several, cut to the rows whose IST date lies within the asked
 * start_date..end_date, in recorded order. NotRecorded when the three were never read.
 */
export function servedHistory(input, ask) {
  const fold = (v) => String(v ?? '').toLowerCase()
  const triple = (b) => [b.symbol, b.exchange, b.interval].map(fold).join('\u0000')
  const want = triple(ask)
  let source = null
  for (const { body, reply } of recordedBodies(input, 'history')) {
    if (triple(body) !== want) continue
    const wider =
      !source ||
      body.start_date < source.start ||
      (body.start_date === source.start && body.end_date > source.end)
    if (wider) source = { start: body.start_date, end: body.end_date, reply }
  }
  const { start_date: start, end_date: end } = ask
  if (!source || typeof start !== 'string' || typeof end !== 'string') {
    throw new NotRecorded(`no recorded reply for history ${stableJson(ask)}`)
  }
  const rows = Array.isArray(source.reply?.data) ? source.reply.data : []
  const data = rows.filter((row) => {
    const d = rowDate(row)
    return d !== null && d >= start && d <= end
  })
  return { status: 'success', data: structuredClone(data) }
}

/** Any read: a chain or a history by the rule above, anything else by its request key. */
export function served(input, { endpoint, body }) {
  if (endpoint === 'optionchain') return servedChain(input, body)
  if (endpoint === 'history') return servedHistory(input, body)
  const key = requestKey(endpoint, body)
  if (!Object.hasOwn(input.responses, key)) throw new NotRecorded(`no recorded reply for ${key}`)
  return structuredClone(input.responses[key])
}

/** The calls in `calls` the recording cannot answer. */
export function unservable(input, calls) {
  return calls.filter((call) => {
    try {
      served(input, call)
      return false
    } catch (e) {
      if (e instanceof NotRecorded) return true
      throw e
    }
  })
}

// --- The master (services/instruments_service.py CSVs) ------------------------------------

/** utils/constants.py FNO_EXCHANGES and CRYPTO_EXCHANGES (src/market/master/underlying.ts). */
const FNO_EXCHANGES = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCDEX', 'NCO', 'CRYPTO'])
const UNDERLYING =
  /^(.+?)(\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2})(?:\d+(?:\.\d+)?)?(?:FUT|CE|PE)?$/
const CRYPTO_UNDERLYING = /^([A-Z0-9]+?)(?=\d{2}[A-Z]{3}\d{2})/

/** extract_underlying_from_symbol (database/token_db_enhanced.py:45-86), as underlying.ts. */
function extractUnderlying(symbol, exchange) {
  if (!symbol || !FNO_EXCHANGES.has(exchange)) return null
  const upper = symbol.toUpperCase()
  if (exchange === 'CRYPTO') {
    const m = CRYPTO_UNDERLYING.exec(upper)
    if (m?.[1]) return m[1]
    const bare = upper.endsWith('.P') ? upper.slice(0, -2) : upper
    for (const suffix of ['USDT', 'USD', '_INR', 'INR']) {
      if (bare.endsWith(suffix) && bare.length > suffix.length) return bare.slice(0, -suffix.length)
    }
    return bare
  }
  return UNDERLYING.exec(upper)?.[1] ?? null
}

/** The CSV's records, each an array of cells (RFC 4180, as src/market/master/csv.ts reads it). */
function* records(text) {
  let i = 0
  const n = text.length
  while (i < n) {
    const row = []
    for (;;) {
      let cell = ''
      if (text[i] === '"') {
        i++
        for (;;) {
          const q = text.indexOf('"', i)
          if (q < 0) {
            cell += text.slice(i)
            i = n
            break
          }
          cell += text.slice(i, q)
          i = q + 1
          if (text[i] !== '"') break
          cell += '"'
          i++
        }
      }
      let j = i
      while (j < n && text[j] !== ',' && text[j] !== '\r' && text[j] !== '\n') j++
      cell += text.slice(i, j)
      i = j
      row.push(cell)
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '\r') i++
      if (text[i] === '\n') i++
      break
    }
    if (row.length > 1 || row[0] !== '') yield row
  }
}

const numberOf = (cell) => {
  const v = cell === undefined || cell.trim() === '' ? 0 : Number(cell)
  return Number.isFinite(v) ? v : 0
}

/** The instruments CSV as the app's MasterRow list (parseInstrumentsCsv), in file order. */
export function parseInstrumentsRows(text) {
  const it = records(text)
  const header = it.next()
  if (header.done) return []
  const at = new Map(header.value.map((name, k) => [name.trim().toLowerCase(), k]))
  const col = (row, name) => {
    const k = at.get(name)
    return k === undefined ? '' : (row[k] ?? '').trim()
  }
  const rows = []
  for (const r of it) {
    const symbol = col(r, 'symbol')
    const exchange = col(r, 'exchange')
    if (!symbol || !exchange) continue
    rows.push({
      symbol,
      name: col(r, 'name'),
      exchange,
      expiry: col(r, 'expiry'),
      strike: numberOf(col(r, 'strike')),
      lotsize: numberOf(col(r, 'lotsize')),
      tick: numberOf(col(r, 'tick_size')),
      itype: col(r, 'instrumenttype'),
      underlying: extractUnderlying(symbol, exchange),
    })
  }
  return rows
}

/** The exchanges whose CSVs a case's master is built from: NFO, MCX and its own. */
export const masterExchanges = (c) => [...new Set(['NFO', 'MCX', c.exchange])]

/**
 * The case's master, from each exchange's MasterRow list (`rows`), at `nowMs`:
 * - strikes: per expiry (DDMMMYY), the underlying's CE strikes on its options exchange,
 *   ascending and distinct (option_symbol_service._query_available_strikes);
 * - futures: the FUT rows of NFO, MCX and the case's exchange, in file order, less those past
 *   their expiry instant;
 * - lotRows: the first row of the options exchange whose symbol starts with the underlying and
 *   has a lot (the /straddlepnl/api/lotsize query), or none.
 */
export function masterOf(c, rows, nowMs) {
  const base = c.underlying.toUpperCase()
  const own = rows[c.exchange] ?? []
  const byExpiry = new Map()
  for (const r of own) {
    const symbol = r.symbol.toUpperCase()
    if (r.itype !== 'CE' || !r.expiry || !symbol.endsWith('CE')) continue
    const expiry = compact(r.expiry.toUpperCase())
    if (!symbol.startsWith(`${base}${expiry}`)) continue
    if (!byExpiry.has(expiry)) byExpiry.set(expiry, new Set())
    byExpiry.get(expiry).add(r.strike)
  }
  const strikes = Object.fromEntries(
    [...byExpiry].map(([e, set]) => [e, [...set].sort((a, b) => a - b)]),
  )
  const futures = masterExchanges(c).flatMap((ex) =>
    (rows[ex] ?? []).filter((r) => {
      if (!r.symbol.toUpperCase().endsWith('FUT')) return false
      const at = expiryInstantMs(r.expiry, r.exchange)
      return at !== null && at >= nowMs
    }),
  )
  const lot = own.find((r) => r.symbol.toUpperCase().startsWith(base) && r.lotsize > 0)
  return { strikes, futures, lotRows: lot ? [lot] : [] }
}

/**
 * find_near_month_futures (option_symbol_service.py:130-193): the base's own futures (exact
 * base, then a DDMMMYY date) on `exchange` expiring today or later, the soonest.
 */
function nearFuture(base, exchange, futures, nowMs) {
  const exact = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{2}[A-Z]{3}\\d{2}FUT$`,
  )
  const today = istDate(nowMs)
  const candidates = futures
    .filter((r) => r.exchange === exchange && r.itype === 'FUT' && exact.test(r.symbol))
    .map((r) => ({ r, day: expiryDay(r.expiry) }))
    .filter((x) => x.day !== null && x.day >= today)
  candidates.sort((a, b) => byCharCode(a.day, b.day))
  return candidates[0]?.r ?? null
}

/**
 * The reference the tool services quote and read history of: the near-month future where
 * there is no spot (resolve_underlying_quote), else the index or the cash market; null when an
 * exchange without a spot has no future.
 */
export function referenceOf(c, master, nowMs) {
  const base = c.underlying.toUpperCase()
  const ex = c.exchange.toUpperCase()
  if (NO_SPOT.has(ex)) {
    const fut = nearFuture(base, ex, master?.futures ?? [], nowMs)
    return fut ? { symbol: fut.symbol, exchange: fut.exchange } : null
  }
  if (NSE_INDEX.has(base)) return { symbol: base, exchange: 'NSE_INDEX' }
  if (BSE_INDEX.has(base)) return { symbol: base, exchange: 'BSE_INDEX' }
  if (ex === 'NFO') return { symbol: base, exchange: 'NSE' }
  if (ex === 'BFO') return { symbol: base, exchange: 'BSE' }
  return { symbol: base, exchange: ex }
}

/**
 * OI Profile's future (_find_futures_symbol, oi_profile_service.py:71-130): the same-expiry FUT
 * of the master, else the soonest of the first ten by symbol.
 */
function oiFuture(c, expiry, futures) {
  const rows = futures
    .filter(
      (r) =>
        r.exchange === c.exchange &&
        r.underlying === c.underlying.trim().toUpperCase() &&
        r.symbol.toUpperCase().endsWith('FUT'),
    )
    .sort((a, b) => byCharCode(a.symbol, b.symbol))
  const same = rows.find((r) => r.expiry === dashed(expiry))
  if (same) return same.symbol
  // parse_expiry: an unreadable expiry sorts last
  const day = (r) => expiryDay(r.expiry) ?? '9999-12-31'
  return rows.slice(0, 10).sort((a, b) => byCharCode(day(a), day(b)))[0]?.symbol ?? null
}

/** The builder's legs: the ATM straddle of the first expiry's 20-strike chain, sold. */
export function strategyLegsOf(c, chain20, expiry) {
  const row = (chain20?.chain ?? []).find((r) => r.strike === chain20.atm_strike)
  if (!row?.ce || !row?.pe) return []
  return [
    [row.ce, 'CE'],
    [row.pe, 'PE'],
  ].map(([leg, optionType]) => ({
    symbol: leg.symbol,
    exchange: c.exchange,
    side: 'SELL',
    segment: 'OPTION',
    active: true,
    price: leg.ltp,
    strike: row.strike,
    optionType,
    expiry,
  }))
}

/**
 * What recordedCallsF reads off a recording: the expiry lists, the first expiry's chains (the
 * with-Greeks 20 the Strike Profile probes and the builder reads, chain 1, and the plain 20 OI
 * Profile reads), and the reference's 1-minute candles over the straddle window, each as the
 * rule above serves it, or undefined while not recorded.
 */
export function contextF(c, input) {
  const get = (call) => {
    try {
      return served(input, call)
    } catch (e) {
      if (e instanceof NotRecorded) return undefined
      throw e
    }
  }
  const [options, futures] = expiryCalls(c)
  const nowMs = input.serverNowMs
  const ctx = {
    expiries: get(options)?.data ?? [],
    futExpiries: get(futures)?.data ?? [],
    master: input.master,
    nowMs,
  }
  if (ctx.expiries.length === 0) return ctx
  const e0 = compact(ctx.expiries[0])
  ctx.chain20 = get(chainCall(c, e0, PROBE, { withGreeks: true }))
  ctx.chain1 = get(chainCall(c, e0, 1))
  ctx.oiChain = get(chainCall(c, e0, PROBE))
  const ref = referenceOf(c, input.master, nowMs)
  if (ref) {
    const window = tradingWindow(F_PARAMS.days.straddle, nowMs)
    ctx.refMinute = get(
      historyCall(ref.symbol, ref.exchange, F_PARAMS.straddleInterval, window),
    )?.data
  }
  return ctx
}

/**
 * A superset of the reads the server's services and the phone's routes make for F_PARAMS
 * (ctx: contextF's; each optional part leaves out the reads that need it):
 * - intervals {} and the two expiry reads;
 * - optionchain with_greeks for the first 6 expiries at 20, wantedStrikes(5) and 40; plain 40
 *   for the first 4; chain 1 for the first;
 * - history at 5m over the strategy window (it holds the IV chart's): the reference, the IV
 *   chart's ATM legs (chain 1's and the master strike nearest its LTP) and the builder's;
 * - history at 5m over the OI Profile window: its future (the master's and the futures list's);
 *   'D' over 14 days for every leg with OI of the chain it reads;
 * - history at 1m over the straddle window: the reference; CE and PE of every strike its closes
 *   reach (nearest listed, first on ties), from the first of the 3 dates the straddle keeps
 *   (the merge drops the older candles, so they are not recorded);
 * - quotes for the reference.
 * Without duplicates, in that order.
 */
export function recordedCallsF(c, ctx) {
  const {
    expiries = [],
    futExpiries = [],
    chain20,
    chain1,
    oiChain,
    refMinute,
    master,
    nowMs,
  } = ctx
  const calls = [{ endpoint: 'intervals', body: {} }, ...expiryCalls(c)]
  if (expiries.length > 0) {
    const list = expiries.map(compact)
    const e0 = list[0]
    const ox = c.exchange
    const spot = chain20?.underlying_ltp
    const counts = new Set([PROBE])
    for (const range of F_PARAMS.ranges) {
      if (!range || isNumber(spot)) counts.add(wantedStrikes(chain20, spot, range))
    }
    for (const e of list.slice(0, F_PARAMS.profileExpiries)) {
      for (const n of counts) calls.push(chainCall(c, e, n, { withGreeks: true }))
    }
    for (const e of list.slice(0, F_PARAMS.surfaceExpiries)) {
      calls.push(chainCall(c, e, F_PARAMS.surfaceStrikes))
    }
    calls.push(chainCall(c, e0, 1))

    const { days } = F_PARAMS
    const ref = referenceOf(c, master, nowMs)
    const fiveMinutes = tradingWindow(Math.max(days.ivchart, days.strategy), nowMs)
    if (ref) calls.push(historyCall(ref.symbol, ref.exchange, F_PARAMS.interval, fiveMinutes))
    const ladder = master?.strikes?.[e0] ?? []
    const legs = [...atmSymbols(chain1), ...atmSymbols(chain20)]
    const atm = chain1 ? nearestStrike(chain1.underlying_ltp, ladder) : null
    if (atm !== null)
      legs.push(
        optionSymbol(c.underlying, e0, atm, 'CE'),
        optionSymbol(c.underlying, e0, atm, 'PE'),
      )
    for (const symbol of legs) calls.push(historyCall(symbol, ox, F_PARAMS.interval, fiveMinutes))

    const oiWindow = tradingWindow(days.oiprofile, nowMs)
    const listed = futExpiries.map(compact)
    const futs = [
      oiFuture(c, e0, master?.futures ?? []),
      listed.length ? `${c.underlying}${listed.includes(e0) ? e0 : listed[0]}FUT` : null,
    ]
    for (const symbol of futs.filter(Boolean)) {
      calls.push(historyCall(symbol, ox, F_PARAMS.interval, oiWindow))
    }
    const today = istDate(nowMs)
    const daily = { start_date: addDays(today, -DAILY_DAYS), end_date: today }
    for (const row of oiChain?.chain ?? []) {
      for (const leg of [row.ce, row.pe]) {
        if (leg?.symbol && (leg.oi || 0) > 0) calls.push(historyCall(leg.symbol, ox, 'D', daily))
      }
    }

    if (ref) {
      const minute = F_PARAMS.straddleInterval
      calls.push(historyCall(ref.symbol, ref.exchange, minute, tradingWindow(days.straddle, nowMs)))
      const kept = [...new Set((refMinute ?? []).map(rowDate).filter(Boolean))]
        .sort()
        .slice(-days.straddle)
      if (kept.length > 0) {
        const reached = new Set()
        for (const row of refMinute) {
          const k = nearestStrike(row.close, ladder)
          if (k !== null) reached.add(k)
        }
        const window = { start_date: kept[0], end_date: today }
        for (const k of [...reached].sort((a, b) => a - b)) {
          for (const type of ['CE', 'PE']) {
            calls.push(historyCall(optionSymbol(c.underlying, e0, k, type), ox, minute, window))
          }
        }
      }
      calls.push(quotesCall(ref.symbol, ref.exchange))
    }
  }
  const seen = new Set()
  return calls.filter((x) => {
    const key = requestKey(x.endpoint, x.body)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
