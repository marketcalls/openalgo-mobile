// The stock server's HTTP side: /auth/app-info, /api/v1/swagger.json and the POST
// endpoints, with the error shapes of openalgo at c8b2896 (plan contract S2-S9). The trading
// endpoints' validation and handlers live in orders.mjs, and the GTT endpoints' in gtt.mjs; this
// file routes them.
import { STATUS_CODES } from 'node:http'
import {
  HISTORY_INTERVALS,
  historySeries,
  holidaysOf,
  istDateOf,
  MOCK_INTERVALS,
  timingsFor,
} from './chart.mjs'
import { GTT_SCHEMAS } from './gtt.mjs'
import {
  findInstrument,
  instrumentRows,
  instrumentsCsv,
  searchInstruments,
} from './instruments.mjs'
import { chainBody, futureExpiries, OPTION_UNDERLYINGS, optionExpiries } from './options.mjs'
import { TRADING_SCHEMAS } from './orders.mjs'
import { depthLevels, quote } from './prices.mjs'
import { endpointsOf, GET_ROUTES, swaggerKey } from './profiles.mjs'
import { pathKey } from './state.mjs'
import {
  BENCHMARKS,
  ROTATION_OPTIONS,
  SIP_FREQUENCIES,
  TEARSHEET_HTML,
  toolReply,
} from './tools.mjs'
import { legHistory, servesLegHistory } from './toolsF.mjs'

const HTML_SHELL =
  '<!doctype html><html><head><title>OpenAlgo</title></head><body><div id="root"></div></body></html>'
const HTML = 'text/html; charset=utf-8'
const JSON_TYPE = 'application/json'

const jsonReply = (status, obj) => ({ status, contentType: JSON_TYPE, body: JSON.stringify(obj) })
const htmlReply = (status) => ({ status, contentType: HTML, body: HTML_SHELL })

const UNEXPECTED = jsonReply(500, { status: 'error', message: 'An unexpected error occurred' })
const INVALID_KEY = { status: 'error', message: 'Invalid openalgo apikey' }

// utils/security_middleware.py:66-72 (text) and :130-132 (json).
export function banReply(form) {
  return form === 'text'
    ? { status: 403, contentType: 'text/plain', body: 'Access Denied: Your IP has been banned' }
    : jsonReply(403, { error: 'Access Denied' })
}

// S5: restx (inferred), services/broker_busy.py:49-51, install/install-docker.sh:776.
const RATE_LIMITED = {
  restx: jsonReply(429, { message: '10 per 1 second' }),
  busy: jsonReply(429, {
    status: 'error',
    message:
      "OpenAlgo is pacing requests to stay within your broker's rate limit, and this one would " +
      'have had to wait too long for its turn. Try again in a few seconds.',
  }),
  nginx: {
    status: 429,
    contentType: 'text/html',
    body:
      '<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>\r\n' +
      '<center><h1>429 Too Many Requests</h1></center>\r\n<hr><center>nginx</center>\r\n' +
      '</body>\r\n</html>\r\n',
  },
}

// S6: how a profile answers a route it does not have (app.py:658-659 from 2.0.2.1).
function missingReply(version, pathname) {
  if (version.missing === 'json404' && pathname.startsWith('/api/')) {
    return jsonReply(404, { status: 'error', message: 'Not found', path: pathname })
  }
  return htmlReply(version.missing === 'html200' ? 200 : 404)
}

function failureReply(f) {
  const text = typeof f.body === 'string'
  return {
    status: f.status,
    contentType: f.contentType ?? (text ? 'text/plain' : JSON_TYPE),
    body: text ? f.body : JSON.stringify(f.body ?? {}),
  }
}

function send(res, r) {
  res.writeHead(r.status, { 'Content-Type': r.contentType, ...r.headers })
  res.end(r.body)
}

