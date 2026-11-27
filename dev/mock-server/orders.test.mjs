// The trading side of the mock (plan contract C1-C7): instruments, the four books, the order
// engine, Semi-Auto, the failure controls and order events.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import WebSocket from 'ws'
import { startMockServer } from './server.mjs'
import { call, control, KEY, mock, post, runMain, stats, within } from './test-helpers.mjs'

const MISSING = ['Missing data for required field.']
const NOT_LISTED = (symbol, exchange) =>
  `Symbol '${symbol}' not found for exchange '${exchange}'. ` +
  'Please verify the symbol name and ensure master contracts are downloaded.'
const OLD_EXCHANGES = 'NSE, NFO, CDS, BSE, BFO, BCD, MCX, NCDEX, NSE_INDEX, BSE_INDEX'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const order = (o = {}) => ({
  strategy: 'mobile',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  pricetype: 'MARKET',
  product: 'MIS',
  price: 0,
  trigger_price: 0,
  disclosed_quantity: 0,
  ...o,
})
// C3: the smart order that closes one position.
const closeOne = (o = {}) => ({
  strategy: 'mobile',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  product: 'MIS',
  action: 'SELL',
  quantity: '0',
  position_size: '0',
  pricetype: 'MARKET',
  price: '0',
  trigger_price: '0',
  disclosed_quantity: '0',
  ...o,
})
const split = (o = {}) => ({ ...order({ quantity: 105 }), splitsize: 20, ...o })

