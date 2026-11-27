// The mock's master contract (plan contract C1): what /symbol, /search, the quote endpoints and
// the WS ack treat as listed. Anything else is unknown, as an expired contract such as
// NIFTY25NOV25FUT is on a real server (services/symbol_service.py:42-44).
//
// The list is the handwritten contracts below plus the option universe of options.mjs, which
// follows the clock: a Tuesday expiry leaves the master after 15:30 IST.
import { futureExpiries, optionExpiries, universeRows } from './options.mjs'

const equity = (symbol, name, token) => ({
  symbol,
  name,
  exchange: 'NSE',
  token,
  lotsize: 1,
  tick_size: 0.05,
  freeze_qty: 0,
  instrumenttype: 'EQ',
  expiry: '',
  strike: -1,
})
const index = (symbol, exchange, name, token) => ({
  symbol,
  name,
  exchange,
  token,
  lotsize: 1,
  tick_size: 0.05,
  freeze_qty: 0,
  instrumenttype: 'INDEX',
  expiry: '',
  strike: -1,
})
// NIFTY contracts: lot 65, freeze 1800 (database/qty_freeze_db.py); the expiry as the DB holds it.
const nifty = (symbol, brsymbol, token, o) => ({
  symbol,
  brsymbol,
  name: 'NIFTY',
  exchange: 'NFO',
  token,
  lotsize: 65,
  freeze_qty: 1800,
  expiry: '30-DEC-26',
  ...o,
})

const FIXED = [
  equity('RELIANCE', 'RELIANCE INDUSTRIES LTD', '2885'),
  equity('TCS', 'TATA CONSULTANCY SERV LT', '11536'),
  equity('INFY', 'INFOSYS LIMITED', '1594'),
  equity('HDFCBANK', 'HDFC BANK LTD', '1333'),
  equity('ICICIBANK', 'ICICI BANK LTD.', '4963'),
  equity('SBIN', 'STATE BANK OF INDIA', '3045'),
  equity('ITC', 'ITC LTD', '1660'),
  equity('M&M', 'MAHINDRA & MAHINDRA LTD', '2031'),
  equity('BAJAJ-AUTO', 'BAJAJ AUTO LIMITED', '16669'),
  nifty('NIFTY30DEC26FUT', 'NIFTY26DECFUT', '52218', {
    tick_size: 0.1,
    instrumenttype: 'FUT',
    strike: 0,
  }),
  nifty('NIFTY30DEC2624000CE', 'NIFTY26DEC24000CE', '52345', {
    tick_size: 0.05,
    instrumenttype: 'CE',
    strike: 24000,
  }),
  index('NIFTY', 'NSE_INDEX', 'NIFTY 50', '26000'),
  index('BANKNIFTY', 'NSE_INDEX', 'NIFTY BANK', '26009'),
  index('INDIAVIX', 'NSE_INDEX', 'INDIA VIX', '26017'),
  index('SENSEX', 'BSE_INDEX', 'SENSEX', '1'),
].map((i) => ({ brsymbol: i.symbol, brexchange: i.exchange, ...i }))

const CSV_COLUMNS = [
  'symbol',
  'brsymbol',
  'name',
  'exchange',
  'brexchange',
  'token',
  'expiry',
  'strike',
  'lotsize',
  'instrumenttype',
  'tick_size',
]
const SEARCH_LIMIT = 500 // services/search_service.py:49

// One master per set of listed expiries: a handful over a run, each a few thousand rows.
const masters = new Map()

/** The master at `nowMs`: the fixed contracts and the universe, each with an id. */
function master(nowMs) {
  const signature = [...optionExpiries(nowMs), ...futureExpiries(nowMs)].join()
  let m = masters.get(signature)
  if (!m) {
    const list = [...FIXED, ...universeRows(nowMs)].map((i, n) => ({ id: n + 1, ...i }))
    m = { list, byKey: new Map(list.map((i) => [`${i.exchange}:${i.symbol}`, i])) }
    masters.set(signature, m)
  }
  return m
}

/** The instrument (its fields are /symbol's data), or undefined when it is not listed. */
export function findInstrument(symbol, exchange, nowMs = Date.now()) {
  return master(nowMs).byKey.get(`${String(exchange).toUpperCase()}:${symbol}`)
}

/** /search: a prefix match on symbol or name, any case (services/search_service.py:60-73). */
export function searchInstruments(query, exchange) {
  const q = query.toUpperCase()
  return master(Date.now())
    .list.filter(
      (i) =>
        (!exchange || i.exchange === exchange) &&
        (i.symbol.startsWith(q) || i.name.toUpperCase().startsWith(q)),
    )
    .slice(0, SEARCH_LIMIT)
    .map(({ id: _, ...row }) => row)
}

/** The rows /instruments serves, one exchange or all (services/instruments_service.py). */
export function instrumentRows(exchange, nowMs = Date.now()) {
  return master(nowMs).list.filter((i) => !exchange || i.exchange === exchange)
}

const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** /instruments?format=csv: the 11 columns, as Python's csv.DictWriter writes them. */
export function instrumentsCsv(exchange, nowMs = Date.now()) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const i of instrumentRows(exchange, nowMs)) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(i[c])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