/** Writes a whole HTTP response on a raw socket, as when refusing a WebSocket upgrade. */
export function writeRaw(socket, r) {
  // Node drops its own 'error' listener from an upgraded socket, so without this a client
  // reset (read ECONNRESET) would be an unhandled 'error' and take the whole mock down.
  socket.on('error', () => socket.destroy())
  const body = Buffer.from(r.body)
  const head =
    `HTTP/1.1 ${r.status} ${STATUS_CODES[r.status]}\r\nContent-Type: ${r.contentType}\r\n` +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`
  socket.end(Buffer.concat([Buffer.from(head), body]))
}

// --- Validation, as marshmallow and each restx handler report it (S7) -------------

/**
 * Python's repr() of marshmallow's error dict, as `str(err.messages)` prints it. A Map holds
 * a list's per-index errors, whose keys are ints.
 */
function pyRepr(v) {
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  if (v instanceof Map) {
    return `{${[...v].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`
  }
  if (v && typeof v === 'object') {
    return `{${Object.entries(v)
      .map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`)
      .join(', ')}}`
  }
  if (typeof v !== 'string') return String(v)
  const q = v.includes("'") && !v.includes('"') ? '"' : "'"
  return q + v.replaceAll('\\', '\\\\').replaceAll(q, `\\${q}`) + q
}

const SECTOR_REFUSAL =
  'These map settings were not accepted. Choose the benchmark and timeframe again, or use ' +
  'Reset to sectors if you added symbols.'
// Each takes the errors; analyzerRepr also takes whether analyzer mode is on.
const STYLES = {
  repr: (errors) => ({ status: 'error', message: pyRepr(errors) }), // analyzer, placeorder
  // The GTT writes: str(), which emit_analyzer_error tags in analyzer mode
  // (restx_api/place_gtt_order.py:31-35 and its two siblings).
  analyzerRepr: (errors, analyzer) => ({
    ...(analyzer ? { mode: 'analyze' } : {}),
    status: 'error',
    message: pyRepr(errors),
  }),
  dict: (errors) => ({ status: 'error', message: errors }), // history, funds, quotes, …
  restx: (errors) => ({ status: 'error', message: 'Validation error', errors }), // optionchain
  failed: (errors) => ({ status: 'error', message: 'Validation failed', errors }), // multioptiongreeks
  sector: () => ({ status: 'error', message: SECTOR_REFUSAL }), // restx_api/sector_rotation.py:83-96
}

const TRUTHY = ['t', 'true', 'on', 'y', 'yes', '1']
const FALSY = ['f', 'false', 'off', 'n', 'no', '0']
function toBool(v) {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === 0) return v === 1
  if (typeof v === 'string' && TRUTHY.includes(v.toLowerCase())) return true
  if (typeof v === 'string' && FALSY.includes(v.toLowerCase())) return false
  return null
}

// validate.OneOf(VALID_EXCHANGES), with the profile's C2 set, on every profile as plan C2 says.
// Plan-mandated divergence: openalgo added this OneOf in 4da5fbcd0 (2026-03-05). Earlier trees
// (90c3d2caf) type exchange as a plain Str, so a real 2.0.0.0 search answers an unknown exchange
// with 200 []. No app code may depend on this 400 on 2.0.0.0.
const exchangeField = (b, v) =>
  b.exchange != null && !v.exchanges.includes(b.exchange)
    ? { exchange: [`Must be one of: ${v.exchanges.join(', ')}.`] }
    : null
const boolField = (f) => (b) =>
  b[f] !== undefined && toBool(b[f]) === null ? { [f]: ['Not a valid boolean.'] } : null
const listField =
  (f, max = Number.POSITIVE_INFINITY) =>
  (b) => {
    const v = b[f]
    if (v === undefined) return null
    if (!Array.isArray(v)) return { [f]: ['Not a valid list.'] }
    if (v.length >= 1 && v.length <= max) return null
    return {
      [f]: [
        max < Number.POSITIVE_INFINITY
          ? `Length must be between 1 and ${max}.`
          : 'Shorter than minimum length 1.',
      ],
    }
  }

const PORTFOLIO_OPTIONAL = (
  'benchmark benchmark_exchange rebalance drift_band cost_model brokerage_pct cost_exchange ' +
  'charges gst_rate cost_bps slippage initial_capital risk_free_rate source'
).split(' ')
const SIP_OPTIONAL = (
  'exchange frequency day_of_month step_up_percent brokerage_percent brokerage_flat cost_model ' +
  'cost_exchange charges gst_rate cost_bps slippage benchmark benchmark_exchange source include_grids'
).split(' ')
const SYMBOL = ['apikey', 'symbol', 'exchange']

// marshmallow's fields.Date(format='%Y-%m-%d').
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v))
const dateFields =
  (...fs) =>
  (b) =>
    Object.fromEntries(
      fs.filter((f) => f in b && !isDate(b[f])).map((f) => [f, ['Not a valid date.']]),
    )