async function place(m, o) {
  const r = await post(m, 'placeorder', order(o))
  assert.equal(r.status, 200, r.text)
  return r.json.orderid
}
const orderbook = async (m) => (await post(m, 'orderbook')).json.data
const orders = async (m) => (await orderbook(m)).orders
const orderById = async (m, id) => (await orders(m)).find((o) => o.orderid === id)
const positions = async (m) => (await post(m, 'positionbook')).json.data
const position = async (m, symbol = 'RELIANCE', product = 'MIS') =>
  (await positions(m)).find((p) => p.symbol === symbol && p.product === product)

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/openalgo-docs/${name}.json`, import.meta.url)),
  )
// Every field the docs show is there, with the docs' type (strings where the docs use them).
function assertShaped(actual, docs, what) {
  for (const [k, v] of Object.entries(docs)) {
    if (k === '_source') continue
    assert.ok(actual && k in actual, `${what}.${k} is missing`)
    assert.equal(typeof actual[k], typeof v, `${what}.${k}`)
  }
}

// A WS client that buffers frames; next() consumes frames up to the first match.
function openFeed(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const buffer = []
    let wake = () => {}
    ws.on('message', (raw) => {
      buffer.push(JSON.parse(raw.toString()))
      wake()
    })
    const c = {
      buffer,
      send: (o) => ws.send(JSON.stringify(o)),
      async next(pred, ms = 2000) {
        const deadline = Date.now() + ms
        for (;;) {
          const i = buffer.findIndex(pred)
          if (i >= 0) return buffer.splice(0, i + 1)[i]
          if (Date.now() >= deadline) throw new Error(`no matching frame within ${ms} ms`)
          await new Promise((r) => {
            const timer = setTimeout(r, deadline - Date.now())
            wake = () => {
              clearTimeout(timer)
              r()
            }
          })
        }
      },
      /** Every frame sent before this one has arrived once it resolves. */
      barrier() {
        c.send({ action: 'barrier' })
        return c.next((f) => f.message === 'Invalid action: barrier')
      },
    }
    ws.once('open', () => resolve(c))
    ws.once('error', reject)
  })
}

async function authedFeed(m) {
  const c = await openFeed(m.wsUrl)
  c.send({ action: 'authenticate', api_key: KEY })
  const auth = await c.next((f) => f.type === 'auth' || f.status === 'error')
  assert.equal(auth.status, 'success', JSON.stringify(auth))
  return { c, auth }
}

// --- Instruments (C1, C2; RF 1) -----------------------------------------------------

test('symbol returns the C1 metadata for an NSE and an NFO instrument', async (t) => {
  const m = await mock(t)
  const nse = await post(m, 'symbol', { symbol: 'RELIANCE', exchange: 'NSE' })
  assert.equal(nse.status, 200)
  assert.equal(nse.json.status, 'success')
  assert.deepEqual(
    [nse.json.data.lotsize, nse.json.data.tick_size, nse.json.data.freeze_qty],
    [1, 0.05, 0],
  )
  const fut = (await post(m, 'symbol', { symbol: 'NIFTY30DEC26FUT', exchange: 'NFO' })).json.data
  assert.deepEqual(
    [fut.lotsize, fut.tick_size, fut.freeze_qty, fut.instrumenttype, fut.name],
    [65, 0.1, 1800, 'FUT', 'NIFTY'],
  )
  const ce = (await post(m, 'symbol', { symbol: 'NIFTY30DEC2624000CE', exchange: 'NFO' })).json.data
  assert.deepEqual([ce.lotsize, ce.tick_size, ce.freeze_qty, ce.strike], [65, 0.05, 1800, 24000])
  for (const [symbol, exchange] of [
    ['ITC', 'NSE'],
    ['M&M', 'NSE'],
    ['BAJAJ-AUTO', 'NSE'],
    ['BANKNIFTY', 'NSE_INDEX'],
    ['INDIAVIX', 'NSE_INDEX'],
    ['SENSEX', 'BSE_INDEX'],
  ]) {
    assert.equal((await post(m, 'symbol', { symbol, exchange })).status, 200, symbol)
  }
})

test('an expired contract gets the C1 404 and the quotes, depth, history and multiquotes 400s', async (t) => {
  const m = await mock(t)
  const gone = { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO' }
  const sym = await post(m, 'symbol', gone)
  assert.equal(sym.status, 404)
  assert.deepEqual(sym.json, {
    status: 'error',
    message: 'Symbol NIFTY25NOV25FUT not found in exchange NFO',
  })
  const error = NOT_LISTED('NIFTY25NOV25FUT', 'NFO')
  const mq = await post(m, 'multiquotes', { symbols: [gone] })
  assert.equal(mq.status, 400)
  assert.deepEqual(mq.json, {
    status: 'error',
    message: error,
    invalid_symbols: [{ ...gone, error }],
  })
  for (const endpoint of ['quotes', 'depth']) {
    const r = await post(m, endpoint, gone)
    assert.equal(r.status, 400, endpoint)
    assert.deepEqual(r.json, { status: 'error', message: error }, endpoint)
  }
  // History runs the same master-contract check (services/history_service.py:56-80,132-134).
  const range = { interval: 'D', start_date: '2026-11-02', end_date: '2026-11-20' }
  const history = await post(m, 'history', { ...gone, ...range })
  assert.equal(history.status, 400)
  assert.deepEqual(history.json, { status: 'error', message: error })
  // A listed contract beside it still gets its quote.
  const mixed = await post(m, 'multiquotes', {
    symbols: [gone, { symbol: 'NIFTY30DEC26FUT', exchange: 'NFO' }],
  })
  assert.equal(mixed.status, 200)
  assert.deepEqual(
    mixed.json.results.map((r) => [r.symbol, 'error' in r]),
    [
      ['NIFTY25NOV25FUT', true],
      ['NIFTY30DEC26FUT', false],
    ],
  )
})

test('the WS ack refuses an unlisted symbol, and no ticks come for it', async (t) => {
  const m = await startMockServer({ rate: 200 })
  t.after(() => m.close())
  const { c } = await authedFeed(m)
  c.send({
    action: 'subscribe',
    mode: 2,
    symbols: [
      { symbol: 'NIFTY25NOV25FUT', exchange: 'NFO' },
      { symbol: 'RELIANCE', exchange: 'NSE' },
    ],
  })
  const ack = await c.next((f) => f.type === 'subscribe')
  assert.equal(ack.status, 'partial')
  const [bad, good] = ack.subscriptions
  assert.deepEqual(bad, {
    symbol: 'NIFTY25NOV25FUT',
    exchange: 'NFO',
    status: 'error',
    message: 'Token not found for NIFTY25NOV25FUT on NFO',
    broker: 'zerodha',
  })
  assert.equal(good.status, 'success')
  await sleep(150)
  const ticks = c.buffer.filter((f) => f.type === 'market_data')
  assert.ok(ticks.length > 0)
  assert.ok(ticks.every((f) => f.symbol === 'RELIANCE'))
})

test('search is a prefix match on symbol or name, with the instrument fields', async (t) => {
  const m = await mock(t)
  const nifty = (await post(m, 'search', { query: 'nifty' })).json.data
  // The fixed contracts come first, then the option universe (options.test.mjs); 500 at most.
  assert.equal(nifty.length, 500)
  assert.deepEqual(
    nifty
      .slice(0, 4)
      .map((r) => `${r.exchange}:${r.symbol}`)
      .sort(),
    [
      'NFO:NIFTY30DEC2624000CE',
      'NFO:NIFTY30DEC26FUT',
      'NSE_INDEX:BANKNIFTY', // its name is NIFTY BANK
      'NSE_INDEX:NIFTY',
    ],
  )
  const nfo = (await post(m, 'search', { query: 'NIFTY30DEC', exchange: 'NFO' })).json.data
  assert.equal(nfo.length, 2)
  assert.deepEqual([nfo[0].lotsize, nfo[0].freeze_qty], [65, 1800])
  const byName = (await post(m, 'search', { query: 'Mahindra' })).json.data
  assert.deepEqual(
    byName.map((r) => r.symbol),
    ['M&M'],
  )
  const none = await post(m, 'search', { query: 'ZZZ' })
  assert.deepEqual(none.json, { status: 'success', message: 'No matching symbols found', data: [] })
})

test('an exchange outside the profile’s C2 set gets a 400 (search, symbol, placeorder)', async (t) => {
  const old = await mock(t, { profile: '2.0.0.0' })
  const r = await post(old, 'search', { query: 'BTC', exchange: 'CRYPTO' })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, {
    status: 'error',
    message: { exchange: [`Must be one of: ${OLD_EXCHANGES}.`] },
  })
  const sym = await post(old, 'symbol', { symbol: 'BTCUSDT', exchange: 'NCO' })
  assert.equal(sym.status, 400)
  const ord = await post(old, 'placeorder', order({ exchange: 'MCX_INDEX' }))
  assert.equal(ord.status, 400)
  assert.equal(ord.json.status, 'error')

  const now = await mock(t)
  const crypto = await post(now, 'search', { query: 'BTC', exchange: 'CRYPTO' })
  assert.equal(crypto.status, 200)
  assert.deepEqual(crypto.json.data, [])
  const nope = await post(now, 'placeorder', order({ exchange: 'NOPE' }))
  assert.equal(
    nope.json.message,
    "{'exchange': ['Must be one of: NSE, NFO, CDS, BSE, BFO, BCD, MCX, NCDEX, NCO, NSE_INDEX, " +
      "BSE_INDEX, MCX_INDEX, GLOBAL_INDEX, CRYPTO.']}",
  )
})

// --- Books and the engine (C6) ------------------------------------------------------

test('MARKET fills at once: a complete order, a trade and a position at the mock price', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'placeorder', order())
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.json).sort(), ['orderid', 'status'])
  assert.match(r.json.orderid, /^\d{15}$/)
  const book = await orderbook(m)
  const [row] = book.orders
  assert.equal(row.orderid, r.json.orderid)
  assert.equal(row.order_status, 'complete')
  assert.equal(row.quantity, '10')
  assert.match(row.timestamp, /^\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2}$/)
  assert.equal(book.statistics.total_buy_orders, 1)
  assert.equal(book.statistics.total_completed_orders, 1)
  const [trade] = (await post(m, 'tradebook')).json.data
  assert.equal(trade.orderid, r.json.orderid)
  assert.equal(trade.quantity, 10)
  assert.match(trade.timestamp, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(trade.trade_value, Math.round(trade.average_price * 1000) / 100)
  assert.equal(row.price, trade.average_price)
  const pos = await position(m)
  assert.equal(pos.quantity, '10')
  assert.equal(Number(pos.average_price), trade.average_price)
  assert.match(pos.pnl, /^-?\d+\.\d{2}$/)
})

test('LIMIT stays open and SL/SL-M trigger pending until fillWorking fills them', async (t) => {
  const m = await mock(t)
  const limit = await place(m, { pricetype: 'LIMIT', price: 100, quantity: 1 })
  const sl = await place(m, { pricetype: 'SL', price: 105, trigger_price: 104, quantity: 1 })
  const slm = await place(m, { pricetype: 'SL-M', trigger_price: 103, quantity: 1 })
  assert.equal((await orderById(m, limit)).order_status, 'open')
  assert.equal((await orderById(m, sl)).order_status, 'trigger pending')
  assert.equal((await orderById(m, slm)).order_status, 'trigger pending')
  assert.deepEqual((await stats(m)).orders, { open: 1, 'trigger pending': 2 })
  assert.equal((await orderbook(m)).statistics.total_open_orders, 3)
  assert.deepEqual((await post(m, 'tradebook')).json.data, [])

  await control(m, { fillWorking: true })
  assert.deepEqual((await stats(m)).orders, { complete: 3 })
  const fills = (await post(m, 'tradebook')).json.data.map((x) => [x.orderid, x.average_price])
  assert.deepEqual(fills, [
    [limit, 100],
    [sl, 105],
    [slm, 103],
  ])
  const pos = await position(m)
  assert.equal(pos.quantity, '3')
  assert.equal(pos.average_price, '102.67')
})

test('positions net per (exchange, symbol, product); a closed one stays listed at 0', async (t) => {
  const m = await mock(t)
  await place(m, { pricetype: 'LIMIT', price: 100 })
  await place(m, { pricetype: 'LIMIT', price: 110 })
  await place(m, { product: 'CNC', quantity: 5 })
  await control(m, { fillWorking: true })
  assert.equal((await position(m)).average_price, '105.0')
  await place(m, { action: 'SELL', pricetype: 'LIMIT', price: 120, quantity: 5 })
  await control(m, { fillWorking: true })
  const mis = await position(m)
  assert.equal(mis.quantity, '15')
  assert.equal(mis.average_price, '105.0')
  // Realized (120 - 105) x 5, plus the open 15 at the LTP.
  const pnl = 75 + (Number(mis.ltp) - 105) * 15
  assert.equal(mis.pnl, (Math.round(pnl * 100) / 100).toFixed(2))
  assert.equal((await position(m, 'RELIANCE', 'CNC')).quantity, '5')

  await place(m, { action: 'SELL', pricetype: 'LIMIT', price: 120, quantity: 15 })
  await control(m, { fillWorking: true })
  const flat = await position(m)
  assert.deepEqual([flat.quantity, flat.average_price, flat.pnl], ['0', '0.0', '300.00'])
  assert.equal((await positions(m)).length, 2)
})

test('holdings are seeded with RELIANCE 10 @ 1300 and TCS 5 @ 3500 (CNC)', async (t) => {
  const m = await mock(t)
  const { holdings, statistics } = (await post(m, 'holdings')).json.data
  assert.deepEqual(
    holdings.map((h) => [h.symbol, h.exchange, h.product, h.quantity, h.average_price]),
    [
      ['RELIANCE', 'NSE', 'CNC', 10, 1300],
      ['TCS', 'NSE', 'CNC', 5, 3500],
    ],
  )
  const [rel] = holdings
  assert.equal(rel.pnl, Math.round((rel.ltp - 1300) * 10 * 100) / 100)
  assert.equal(statistics.totalinvvalue, 30500)
})

test('the books and replies carry the docs fixtures’ fields, with their types', async (t) => {
  const m = await mock(t)
  await place(m)
  await place(m, { pricetype: 'LIMIT', price: 100 })
  const book = await orderbook(m)
  assertShaped(book.orders[0], fixture('orderbook').data.orders[0], 'orderbook')
  assertShaped(book.statistics, fixture('orderbook').data.statistics, 'orderbook.statistics')
  const trades = (await post(m, 'tradebook')).json.data
  assertShaped(trades[0], fixture('tradebook').data[0], 'tradebook')
  assertShaped((await positions(m))[0], fixture('positionbook').data[0], 'positionbook')
  const hold = (await post(m, 'holdings')).json.data
  assertShaped(hold.holdings[0], fixture('holdings').data.holdings[0], 'holdings')
  assertShaped(hold.statistics, fixture('holdings').data.statistics, 'holdings.statistics')
  const nse = (await post(m, 'symbol', { symbol: 'RELIANCE', exchange: 'NSE' })).json
  assertShaped(nse.data, fixture('symbol-nse').data, 'symbol-nse')
  const nfo = (await post(m, 'symbol', { symbol: 'NIFTY30DEC26FUT', exchange: 'NFO' })).json
  assertShaped(nfo.data, fixture('symbol-nfo').data, 'symbol-nfo')
  const sp = (await post(m, 'splitorder', split())).json
  assertShaped(sp, fixture('splitorder'), 'splitorder')
  assertShaped(sp.results[0], fixture('splitorder').results[0], 'splitorder.results')
  const margin = await post(m, 'margin', {
    positions: [
      {
        symbol: 'NIFTY30DEC26FUT',
        exchange: 'NFO',
        action: 'BUY',
        product: 'NRML',
        pricetype: 'MARKET',
        quantity: '65',
      },
    ],
  })
  assertShaped(margin.json.data, fixture('margin').data, 'margin')
  assertShaped(
    (await post(m, 'cancelallorder', { strategy: 'mobile' })).json,
    fixture('cancelallorder'),
    'cancelallorder',
  )
  assertShaped(
    (await post(m, 'closeposition', { strategy: 'mobile' })).json,
    fixture('closeposition'),
    'closeposition',
  )
  await control(m, { analyzer: true })
  await place(m, { pricetype: 'LIMIT', price: 100 })
  assertShaped(
    (await post(m, 'cancelallorder', { strategy: 'mobile' })).json,
    fixture('cancelallorder-analyze'),
    'cancelallorder-analyze',
  )
  for (const name of [
    'orderbook',
    'tradebook',
    'positionbook',
    'holdings',
    'symbol-nse',
    'symbol-nfo',
    'splitorder',
    'margin',
    'cancelallorder',
    'cancelallorder-partial',
    'cancelallorder-analyze',
    'closeposition',
  ]) {
    assert.ok(fixture(name)._source.startsWith('openalgo-docs/'), name)
  }
})

test('analyzer mode adds mode:"analyze" to order replies and books', async (t) => {
  const m = await mock(t)
  await control(m, { analyzer: true })
  const r = await post(m, 'placeorder', order())
  assert.equal(r.json.mode, 'analyze')
  for (const book of ['orderbook', 'tradebook', 'positionbook', 'holdings']) {
    assert.equal((await post(m, book)).json.mode, 'analyze', book)
  }
  await control(m, { analyzer: false })
  assert.equal('mode' in (await post(m, 'orderbook')).json, false)
})

// --- Smart close, split, modify, cancel (C3, C4) --------------------------------------

test('smart close: long 10 sends one SELL 10 and leaves a row at 0; flat answers per mode', async (t) => {
  const m = await mock(t)
  await place(m)
  const r = await post(m, 'placesmartorder', closeOne())
  assert.equal(r.status, 200)
  assert.match(r.json.orderid, /^\d{15}$/)
  const sell = await orderById(m, r.json.orderid)
  assert.deepEqual(
    [sell.action, sell.quantity, sell.order_status, sell.product],
    ['SELL', '10', 'complete', 'MIS'],
  )
  assert.equal((await orders(m)).length, 2)
  assert.equal((await position(m)).quantity, '0')

  const flat = await post(m, 'placesmartorder', closeOne())
  assert.equal(flat.status, 200)
  assert.deepEqual(flat.json, {
    status: 'success',
    message: 'Positions Already Matched. No Action needed.',
  })
  await control(m, { analyzer: true })
  const sandbox = await post(m, 'placesmartorder', closeOne())
  assert.deepEqual(sandbox.json, {
    status: 'success',
    message: 'No OpenPosition Found. Not placing Exit order.',
    mode: 'analyze',
  })
  await control(m, { analyzer: false, flatCloseError: true })
  const broken = await post(m, 'placesmartorder', closeOne())
  assert.equal(broken.status, 500)
  assert.deepEqual(broken.json, { status: 'error', message: 'No position to square off' })
  assert.equal((await orders(m)).length, 2)
})

test('split: 105 by 20 is 20 x 5 and 5; 2,001 by 20 is a 400; splitFailFrom fails the rest', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'splitorder', split())
  assert.equal(r.status, 200)
  assert.equal(r.json.status, 'success')
  assert.equal(r.json.total_quantity, 105)
  assert.equal(r.json.split_size, 20)
  assert.deepEqual(
    r.json.results.map((c) => [c.order_num, c.quantity, c.status]),
    [1, 2, 3, 4, 5, 6].map((n) => [n, n === 6 ? 5 : 20, 'success']),
  )
  assert.equal((await orders(m)).length, 6)

  const big = await post(m, 'splitorder', split({ quantity: 2001 }))
  assert.equal(big.status, 400)
  assert.deepEqual(big.json, {
    status: 'error',
    message: 'Total number of orders would exceed maximum limit of 100',
  })
  assert.equal((await orders(m)).length, 6)

  await control(m, { splitFailFrom: 4 })
  const part = await post(m, 'splitorder', split())
  assert.equal(part.json.status, 'success')
  assert.deepEqual(
    part.json.results.map((c) => c.status),
    ['success', 'success', 'success', 'error', 'error', 'error'],
  )
  for (const c of part.json.results.slice(3)) {
    assert.equal(typeof c.message, 'string')
    assert.equal('orderid' in c, false)
  }
  assert.equal((await orders(m)).length, 9)
})

test('modify needs all 12 fields, and changes the price in the book', async (t) => {
  const m = await mock(t)
  const id = await place(m, { pricetype: 'LIMIT', price: 100 })
  const all = {
    orderid: id,
    strategy: 'mobile',
    symbol: 'RELIANCE',
    action: 'BUY',
    exchange: 'NSE',
    pricetype: 'LIMIT',
    product: 'MIS',
    quantity: 10,
    price: 101,
    trigger_price: 0,
    disclosed_quantity: 0,
  }
  const { disclosed_quantity: _, ...short } = all
  const missing = await post(m, 'modifyorder', short)
  assert.equal(missing.status, 400)
  assert.deepEqual(missing.json, {
    status: 'error',
    message: "{'disclosed_quantity': ['Missing data for required field.']}",
  })
  const r = await post(m, 'modifyorder', all)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { status: 'success', orderid: id })
  const row = await orderById(m, id)
  assert.deepEqual([row.price, row.order_status], [101, 'open'])
  // lastBody keeps what was sent, without the key.
  assert.deepEqual((await stats(m)).lastBody.modifyorder, all)

  await control(m, { analyzer: true })
  const sandbox = await post(m, 'modifyorder', { ...all, price: 102 })
  assert.deepEqual(sandbox.json, {
    status: 'success',
    orderid: id,
    message: 'Order modified successfully',
    mode: 'analyze',
  })
})

test('cancel: a working order is cancelled once; unknown and finished orders are refused', async (t) => {
  const m = await mock(t)
  const id = await place(m, { pricetype: 'LIMIT', price: 100 })
  const r = await post(m, 'cancelorder', { orderid: id, strategy: 'mobile' })
  assert.deepEqual(r.json, { status: 'success', orderid: id })
  assert.equal((await orderById(m, id)).order_status, 'cancelled')
  const again = await post(m, 'cancelorder', { orderid: id, strategy: 'mobile' })
  assert.equal(again.status, 400)
  assert.equal(again.json.message, 'Cannot cancel order in cancelled status')
  const unknown = await post(m, 'cancelorder', { orderid: '1', strategy: 'mobile' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.message, 'Order 1 not found')
})

test('cancel all with 2 open cancels both; close all squares off every position', async (t) => {
  const m = await mock(t)
  const a = await place(m, { pricetype: 'LIMIT', price: 100 })
  const b = await place(m, { pricetype: 'SL-M', trigger_price: 90, action: 'SELL' })
  await place(m)
  const r = await post(m, 'cancelallorder', { strategy: 'mobile' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.canceled_orders.sort(), [a, b].sort())
  assert.deepEqual(r.json.failed_cancellations, [])
  assert.equal(r.json.message, 'Canceled 2 orders. Failed to cancel 0 orders.')
  assert.deepEqual((await stats(m)).orders, { cancelled: 2, complete: 1 })

  await place(m, { symbol: 'TCS', action: 'SELL', quantity: 3, product: 'NRML' })
  const close = await post(m, 'closeposition', { strategy: 'mobile' })
  assert.deepEqual(close.json, { status: 'success', message: 'All Open Positions Squared Off' })
  assert.deepEqual(
    (await positions(m)).map((p) => [p.symbol, p.quantity]),
    [
      ['RELIANCE', '0'],
      ['TCS', '0'],
    ],
  )
  await control(m, { analyzer: true })
  const none = await post(m, 'closeposition', { strategy: 'mobile' })
  assert.deepEqual(none.json, {
    status: 'success',
    message: 'No open positions to close',
    mode: 'analyze',
  })
  const bulkExtra = await post(m, 'cancelallorder', { strategy: 'mobile', orderid: a })
  assert.equal(bulkExtra.status, 400)
  assert.equal(bulkExtra.json.message, "{'orderid': ['Unknown field.']}")
})

// --- Semi-Auto (C4, C5) -----------------------------------------------------------------

test('Semi-Auto: place, smart and split are queued; live writes on orders get the C5 403s', async (t) => {
  const m = await mock(t)
  const id = await place(m, { pricetype: 'LIMIT', price: 100 })
  await control(m, { semiAuto: true })
  const queued = (n) => ({
    status: 'success',
    message: 'Order queued for approval in Action Center',
    mode: 'semi_auto',
    pending_order_id: n,
  })
  assert.deepEqual((await post(m, 'placeorder', order())).json, queued(1))
  assert.deepEqual((await post(m, 'placesmartorder', closeOne())).json, queued(2))
  assert.deepEqual((await post(m, 'splitorder', split())).json, queued(3))
  assert.equal((await orders(m)).length, 1)

  const refusals = {
    modifyorder: [
      {
        orderid: id,
        strategy: 'mobile',
        symbol: 'RELIANCE',
        action: 'BUY',
        exchange: 'NSE',
        pricetype: 'LIMIT',
        product: 'MIS',
        quantity: 10,
        price: 101,
        trigger_price: 0,
        disclosed_quantity: 0,
      },
      'Modify order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to modify orders.',
    ],
    cancelorder: [
      { orderid: id, strategy: 'mobile' },
      'Cancel order operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.',
    ],
    cancelallorder: [
      { strategy: 'mobile' },
      'Cancel all orders operation is not allowed in Semi-Auto mode. Please switch to Auto mode to cancel orders.',
    ],
    closeposition: [
      { strategy: 'mobile' },
      'Close position operation is not allowed in Semi-Auto mode. Please switch to Auto mode to close positions.',
    ],
  }
  for (const [endpoint, [body, message]] of Object.entries(refusals)) {
    const r = await post(m, endpoint, body)
    assert.equal(r.status, 403, endpoint)
    assert.deepEqual(r.json, { status: 'error', message }, endpoint)
  }
  assert.equal((await orderById(m, id)).order_status, 'open')

  await control(m, { analyzer: true })
  const close = await post(m, 'closeposition', { strategy: 'mobile' })
  assert.equal(close.status, 200)
  assert.equal(close.json.status, 'success')
  assert.deepEqual((await post(m, 'placeorder', order())).json, queued(4))
  assert.equal((await post(m, 'cancelorder', { orderid: id, strategy: 'mobile' })).status, 200)
})

// --- Validation (marshmallow, C3) ------------------------------------------------------

test('validation: a missing field, an unknown field and the margin string fields', async (t) => {
  const m = await mock(t)
  const { strategy: _, ...noStrategy } = order()
  const missing = await post(m, 'placeorder', noStrategy)
  assert.equal(missing.status, 400)
  assert.deepEqual(missing.json, {
    status: 'error',
    message: "{'strategy': ['Missing data for required field.']}",
  })
  const extra = await post(m, 'placeorder', order({ tag: 'x' }))
  assert.equal(extra.status, 400)
  assert.deepEqual(extra.json, { status: 'error', message: "{'tag': ['Unknown field.']}" })
  const leg = {
    symbol: 'NIFTY30DEC26FUT',
    exchange: 'NFO',
    action: 'BUY',
    product: 'NRML',
    pricetype: 'LIMIT',
    quantity: '65',
    price: 24117.3,
  }
  const numeric = await post(m, 'margin', { positions: [leg] })
  assert.equal(numeric.status, 400)
  assert.deepEqual(numeric.json, {
    status: 'error',
    message: "{'positions': {0: {'price': ['Not a valid string.']}}}",
  })
  const empty = await post(m, 'margin', { positions: [] })
  assert.equal(empty.json.message, "{'positions': ['Positions must contain 1 to 50 items.']}")
  const books = await post(m, 'orderbook', { extra: 1 })
  assert.equal(books.status, 400)
  assert.deepEqual(books.json, { status: 'error', message: { extra: ['Unknown field.'] } })
  assert.deepEqual((await post(m, 'symbol', { symbol: 'RELIANCE' })).json, {
    status: 'error',
    message: { exchange: MISSING },
  })
})

test('quantity 1.5: 2.0.0.0 truncates it to 1 and refuses "1.5"; 2.0.3.5 refuses it', async (t) => {
  const old = await mock(t, { profile: '2.0.0.0' })
  const id = await place(old, { quantity: 1.5 })
  assert.equal((await orderById(old, id)).quantity, '1')
  const text = await post(old, 'placeorder', order({ quantity: '1.5' }))
  assert.equal(text.status, 400)
  assert.equal(text.json.message, "{'quantity': ['Not a valid integer.']}")

  const now = await mock(t)
  const r = await post(now, 'placeorder', order({ quantity: 1.5 }))
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, {
    status: 'error',
    message: "{'quantity': ['Fractional quantity (1.5) is not allowed for non-crypto exchanges.']}",
  })
  assert.equal((await post(now, 'placeorder', order({ quantity: '2' }))).status, 200)
  assert.deepEqual(await orders(now).then((o) => o.map((x) => x.quantity)), ['2'])
})

test('margin answers the docs shape, and 501 with marginUnsupported', async (t) => {
  const m = await mock(t)
  const leg = {
    symbol: 'NIFTY30DEC26FUT',
    exchange: 'NFO',
    action: 'BUY',
    product: 'NRML',
    pricetype: 'LIMIT',
    quantity: '65',
    price: '24000',
  }
  const r = await post(m, 'margin', { positions: [leg] })
  assert.equal(r.status, 200)
  assert.equal(r.json.status, 'success')
  assert.ok(r.json.data.total_margin_required > 0)
  const bad = await post(m, 'margin', { positions: [{ ...leg, quantity: 'ten' }] })
  assert.equal(bad.status, 400)
  assert.deepEqual(bad.json, { status: 'error', message: 'Position 1: Invalid quantity format' })
  await control(m, { marginUnsupported: true })
  const none = await post(m, 'margin', { positions: [leg] })
  assert.equal(none.status, 501)
  assert.deepEqual(none.json, {
    status: 'error',
    message: 'Margin calculation not implemented for broker: zerodha',
  })
})

// --- Failure controls -------------------------------------------------------------------

test('failNext afterApply answers the failure with the order in the book; without it, no order', async (t) => {
  const m = await mock(t)
  await control(m, { failNext: { path: 'placeorder', status: 502, afterApply: true } })
  const r = await post(m, 'placeorder', order())
  assert.equal(r.status, 502)
  assert.equal((await orders(m)).length, 1)
  await control(m, {
    failNext: { path: 'placeorder', status: 502, body: '<html>Bad gateway</html>' },
  })
  assert.equal((await post(m, 'placeorder', order())).status, 502)
  assert.equal((await orders(m)).length, 1)
  assert.equal((await post(m, 'placeorder', order())).status, 200)
  assert.equal((await orders(m)).length, 2)
})

test('delayNext delays the answer; afterApply books the order before the answer', async (t) => {
  const m = await mock(t)
  await control(m, { delayNext: { path: 'placeorder', ms: 300, afterApply: true } })
  const started = Date.now()
  const pending = post(m, 'placeorder', order())
  await sleep(100)
  assert.equal((await orders(m)).length, 1)
  const r = await pending
  assert.equal(r.status, 200)
  assert.ok(Date.now() - started >= 300, `${Date.now() - started} ms`)
  assert.equal((await call(m, 'GET', '/__mock/control')).json.delayNext, null)

  await control(m, { delayNext: { path: 'placeorder', ms: 300 } })
  const later = post(m, 'placeorder', order())
  await sleep(100)
  assert.equal((await orders(m)).length, 1)
  assert.equal((await later).status, 200)
  assert.equal((await orders(m)).length, 2)
})

// --- Order events (C7) ------------------------------------------------------------------

test('every order change sends an order_update to subscribe_orders subscribers', async (t) => {
  const m = await startMockServer({ rate: 200 })
  t.after(() => m.close())
  const { c } = await authedFeed(m)
  c.send({ action: 'subscribe_orders' })
  await c.next((f) => f.type === 'subscribe_orders')
  const id = await place(m, { pricetype: 'LIMIT', price: 100 })
  const placed = await c.next((f) => f.type === 'order_update')
  assert.deepEqual(
    [placed.orderid, placed.order_status, placed.mode, placed.broker, placed.quantity],
    [id, 'open', 'live', 'zerodha', 10],
  )
  await post(m, 'cancelorder', { orderid: id, strategy: 'mobile' })
  assert.equal((await c.next((f) => f.type === 'order_update')).order_status, 'cancelled')
  await control(m, { analyzer: true })
  const market = await place(m)
  const filled = await c.next((f) => f.type === 'order_update')
  assert.deepEqual(
    [filled.orderid, filled.order_status, filled.mode],
    [market, 'complete', 'analyze'],
  )
})

test('no order_update with orderEvents:false, and none on profile 2.0.0.0', async (t) => {
  for (const [profile, patch] of [
    ['2.0.3.5', { orderEvents: false }],
    ['2.0.0.0', {}],
  ]) {
    const m = await startMockServer({ rate: 200, profile })
    t.after(() => m.close())
    await control(m, patch)
    const { c } = await authedFeed(m)
    c.send({ action: 'subscribe_orders' })
    await c.next((f) => f.type === 'subscribe_orders' || f.code === 'INVALID_ACTION')
    await place(m)
    await control(m, { fillWorking: true })
    await c.barrier()
    assert.equal(
      c.buffer.some((f) => f.type === 'order_update'),
      false,
      profile,
    )
  }
})

// --- Controls --------------------------------------------------------------------------

test('control broker names the broker in ping and the WS auth', async (t) => {
  const m = await startMockServer({ rate: 200 })
  t.after(() => m.close())
  assert.equal((await post(m, 'ping')).json.data.broker, 'zerodha')
  await control(m, { broker: 'dhan' })
  assert.equal((await post(m, 'ping')).json.data.broker, 'dhan')
  const { auth } = await authedFeed(m)
  assert.equal(auth.broker, 'dhan')
})

test('main.mjs reads BROKER, and /__mock/reset keeps it', async (t) => {
  const ready = await runMain(t, { PORT: '0', WS_PORT: 'off', BROKER: 'dhan' })
  const origin = /rest=(\S+)/.exec(ready)[1]
  const ping = async () =>
    (
      await (
        await fetch(`${origin}/api/v1/ping`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apikey: KEY }),
        })
      ).json()
    ).data.broker
  assert.equal(await ping(), 'dhan')
  await fetch(`${origin}/__mock/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ broker: 'angel' }),
  })
  assert.equal(await ping(), 'angel')
  await fetch(`${origin}/__mock/reset`, { method: 'POST' })
  assert.equal(await ping(), 'dhan')
})

