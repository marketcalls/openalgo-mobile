// Plan F's mock: leg history with open interest, the futures universe and basket orders.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { futureExpiries, optionExpiries } from './options.mjs'
import { call, control, mock, post } from './test-helpers.mjs'
import { FUTURES_UNIVERSE, legHistory } from './toolsF.mjs'

const IST = 19_800_000
const ist = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST
const istClock = (ts) => new Date(ts * 1000 + IST).toISOString().slice(11, 16)
const istDate = (ts) => new Date(ts * 1000 + IST).toISOString().slice(0, 10)

// Friday 2026-11-27 11:00 IST.
const NOW = ist(2026, 11, 27, 11)
const FUT = `NIFTY${futureExpiries(NOW)[0].replaceAll('-', '')}FUT`
const OPT = `NIFTY${optionExpiries(NOW)[1].replaceAll('-', '')}24000CE`
const range = { start_date: '2026-11-16', end_date: '2026-11-20' } // Monday to Friday, past

const leg = (o = {}) => ({
  exchange: 'NFO',
  symbol: OPT,
  action: 'BUY',
  quantity: 65,
  product: 'NRML',
  pricetype: 'MARKET',
  ...o,
})
const basket = (orders, o = {}) => ({ strategy: 'mobile', orders, ...o })
const book = async (m) => (await post(m, 'orderbook')).json.data.orders

test('a 5m NIFTY FUT history over 5 weekdays has 75 candles a day and no weekend rows', () => {
  const rows = legHistory(
    {
      symbol: FUT,
      exchange: 'NFO',
      interval: '5m',
      start_date: '2026-11-14',
      end_date: '2026-11-22',
    },
    { nowMs: NOW },
  )
  // Saturday the 14th and Sunday the 15th and 21st-22nd carry nothing.
  assert.equal(rows.length, 75 * 5)
  const days = new Set(rows.map((r) => istDate(r.timestamp)))
  assert.deepEqual(
    [...days],
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'],
  )
  assert.equal(istClock(rows[0].timestamp), '09:15')
  assert.equal(istClock(rows[74].timestamp), '15:25')
  assert.ok(rows.every((r, i) => i === 0 || r.timestamp > rows[i - 1].timestamp))
  for (const r of rows)
    assert.ok(r.high >= Math.max(r.open, r.close) && r.low <= Math.min(r.open, r.close))
  assert.deepEqual(
    legHistory({ symbol: FUT, exchange: 'NFO', interval: '5m', ...range }, { nowMs: NOW }),
    rows,
  )
})

test('1m and 15m candles run 09:15 to 15:29 and stop at now', () => {
  const day = { ...range, end_date: range.start_date }
  const one = legHistory({ symbol: FUT, exchange: 'NFO', interval: '1m', ...day }, { nowMs: NOW })
  assert.equal(one.length, 375)
  assert.equal(istClock(one.at(-1).timestamp), '15:29')
  const fifteen = legHistory(
    { symbol: FUT, exchange: 'NFO', interval: '15m', ...day },
    { nowMs: NOW },
  )
  assert.equal(fifteen.length, 25)
  const today = legHistory(
    {
      symbol: FUT,
      exchange: 'NFO',
      interval: '15m',
      start_date: '2026-11-27',
      end_date: '2026-11-27',
    },
    { nowMs: NOW },
  )
  assert.equal(istClock(today.at(-1).timestamp), '11:00')
})

test("daily option history includes today's row after 09:15 IST, and every row has oi", async (t) => {
  const body = {
    symbol: OPT,
    exchange: 'NFO',
    interval: 'D',
    start_date: '2026-11-23',
    end_date: '2026-11-27',
  }
  const before = legHistory(body, { nowMs: ist(2026, 11, 27, 9, 14) })
  assert.equal(before.length, 4)
  const after = legHistory(body, { nowMs: ist(2026, 11, 27, 9, 15) })
  assert.equal(after.length, 5)
  assert.equal(istDate(after.at(-1).timestamp), '2026-11-27')
  for (const r of after) {
    assert.ok(Number.isInteger(r.oi) && r.oi > 0)
    assert.equal(r.oi % 65, 0, 'whole lots')
  }
  assert.equal(new Set(after.map((r) => r.oi)).size, 5, 'a hash of symbol and date')
  // The option's close is its Black-76 premium on the walk, so it stays a positive tick.
  assert.ok(after.every((r) => r.close >= 0.05 && Number.isInteger(Math.round(r.close * 20))))
  // Through the endpoint: 2.0.3.5 serves it and the mock's clock is the real one.
  const m = await mock(t)
  const r = await post(m, 'history', { ...body, start_date: '2026-11-16', end_date: '2026-11-20' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.data.length, 5)
  assert.ok(r.json.data.every((x) => x.oi > 0))
})

test('basketorder places each leg once, lists SELL legs first, and the order book gains both', async (t) => {
  const m = await mock(t)
  const sell = leg({
    symbol: `NIFTY${optionExpiries(Date.now())[1].replaceAll('-', '')}24000PE`,
    action: 'SELL',
  })
  const buy = leg()
  const r = await post(m, 'basketorder', basket([buy, sell]))
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.status, 'success')
  assert.equal(r.json.mode, undefined)
  assert.deepEqual(
    r.json.results.map((x) => x.symbol),
    [sell.symbol, buy.symbol],
  )
  for (const x of r.json.results) {
    assert.equal(x.status, 'success')
    assert.equal(x.exchange, 'NFO')
    assert.equal(x.product, 'NRML')
    assert.match(x.orderid, /^\d{6}\d{9}$/)
  }
  const orders = await book(m)
  assert.equal(orders.length, 2)
  assert.deepEqual(
    orders.map((o) => o.orderid),
    r.json.results.map((x) => x.orderid),
  )
  assert.deepEqual(
    orders.map((o) => o.action),
    ['SELL', 'BUY'],
  )
  await control(m, { analyzer: true })
  const a = await post(m, 'basketorder', basket([buy]))
  assert.equal(a.json.mode, 'analyze')
  assert.equal((await book(m)).length, 3)
})