// restx_api/data_schemas.py:119-130: F_AND_O_EXCHANGES and the two instrument types.
const F_AND_O_EXCHANGES = ['NFO', 'BFO', 'MCX', 'CDS', 'NCO', 'BCD', 'NCDEX', 'CRYPTO']
const expiryChecks = (b) => ({
  ...(b.exchange != null && !F_AND_O_EXCHANGES.includes(b.exchange)
    ? { exchange: [`Must be one of: ${F_AND_O_EXCHANGES.join(', ')}.`] }
    : null),
  ...(b.instrumenttype != null && !['futures', 'options'].includes(b.instrumenttype)
    ? { instrumenttype: ['Must be one of: futures, options.'] }
    : null),
})
// restx_api/data_schemas.py: history's interval is a OneOf, then the broker's map refuses what it lacks.
const historyChecks = (b, v) => ({
  ...exchangeField(b, v),
  ...(typeof b.interval === 'string' && !HISTORY_INTERVALS.includes(b.interval)
    ? { interval: [`Must be one of: ${HISTORY_INTERVALS.join(', ')}.`] }
    : null),
  ...dateFields('start_date', 'end_date')(b),
})

// Fields per endpoint (restx_api/*_schema.py and the per-endpoint schemas at c8b2896).
// `optional` may depend on the profile; anything undeclared is an Unknown field.
const SCHEMAS = {
  ping: { style: 'dict', required: ['apikey'] },
  funds: { style: 'dict', required: ['apikey'] },
  search: {
    style: 'dict',
    required: ['apikey', 'query'],
    optional: ['exchange'],
    check: exchangeField,
  },
  symbol: { style: 'dict', required: SYMBOL, check: exchangeField },
  analyzer: { style: 'repr', required: ['apikey'] },
  'analyzer/toggle': { style: 'repr', required: ['apikey', 'mode'], check: boolField('mode') },
  quotes: { style: 'dict', required: SYMBOL },
  multiquotes: { style: 'dict', required: ['apikey', 'symbols'], check: listField('symbols') },
  depth: { style: 'dict', required: SYMBOL },
  history: {
    style: 'dict',
    required: [...SYMBOL, 'interval', 'start_date', 'end_date'],
    optional: (v) => (v.historySource ? ['source'] : []),
    check: historyChecks,
  },
  intervals: { style: 'dict', required: ['apikey'] },
  expiry: {
    style: 'dict',
    required: ['apikey', 'symbol', 'exchange', 'instrumenttype'],
    check: expiryChecks,
  },
  'market/timings': { style: 'dict', required: ['apikey', 'date'], check: dateFields('date') },
  'market/holidays': {
    style: 'dict',
    required: ['apikey'],
    optional: ['year'],
    check: (b) =>
      'year' in b && !Number.isInteger(b.year) ? { year: ['Not a valid integer.'] } : null,
  },
  optionchain: {
    style: 'restx',
    required: ['apikey', 'underlying', 'exchange', 'expiry_date'],
    optional: (v) => ['strike_count', ...(v.withGreeks ? ['with_greeks', 'interest_rate'] : [])],
  },
  multioptiongreeks: {
    style: 'failed',
    required: ['apikey', 'symbols'],
    optional: ['interest_rate', 'expiry_time'],
    check: listField('symbols', 50),
  },
  'portfolio/backtest': {
    style: 'dict',
    required: ['apikey', 'holdings', 'start_date', 'end_date'],
    optional: PORTFOLIO_OPTIONAL,
  },
  'portfolio/tearsheet': {
    style: 'dict',
    required: ['apikey', 'holdings', 'start_date', 'end_date'],
    optional: PORTFOLIO_OPTIONAL,
  },
  'portfolio/holdings': {
    style: 'dict',
    required: ['apikey'],
    optional: ['lookback_days', 'benchmark', 'benchmark_exchange', 'risk_free_rate', 'source'],
  },
  'sip/backtest': {
    style: 'dict',
    required: ['apikey', 'symbol', 'start_date', 'end_date', 'amount'],
    optional: SIP_OPTIONAL,
  },
  sectorrotation: {
    style: 'sector',
    required: ['apikey'],
    optional: ['benchmark', 'timeframe', 'source', 'instruments'],
  },
}