test('stats count orders by status and keep each path’s last body without the key', async (t) => {
  const m = await mock(t)
  await place(m)
  await place(m, { pricetype: 'LIMIT', price: 100 })
  const s = await stats(m)
  assert.deepEqual(s.orders, { complete: 1, open: 1 })
  assert.deepEqual(s.lastBody.placeorder, order({ pricetype: 'LIMIT', price: 100 }))
  assert.deepEqual(Object.keys(s.lastBody), ['placeorder'])
  assert.equal(JSON.stringify(s.lastBody).includes(KEY), false)
})

test('/__mock/reset empties the books, reseeds holdings and restarts the ids', async (t) => {
  const m = await mock(t)
  await control(m, { semiAuto: true })
  await post(m, 'placeorder', order())
  await control(m, { semiAuto: false })
  await place(m)
  await call(m, 'POST', '/__mock/reset')
  assert.deepEqual(await orders(m), [])
  assert.deepEqual((await post(m, 'tradebook')).json.data, [])
  assert.deepEqual(await positions(m), [])
  assert.equal((await post(m, 'holdings')).json.data.holdings.length, 2)
  assert.deepEqual((await stats(m)).orders, {})
  await control(m, { semiAuto: true })
  assert.equal((await post(m, 'placeorder', order())).json.pending_order_id, 1)
})