test('basketFail fails that leg only; basketStall books the legs and answers 502', async (t) => {
  const m = await mock(t)
  const other = leg({ symbol: OPT.replace('24000', '24050'), action: 'SELL' })
  await control(m, { basketFail: OPT })
  const r = await post(m, 'basketorder', basket([leg(), other]))
  assert.equal(r.status, 200)
  assert.deepEqual(
    r.json.results.map((x) => x.status),
    ['success', 'error'],
  )
  assert.deepEqual(r.json.results[1], {
    symbol: OPT,
    status: 'error',
    message: 'Insufficient funds',
  })
  assert.equal((await book(m)).length, 1)

  await control(m, { basketFail: null, basketStall: true })
  const t0 = Date.now()
  const stalled = await post(m, 'basketorder', basket([leg(), other]))
  assert.equal(stalled.status, 502)
  assert.ok(Date.now() - t0 >= 1900, 'answers after about 2 s')
  assert.equal((await book(m)).length, 3, 'the legs were booked')
})

test('semiAuto queues the basket; every profile serves basketorder', async (t) => {
  const m = await mock(t)
  await control(m, { semiAuto: true })
  const r = await post(m, 'basketorder', basket([leg()]))
  assert.deepEqual(r.json, {
    status: 'success',
    message: 'Order queued for approval in Action Center',
    mode: 'semi_auto',
    pending_order_id: 1,
  })
  assert.equal((await book(m)).length, 0)
  for (const profile of ['1.0.0.41', '2.0.0.0', '2.0.1.6', '2.0.2.0', '2.0.3.5']) {
    const p = await mock(t, { profile })
    const ok = await post(
      p,
      'basketorder',
      basket([leg({ exchange: 'NSE', symbol: 'RELIANCE', quantity: 1 })]),
    )
    assert.equal(ok.status, 200, `${profile}: ${ok.text}`)
    assert.equal(ok.json.results[0].status, 'success')
  }
  const refused = await post(m, 'basketorder', basket([]))
  assert.equal(refused.status, 400)
  assert.match(refused.json.message, /Orders must contain at least 1 item/)
  const swagger = (await call(m, 'GET', '/api/v1/swagger.json')).json
  assert.ok('/basketorder/' in swagger.paths)
})

test('the NFO and MCX instruments CSVs list 3 FUT for every universe name', async (t) => {
  const m = await mock(t)
  const expiries = futureExpiries(Date.now())
  for (const [exchange, names] of Object.entries(FUTURES_UNIVERSE)) {
    const res = await fetch(
      `${m.origin}/api/v1/instruments?apikey=${'ab'.repeat(32)}&exchange=${exchange}&format=csv`,
    )
    const lines = (await res.text()).trim().split('\r\n')
    const head = lines[0].split(',')
    const rows = lines
      .slice(1)
      .map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])))
    const symbols = rows.map((r) => r.symbol)
    assert.equal(new Set(symbols).size, symbols.length, `${exchange}: every symbol once`)
    for (const name of names) {
      const futs = rows.filter(
        (r) => r.name === name && r.instrumenttype === 'FUT' && expiries.includes(r.expiry),
      )
      assert.equal(futs.length, 3, `${exchange} ${name}`)
    }
  }
  const lots = { RELIANCE: 500, INFY: 400, SBIN: 750, CRUDEOIL: 100, GOLD: 1 }
  for (const [name, lot] of Object.entries(lots)) {
    const exchange = name === 'CRUDEOIL' || name === 'GOLD' ? 'MCX' : 'NFO'
    const symbol = `${name}${expiries[0].replaceAll('-', '')}FUT`
    const s = await post(m, 'symbol', { symbol, exchange })
    assert.equal(s.json.data.lotsize, lot, symbol)
    assert.equal(s.json.data.tick_size, exchange === 'MCX' ? 1 : 0.05)
    const q = await post(m, 'quotes', { symbol, exchange })
    assert.equal(q.status, 200, symbol)
    assert.equal((await post(m, 'depth', { symbol, exchange })).status, 200)
    const mq = await post(m, 'multiquotes', { symbols: [{ symbol, exchange }] })
    assert.equal(mq.json.results[0].symbol, symbol)
    const found = await post(m, 'search', { query: symbol, exchange })
    assert.equal(found.json.data.length, 1)
  }
})