function validationErrors(schema, body, version) {
  const errors = {}
  for (const f of schema.required) {
    if (!(f in body)) errors[f] = ['Missing data for required field.']
    else if (body[f] === null) errors[f] = ['Field may not be null.']
  }
  Object.assign(errors, schema.check?.(body, version))
  const optional =
    typeof schema.optional === 'function' ? schema.optional(version) : (schema.optional ?? [])
  const known = new Set([...schema.required, ...optional])
  for (const f of Object.keys(body)) if (!known.has(f)) errors[f] = ['Unknown field.']
  return Object.keys(errors).length ? errors : null
}

// --- Data -------------------------------------------------------------------------

// services/quotes_service.py:14-38: the exchange, then the master contract (instruments.mjs).
// History runs the same check before the broker call (services/history_service.py:56-80,132-134).
function symbolError(symbol, exchange, { exchanges }) {
  if (!symbol || !exchange) return 'Missing symbol or exchange in request'
  if (!exchanges.includes(String(exchange).toUpperCase())) {
    return `Invalid exchange '${exchange}'. Must be one of: ${exchanges.join(', ')}`
  }
  if (!findInstrument(symbol, exchange)) {
    return (
      `Symbol '${symbol}' not found for exchange '${exchange}'. ` +
      'Please verify the symbol name and ensure master contracts are downloaded.'
    )
  }
  return null
}

const FUNDS = {
  availablecash: '320.66',
  collateral: '0.00',
  m2mrealized: '3.27',
  m2munrealized: '-7.88',
  utiliseddebits: '679.34',
}

/** The tools' reply style: thin while the control `thinToolReplies` is set. */
const thinOf = (state) => ({ thin: state.current.thinToolReplies === true })
const ok = (data) => [200, { status: 'success', data }]
const analyzerData = (on) => ({ mode: on ? 'analyze' : 'live', analyze_mode: on, total_logs: 0 })
const fixed2 = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, ['volume', 'oi'].includes(k) ? v : v.toFixed(2)]),
  )