test('the new controls refuse bad values with 400', async (t) => {
  const m = await mock(t)
  for (const patch of [
    { broker: '' },
    { broker: 'Zerodha!' },
    { orderEvents: 'no' },
    { delayNext: { path: 'placeorder' } },
    { delayNext: { path: 'placeorder', ms: -1 } },
    { delayNext: { path: 'placeorder', ms: 10, afterApply: 'yes' } },
    { failNext: { path: 'placeorder', status: 502, afterApply: 1 } },
    { flatCloseError: 1 },
    { splitFailFrom: 0 },
    { splitFailFrom: 1.5 },
    { marginUnsupported: 'yes' },
    { fillWorking: false },
  ]) {
    const r = await call(m, 'POST', '/__mock/control', patch)
    assert.equal(r.status, 400, JSON.stringify(patch))
    assert.equal(typeof r.json.error, 'string')
  }
  const s = await control(m, { splitFailFrom: null, delayNext: null, fillWorking: true })
  assert.deepEqual(
    [s.broker, s.orderEvents, s.flatCloseError, s.marginUnsupported, s.splitFailFrom, s.delayNext],
    ['zerodha', true, false, false, null, null],
  )
  assert.equal('fillWorking' in s, false)
})

test('a delayed answer does not outlive the mock', async (t) => {
  const m = await mock(t)
  await control(m, { delayNext: { path: 'ping', ms: 60_000 } })
  const pending = post(m, 'ping').catch((e) => e)
  await sleep(50)
  await within(m.close(), 2000, 'close')
  assert.ok((await within(pending, 2000, 'the delayed request')) instanceof Error)
})