// Each handler runs after validation and the key checks, and returns [status, body].
// history, optionchain, multioptiongreeks and the tools have no M1 consumer: their bodies
// only have the documented shape.
const HANDLERS = {
  ping: (_b, { state }) => ok({ message: 'pong', broker: state.current.broker }),
  funds: () => ok(FUNDS),
  search(b) {
    const q = typeof b.query === 'string' ? b.query.trim().toUpperCase() : ''
    if (!q) {
      return [400, { status: 'error', message: 'Query parameter is required and cannot be empty' }]
    }
    const data = searchInstruments(q, b.exchange)
    const message = data.length
      ? `Found ${data.length} matching symbols`
      : 'No matching symbols found'
    return [200, { status: 'success', message, data }]
  },
  // services/symbol_service.py:39-66.
  symbol(b) {
    const i = findInstrument(b.symbol, b.exchange)
    if (!i) {
      const message = `Symbol ${b.symbol} not found in exchange ${b.exchange}`
      return [404, { status: 'error', message }]
    }
    return [200, { data: { ...i }, status: 'success' }]
  },
  analyzer: (_b, { state }) => ok(analyzerData(state.current.analyzer)),
  'analyzer/toggle'(b, { state }) {
    const on = toBool(b.mode)
    state.patch({ analyzer: on })
    return ok({
      ...analyzerData(on),
      message: `Analyzer mode switched to ${on ? 'analyze' : 'live'}`,
    })
  },
  quotes(b, { prices, version }) {
    const error = symbolError(b.symbol, b.exchange, version)
    return error
      ? [400, { status: 'error', message: error }]
      : ok(quote(prices.read(b.symbol, b.exchange)))
  },
  multiquotes(b, { prices, version }) {
    const checked = b.symbols.map((s) => ({
      s: s ?? {},
      error: symbolError(s?.symbol, s?.exchange, version),
    }))
    const bad = checked
      .filter((x) => x.error)
      .map(({ s, error }) => ({ symbol: s.symbol, exchange: s.exchange, error }))
    const good = checked.filter((x) => !x.error)
    if (!good.length) {
      return [400, { status: 'error', message: bad[0].error, invalid_symbols: bad }]
    }
    // Invalid entries come first; prices arrive as strings, as some brokers send them.
    const results = [
      ...bad,
      ...good.map(({ s }) => ({
        symbol: s.symbol,
        exchange: s.exchange,
        data: fixed2(quote(prices.read(s.symbol, s.exchange))),
      })),
    ]
    return [200, { status: 'success', results }]
  },
  depth(b, { prices, version }) {
    const error = symbolError(b.symbol, b.exchange, version)
    if (error) return [400, { status: 'error', message: error }]
    const st = prices.read(b.symbol, b.exchange)
    const side = (s) => depthLevels(st, s, 5).map(({ price, quantity }) => ({ price, quantity }))
    const bids = side('buy')
    const asks = side('sell')
    const total = (levels) => levels.reduce((n, l) => n + l.quantity, 0)
    const { open, high, low, ltp, prev_close, volume, oi } = quote(st)
    return ok({
      open,
      high,
      low,
      ltp,
      ltq: 1 + Math.floor(st.rng() * 500),
      prev_close,
      volume,
      oi,
      totalbuyqty: total(bids),
      totalsellqty: total(asks),
      asks,
      bids,
    })
  },
  history(b, { prices, version }) {
    const error = symbolError(b.symbol, b.exchange, version)
    if (error) return [400, { status: 'error', message: error }]
    // In the OneOf but not in the mock's broker map: services/history_service.py via the adapter.
    if (!Object.values(MOCK_INTERVALS).flat().includes(b.interval)) {
      return [500, { status: 'error', message: `Unsupported timeframe: ${b.interval}` }]
    }
    // Options and futures: candles with day-hash open interest, whole lots (toolsF.mjs).
    if (servesLegHistory(b)) return ok(legHistory(b, { nowMs: Date.now() }))
    return ok(
      historySeries({
        symbol: b.symbol,
        exchange: b.exchange,
        interval: b.interval,
        startDate: b.start_date,
        endDate: b.end_date,
        lastClose: prices.read(b.symbol, b.exchange).ltp,
        nowMs: Date.now(),
      }),
    )
  },
  intervals(_b, { version }) {
    const data = structuredClone(MOCK_INTERVALS)
    if (version.intervalAliases) data.minutes.push('60m')
    return ok(data)
  },
  'market/timings': (b, { state }) => ok(timingsFor(b.date, state.current.timingsSkewMs)),
  'market/holidays': (b) => ok(holidaysOf(b.year ?? Number(istDateOf(Date.now()).slice(0, 4)))),
  optionchain: (b, { prices, version }) => chainBody(b, { prices, version, nowMs: Date.now() }),
  // services/expiry_service.py: the master's expiries of the underlying, dropped once gone.
  expiry(b) {
    const symbol = b.symbol.trim().toUpperCase()
    const exchange = b.exchange.trim().toUpperCase()
    if (OPTION_UNDERLYINGS[symbol]?.fo !== exchange) {
      return [
        404,
        { status: 'error', message: `No expiry dates found for ${symbol} in ${exchange}` },
      ]
    }
    const data = (b.instrumenttype === 'futures' ? futureExpiries : optionExpiries)(Date.now())
    return [
      200,
      {
        status: 'success',
        message: `Found ${data.length} expiry dates for ${symbol} ${b.instrumenttype} in ${exchange}`,
        data,
      },
    ]
  },
  multioptiongreeks(b) {
    const data = b.symbols.map((s) => ({
      status: 'error',
      symbol: s?.symbol,
      exchange: s?.exchange,
      message: 'The mock server does not compute Greeks',
    }))
    return [
      200,
      { status: 'success', data, summary: { total: data.length, success: 0, failed: data.length } },
    ]
  },
  'portfolio/backtest': (b, { state }) => [200, toolReply('portfolio/backtest', b, thinOf(state))],
  // restx_api/portfolio.py:259-288: a self-contained report, served as an attachment.
  'portfolio/tearsheet': () => ({
    status: 200,
    contentType: HTML,
    headers: { 'Content-Disposition': 'attachment; filename="portfolio-tearsheet.html"' },
    body: TEARSHEET_HTML,
  }),
  'portfolio/holdings': (b, { state }) => [200, toolReply('portfolio/holdings', b, thinOf(state))],
  'sip/backtest': (b, { state }) => [200, toolReply('sip/backtest', b, thinOf(state))],
  sectorrotation: (b, { state }) => [200, toolReply('sectorrotation', b, thinOf(state))],
}

// --- GET-only routes (design 7.2) -------------------------------------------------

const MISSING_KEY = { apikey: ['Missing data for required field.'] }

/** instruments: the key and the filters come in the query (restx_api/instruments.py). */
function instrumentsReply(q, apiKey, version) {
  const csv = q.get('format')?.toLowerCase() === 'csv'
  const refuse = (status, message) =>
    csv
      ? {
          status,
          contentType: 'text/plain',
          body: typeof message === 'string' ? message : pyRepr(message),
        }
      : jsonReply(status, { status: 'error', message })
  const errors = {
    ...(q.has('apikey') ? null : MISSING_KEY),
    ...(q.get('exchange') != null && !version.exchanges.includes(q.get('exchange'))
      ? { exchange: [`Must be one of: ${version.exchanges.join(', ')}.`] }
      : null),
    ...(q.has('format') && !['json', 'csv'].includes(q.get('format').toLowerCase())
      ? { format: ['Must be one of: json, csv.'] }
      : null),
  }
  if (Object.keys(errors).length) return refuse(400, errors)
  if (q.get('apikey') !== apiKey) return refuse(403, INVALID_KEY.message)
  const exchange = q.get('exchange') || undefined
  if (csv) {
    return {
      status: 200,
      contentType: 'text/csv',
      headers: {
        'Content-Disposition': `attachment; filename=instruments_${exchange ?? 'all'}.csv`,
      },
      body: instrumentsCsv(exchange),
    }
  }
  const data = instrumentRows(exchange).map(({ id: _, ...row }) => row)
  return jsonReply(200, { status: 'success', message: `Found ${data.length} instruments`, data })
}

// Each takes the query and the key. benchmarks checks the key; frequencies and options take none.
const GET_HANDLERS = {
  instruments: instrumentsReply,
  'portfolio/benchmarks': (q, apiKey) =>
    q.get('apikey') === apiKey
      ? jsonReply(200, { status: 'success', data: BENCHMARKS })
      : jsonReply(403, INVALID_KEY),
  'sip/frequencies': () => jsonReply(200, { status: 'success', data: SIP_FREQUENCIES }),
  'sectorrotation/options': () => jsonReply(200, { status: 'success', data: ROTATION_OPTIONS }),
}

function isJson(contentType = '') {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return mime === 'application/json' || (mime.startsWith('application/') && mime.endsWith('+json'))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const BASKET_STALL_MS = 2000

// Unref'd, so a delayed answer never keeps a closed mock's process alive.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())

/** The legacy schemas' load: the body itself, or its errors. */
function loadBody(schema, body, version) {
  const errors = validationErrors(schema, body, version)
  return errors ? { errors } : { data: body }
}

export function createRest({ state, prices, apiKey, orders, gtt }) {
  function apiCall(id, contentType, text) {
    // Flask 3.1 refuses request.json without a JSON Content-Type, and so does a body that
    // does not parse; each handler's `except Exception` turns that into this 500.
    if (!isJson(contentType)) return UNEXPECTED
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return UNEXPECTED
    }
    // The trading and GTT endpoints load and answer through their engines.
    const engine = TRADING_SCHEMAS[id] ? orders : GTT_SCHEMAS[id] ? gtt : null
    const custom = TRADING_SCHEMAS[id] ?? GTT_SCHEMAS[id]
    const schema = custom ?? SCHEMAS[id]
    const refuse = (errors) => jsonReply(400, STYLES[schema.style](errors, state.current.analyzer))
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse({ _schema: ['Invalid input type.'] })
    }
    state.noteBody(id, body)
    const version = state.version
    const loaded = custom ? custom.load(body, version) : loadBody(schema, body, version)
    if (loaded.errors) return refuse(loaded.errors)
    // restx_api/multi_option_greeks.py:104-110 answers a bad key with 401.
    if (body.apikey !== apiKey) {
      return jsonReply(id === 'multioptiongreeks' ? 401 : 403, INVALID_KEY)
    }
    // S3: search checks only the key; everything else also needs the broker session.
    if (state.current.brokerLoggedOut && id !== 'search') return jsonReply(403, INVALID_KEY)
    try {
      const handler = engine ? engine.handlers[id] : HANDLERS[id]
      const out = handler(loaded.data, { state, prices, version })
      // A handler answers [status, json], or with a whole reply (the tearsheet's HTML).
      return Array.isArray(out) ? jsonReply(out[0], out[1]) : out
    } catch (e) {
      console.error('mock-server:', e)
      return UNEXPECTED
    }
  }

  // The answer to a request that is neither banned nor failed by a control.
  function route(req, pathname, text) {
    const s = state.current
    const version = state.version
    const id = pathKey(pathname)
    const api = pathname.startsWith('/api/v1/')
    if (s.rateLimited && api && id !== 'swagger.json') return RATE_LIMITED[s.rateLimited]
    if (req.method === 'GET' && pathname === '/auth/app-info' && version.appInfo && s.appInfo) {
      return jsonReply(200, { status: 'success', version: s.profile, name: 'OpenAlgo' })
    }
    if (req.method === 'GET' && id === 'swagger.json' && api && s.swagger) {
      const paths = Object.fromEntries(
        endpointsOf(version).map((e) => [swaggerKey(e), { post: {} }]),
      )
      const spec = {
        swagger: '2.0',
        basePath: '/api/v1',
        info: { title: 'OpenAlgo API', version: '1.0' },
        paths,
      }
      return jsonReply(200, spec)
    }
    if (api && GET_ROUTES[id]?.(version)) {
      if (req.method !== 'GET') {
        return jsonReply(405, { message: 'The method is not allowed for the requested URL.' })
      }
      return GET_HANDLERS[id](new URL(req.url, 'http://mock').searchParams, apiKey, version)
    }
    if (api && endpointsOf(version).includes(id)) {
      if (req.method !== 'POST') {
        return jsonReply(405, { message: 'The method is not allowed for the requested URL.' })
      }
      return apiCall(id, req.headers['content-type'], text)
    }
    return missingReply(version, pathname)
  }

  return {
    async handle(req, res) {
      const { pathname } = new URL(req.url, 'http://mock')
      state.countRequest(pathname)
      // Read first: a request delayed by delayNext may outlive its client.
      const text = await readBody(req)
      if (state.current.banned) return send(res, banReply(state.current.banned))
      // failNext and delayNext: with afterApply the request is carried out first, then its
      // answer is replaced by the failure or sent late.
      const failure = state.takeFailure(pathname)
      const delay = state.takeDelay(pathname)
      if (delay && !delay.afterApply) await sleep(delay.ms)
      let r = failure && !failure.afterApply ? null : route(req, pathname, text)
      if (failure) r = failureReply(failure)
      if (delay?.afterApply) await sleep(delay.ms)
      // basketStall: the legs are booked, then the proxy gives up: a 502 after 2 s.
      if (state.current.basketStall && pathKey(pathname) === 'basketorder' && r.status === 200) {
        await sleep(BASKET_STALL_MS)
        r = jsonReply(502, { status: 'error', message: 'Bad gateway' })
      }
      if (!res.destroyed) send(res, r)
    },

    /** A WebSocket upgrade on the REST port: Flask answers it as a missing route, 404 html. */
    upgrade(req, socket) {
      const { pathname } = new URL(req.url, 'http://mock')
      state.countRequest(pathname)
      const banned = state.current.banned
      writeRaw(socket, banned ? banReply(banned) : htmlReply(404))
    },
  }
}
