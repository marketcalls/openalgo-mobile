// The option universe: expiries, the chain, the instruments CSV and the tool endpoints.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findInstrument, instrumentsCsv, searchInstruments } from './instruments.mjs'
import {
  chainBody,
  futureExpiries,
  OPTION_UNDERLYINGS,
  optionExpiries,
  premium,
} from './options.mjs'
import { createPriceBook } from './prices.mjs'
import { PROFILES } from './profiles.mjs'
import { call, KEY, mock, post } from './test-helpers.mjs'
import { SIP_FREQUENCIES, TEARSHEET_HTML } from './tools.mjs'

const IST = 19_800_000
// IST wall clock to epoch ms.
const ist = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - IST
const YEAR_MS = 365 * 86_400_000

// Friday 2026-11-27 11:00 IST: Tuesdays Dec 1, 8, 15; the monthly is Dec 29.
const NOW = ist(2026, 11, 27, 11)
const book = (nowMs = NOW) => createPriceBook({ now: () => nowMs })

test('a Tuesday at 16:00 IST lists next Tuesday first', () => {
  // 2026-12-01 is a Tuesday; the 15:30 cut-off has passed.
  assert.deepEqual(optionExpiries(ist(2026, 12, 1, 16)), [
    '08-DEC-26',
    '15-DEC-26',
    '22-DEC-26',
    '26-JAN-27',
  ])
  // Before the cut-off the day itself is still listed.
  assert.equal(optionExpiries(ist(2026, 12, 1, 15, 29))[0], '01-DEC-26')
  assert.equal(optionExpiries(ist(2026, 12, 1, 15, 30))[0], '08-DEC-26')
  // The weekly Tuesdays then the last Tuesday of next month, sorted and without a repeat.
  assert.deepEqual(optionExpiries(NOW), ['01-DEC-26', '08-DEC-26', '15-DEC-26', '29-DEC-26'])
  assert.deepEqual(optionExpiries(ist(2026, 12, 20, 9)), [
    '22-DEC-26',
    '29-DEC-26',
    '05-JAN-27',
    '26-JAN-27',
  ])
})

test('futures: the last Tuesday of this month, else next, and the two after', () => {
  assert.deepEqual(futureExpiries(NOW), ['29-DEC-26', '26-JAN-27', '23-FEB-27'])
  assert.deepEqual(futureExpiries(ist(2026, 11, 20, 9)), ['24-NOV-26', '29-DEC-26', '26-JAN-27'])
  assert.equal(futureExpiries(ist(2026, 11, 24, 16))[0], '29-DEC-26')
})

test('NIFTY strike_count 10 gives 21 strikes, ATM labelled, legs listed in the master', async () => {
  const [status, body] = chainBody(
    { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '01DEC26', strike_count: 10 },
    { prices: book(), version: PROFILES['2.0.3.5'], nowMs: NOW },
  )
  assert.equal(status, 200)
  assert.equal(body.chain.length, 21)
  const atm = body.chain[10]
  assert.equal(atm.strike, body.atm_strike)
  assert.equal(atm.ce.label, 'ATM')
  assert.equal(atm.pe.label, 'ATM')
  assert.equal(body.chain[7].ce.label, 'ITM3')
  assert.equal(body.chain[7].pe.label, 'OTM3')
  assert.equal(body.chain[13].ce.label, 'OTM3')
  assert.equal(body.chain[13].pe.label, 'ITM3')
  assert.deepEqual(Object.keys(atm.ce), [
    'symbol',
    'label',
    'ltp',
    'bid',
    'ask',
    'bid_qty',
    'ask_qty',
    'open',
    'high',
    'low',
    'prev_close',
    'volume',
    'oi',
    'lotsize',
    'tick_size',
  ])
  for (const row of body.chain) {
    for (const leg of [row.ce, row.pe]) {
      const i = findInstrument(leg.symbol, 'NFO', NOW)
      assert.ok(i, leg.symbol)
      assert.equal(i.lotsize, 65)
      assert.equal(leg.lotsize, 65)
      assert.equal(leg.oi % 65, 0)
      assert.equal(leg.volume % 65, 0)
    }
  }
  assert.equal(atm.ce.symbol, `NIFTY01DEC26${body.atm_strike}CE`)
})

test('the chain reports the quote identity as the underlying (index exchanges)', () => {
  const v = PROFILES['2.0.3.5']
  for (const [name, fo, exchange] of [
    ['NIFTY', 'NFO', 'NSE_INDEX'],
    ['BANKNIFTY', 'NFO', 'NSE_INDEX'],
    ['SENSEX', 'BFO', 'BSE_INDEX'],
  ]) {
    const [status, body] = chainBody(
      { underlying: name, exchange: fo, expiry_date: '01DEC26', strike_count: 2 },
      { prices: book(), version: v, nowMs: NOW },
    )
    assert.equal(status, 200, name)
    assert.equal(body.underlying, name)
    assert.equal(body.underlying_symbol, name)
    assert.equal(body.underlying_exchange, exchange)
    assert.equal(body.chain[0].ce.symbol.startsWith(name), true)
    assert.equal(OPTION_UNDERLYINGS[name].fo, fo)
  }
})

test('2.0.2.0+ chains carry expiry_ts at 15:30 IST, server_ts and no Greeks; older ones do not', () => {
  const args = { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '08DEC26', strike_count: 1 }
  const [, base] = chainBody(args, {
    prices: book(),
    version: PROFILES['2.0.0.0'],
    nowMs: NOW,
  })
  for (const f of ['expiry_ts', 'server_ts', 'forward_price', 'greeks_included']) {
    assert.equal(f in base, false, f)
  }
  const [, full] = chainBody(args, { prices: book(), version: PROFILES['2.0.2.0'], nowMs: NOW })
  assert.equal(full.expiry_ts, ist(2026, 12, 8, 15, 30) / 1000)
  assert.equal(full.server_ts, Math.floor(NOW / 1000))
  assert.equal(full.forward_price, null)
  assert.equal(full.greeks_included, false)
  assert.equal(full.expiry_date, '08DEC26')
})

test('an expiry that is not listed is a 404', () => {
  const [status, body] = chainBody(
    { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '30DEC26' },
    { prices: book(), version: PROFILES['2.0.3.5'], nowMs: NOW },
  )
  assert.equal(status, 404)
  assert.equal(body.status, 'error')
})

test('premiums keep put-call parity: K + C - P is within 0.1 of F at ATM', () => {
  for (const [name, expiry, tsSec] of [
    ['NIFTY', '01DEC26', ist(2026, 12, 1, 15, 30) / 1000],
    ['BANKNIFTY', '29DEC26', ist(2026, 12, 29, 15, 30) / 1000],
    ['SENSEX', '08DEC26', ist(2026, 12, 8, 15, 30) / 1000],
  ]) {
    const { fo } = OPTION_UNDERLYINGS[name]
    const [, body] = chainBody(
      { underlying: name, exchange: fo, expiry_date: expiry, strike_count: 3 },
      { prices: book(), version: PROFILES['2.0.3.5'], nowMs: NOW },
    )
    const years = (tsSec * 1000 - NOW) / YEAR_MS
    const F = body.underlying_ltp * (1 + 0.065 * years)
    const atm = body.chain.find((r) => r.strike === body.atm_strike)
    const implied = atm.strike + atm.ce.ltp - atm.pe.ltp
    assert.ok(Math.abs(implied - F) < 0.1, `${name}: ${implied} vs ${F}`)
  }
})

test('premium: Black-76 on a smile, tick 0.05, at least 0.05, intrinsic at expiry', () => {
  const F = 24_000
  const atm = premium({ F, K: 24_000, years: 7 / 365, type: 'CE' })
  assert.ok(atm > 100 && atm < 300, String(atm))
  assert.equal(Math.round(atm * 20) / 20, atm)
  assert.equal(premium({ F, K: 30_000, years: 7 / 365, type: 'CE' }), 0.05)
  assert.equal(premium({ F, K: 23_000, years: 0, type: 'CE' }), 1000)
  assert.equal(premium({ F, K: 23_000, years: 0, type: 'PE' }), 0.05)
  // a smile: the wings carry a higher volatility, so they are dearer than at 0.12
  const wing = premium({ F, K: 25_000, years: 30 / 365, type: 'CE' })
  assert.ok(wing > premium({ F, K: 24_500, years: 30 / 365, type: 'CE' }) - 400)
})

test('a leg bid is premium - 0.05 and its ask premium + 0.05, bid 0 at the minimum', () => {
  const [, body] = chainBody(
    { underlying: 'NIFTY', exchange: 'NFO', expiry_date: '01DEC26' },
    { prices: book(), version: PROFILES['2.0.3.5'], nowMs: NOW },
  )
  assert.equal(body.chain.length, 81)
  const near = body.chain[40].ce
  assert.equal(near.bid, Math.round((near.ltp - 0.05) * 100) / 100)
  assert.equal(near.ask, Math.round((near.ltp + 0.05) * 100) / 100)
  const far = body.chain[80].ce
  assert.equal(far.ltp, 0.05)
  assert.equal(far.bid, 0)
})

test('expiry options and futures for NIFTY; an unknown symbol is a 404', async (t) => {
  const m = await mock(t)
  const opts = await post(m, 'expiry', {
    symbol: 'NIFTY',
    exchange: 'NFO',
    instrumenttype: 'options',
  })
  assert.equal(opts.status, 200)
  assert.equal(opts.json.status, 'success')
  assert.deepEqual(opts.json.data, optionExpiries(Date.now()))
  const futs = await post(m, 'expiry', {
    symbol: 'NIFTY',
    exchange: 'NFO',
    instrumenttype: 'futures',
  })
  assert.deepEqual(futs.json.data, futureExpiries(Date.now()))
  assert.equal(
    (await post(m, 'expiry', { symbol: 'SENSEX', exchange: 'BFO', instrumenttype: 'options' }))
      .status,
    200,
  )
  const gone = await post(m, 'expiry', {
    symbol: 'NOSUCH',
    exchange: 'NFO',
    instrumenttype: 'options',
  })
  assert.equal(gone.status, 404)
  assert.deepEqual(gone.json, {
    status: 'error',
    message: 'No expiry dates found for NOSUCH in NFO',
  })
  const wrong = await post(m, 'expiry', {
    symbol: 'NIFTY',
    exchange: 'BFO',
    instrumenttype: 'options',
  })
  assert.equal(wrong.status, 404)
  const bad = await post(m, 'expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'swaps' })
  assert.equal(bad.status, 400)
})

test('instruments CSV has the 11 columns and every NFO option row', () => {
  const csv = instrumentsCsv('NFO', NOW)
  const lines = csv.split('\r\n').filter(Boolean)
  assert.equal(
    lines[0],
    'symbol,brsymbol,name,exchange,brexchange,token,expiry,strike,lotsize,instrumenttype,tick_size',
  )
  const rows = lines.slice(1).map((l) => l.split(','))
  for (const r of rows) {
    assert.equal(r.length, 11)
    assert.equal(r[3], 'NFO')
  }
  const expiries = optionExpiries(NOW)
  const options = rows.filter((r) => r[9] === 'CE' || r[9] === 'PE')
  // 81 strikes x CE and PE x the expiries x NIFTY and BANKNIFTY, plus the fixture contract
  assert.ok(options.length >= 81 * 2 * expiries.length * 2)
  assert.ok(
    rows.some((r) => r[0] === 'NIFTY01DEC2624000CE' && r[6] === '01-DEC-26' && r[7] === '24000'),
  )
  assert.equal(rows.filter((r) => r[9] === 'FUT' && r[2] === 'NIFTY').length >= 3, true)
  assert.equal(new Set(rows.map((r) => r[5])).size, rows.length, 'tokens are unique')
  assert.equal(instrumentsCsv('BFO', NOW).includes('SENSEX08DEC2679000CE'), true)
  assert.equal(instrumentsCsv('BFO', NOW).includes('NIFTY'), false)
})

test('the universe joins the master: search, symbol, quotes, multiquotes and depth', async (t) => {
  const m = await mock(t)
  const sym = `NIFTY${optionExpiries(Date.now())[0].replaceAll('-', '')}24000CE`
  assert.ok(searchInstruments('NIFTY', 'NFO').some((i) => i.symbol === sym))
  assert.equal((await post(m, 'symbol', { symbol: sym, exchange: 'NFO' })).json.data.lotsize, 65)
  assert.equal((await post(m, 'quotes', { symbol: sym, exchange: 'NFO' })).status, 200)
  const multi = await post(m, 'multiquotes', {
    symbols: [{ symbol: sym, exchange: 'NFO' }],
  })
  assert.equal(multi.json.results[0].data.ltp !== undefined, true)
  assert.equal((await post(m, 'depth', { symbol: sym, exchange: 'NFO' })).status, 200)
})

test('a leg quote and a WS Depth ack succeed', async (t) => {
  const { default: WebSocket } = await import('ws')
  const m = await mock(t, { wsPort: 0 })
  const sym = `NIFTY${optionExpiries(Date.now())[0].replaceAll('-', '')}24000CE`
  const q = await post(m, 'quotes', { symbol: sym, exchange: 'NFO' })
  assert.equal(q.status, 200)
  assert.equal(q.json.status, 'success')
  const ws = new WebSocket(m.wsUrl)
  t.after(() => ws.close())
  const next = () =>
    new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))))
  await new Promise((resolve) => ws.once('open', resolve))
  ws.send(JSON.stringify({ action: 'authenticate', api_key: KEY }))
  assert.equal((await next()).status, 'success')
  ws.send(
    JSON.stringify({
      action: 'subscribe',
      mode: 3,
      depth: 5,
      symbols: [{ symbol: sym, exchange: 'NFO' }],
    }),
  )
  const ack = await next()
  assert.equal(ack.type, 'subscribe')
  assert.equal(ack.status, 'success')
  assert.equal(ack.subscriptions[0].status, 'success')
})

test('instruments GET: csv on every profile, key checked, format and exchange validated', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await call(m, 'GET', `/api/v1/instruments?apikey=${KEY}&exchange=NFO&format=csv`)
    assert.equal(r.status, 200, profile)
    assert.match(r.text, /^symbol,brsymbol,name,exchange,brexchange,token,expiry,strike,/)
  }
  const m = await mock(t)
  const csv = await fetch(`${m.origin}/api/v1/instruments?apikey=${KEY}&exchange=NSE&format=csv`)
  assert.match(csv.headers.get('content-type'), /^text\/csv/)
  assert.match(csv.headers.get('content-disposition'), /instruments_NSE\.csv/)
  assert.equal((await call(m, 'GET', '/api/v1/instruments?apikey=bad&format=csv')).status, 403)
  const missing = await call(m, 'GET', '/api/v1/instruments?format=csv')
  assert.equal(missing.status, 400)
  assert.equal((await call(m, 'GET', `/api/v1/instruments?apikey=${KEY}&format=xml`)).status, 400)
  assert.equal(
    (await call(m, 'GET', `/api/v1/instruments?apikey=${KEY}&exchange=XXX&format=csv`)).status,
    400,
  )
  const json = await call(m, 'GET', `/api/v1/instruments?apikey=${KEY}&exchange=NSE_INDEX`)
  assert.equal(json.json.status, 'success')
  assert.equal(json.json.data.length, 3)
})

test('2.0.0.0 serves no portfolio GETs and no with_greeks fields; 2.0.3.5 serves both', async (t) => {
  const gets = [
    `/api/v1/portfolio/benchmarks?apikey=${KEY}`,
    '/api/v1/sip/frequencies',
    '/api/v1/sectorrotation/options',
  ]
  const old = await mock(t, { profile: '2.0.0.0' })
  for (const path of gets) {
    const r = await call(old, 'GET', path)
    assert.equal(r.status, 200)
    assert.match(r.text, /<div id="root">/, path)
  }
  const oldChain = await post(old, 'optionchain', {
    underlying: 'NIFTY',
    exchange: 'NFO',
    expiry_date: optionExpiries(Date.now())[0].replaceAll('-', ''),
    strike_count: 1,
  })
  assert.equal(oldChain.json.status, 'success')
  assert.equal('expiry_ts' in oldChain.json, false)
  const withGreeks = await post(old, 'optionchain', {
    underlying: 'NIFTY',
    exchange: 'NFO',
    expiry_date: '01DEC26',
    with_greeks: true,
  })
  assert.equal(withGreeks.status, 400)

  const cur = await mock(t, { profile: '2.0.3.5' })
  const bench = await call(cur, 'GET', gets[0])
  assert.equal(bench.json.status, 'success')
  assert.ok(bench.json.data.some((b) => b.symbol === 'NIFTY' && b.exchange === 'NSE_INDEX'))
  assert.equal((await call(cur, 'GET', '/api/v1/portfolio/benchmarks?apikey=bad')).status, 403)
  assert.equal((await call(cur, 'GET', '/api/v1/portfolio/benchmarks')).status, 403)
  const freq = await call(cur, 'GET', gets[1])
  assert.deepEqual(freq.json, { status: 'success', data: SIP_FREQUENCIES })
  const rot = await call(cur, 'GET', gets[2])
  assert.equal(rot.json.data.max_tail, 30)
  assert.ok(rot.json.data.sectors.length > 0)

  // 2.0.2.0 has the portfolio routes but not the rotation ones
  const mid = await mock(t, { profile: '2.0.2.0' })
  assert.equal((await call(mid, 'GET', gets[1])).json.status, 'success')
  assert.match((await call(mid, 'GET', gets[2])).text, /<div id="root">/)
  const chain = await post(cur, 'optionchain', {
    underlying: 'NIFTY',
    exchange: 'NFO',
    expiry_date: optionExpiries(Date.now())[0].replaceAll('-', ''),
    strike_count: 1,
  })
  assert.equal(chain.json.forward_price, null)
  assert.equal(typeof chain.json.expiry_ts, 'number')
})

test('the POST tool endpoints: tearsheet as an HTML attachment, holdings and the replies', async (t) => {
  const m = await mock(t)
  const sheet = await fetch(`${m.origin}/api/v1/portfolio/tearsheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: KEY,
      holdings: [{ symbol: 'RELIANCE', weight: 1 }],
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    }),
  })
  assert.equal(sheet.status, 200)
  assert.match(sheet.headers.get('content-type'), /^text\/html/)
  assert.match(sheet.headers.get('content-disposition'), /portfolio-tearsheet\.html/)
  assert.equal(await sheet.text(), TEARSHEET_HTML)

  const holdings = await post(m, 'portfolio/holdings', {})
  assert.equal(holdings.status, 200)
  assert.equal(holdings.json.status, 'success')
  assert.equal(holdings.json.analysis, null)
  assert.deepEqual(holdings.json.skipped, [])
  assert.equal(typeof holdings.json.meta.basis, 'string')

  const bt = await post(m, 'portfolio/backtest', {
    holdings: [{ symbol: 'RELIANCE', weight: 1 }],
    start_date: '2025-01-01',
    end_date: '2025-12-31',
  })
  assert.equal(bt.json.status, 'success')
  assert.deepEqual(bt.json.meta.symbols, ['RELIANCE'])
  assert.deepEqual(bt.json.equity, [])
  const sip = await post(m, 'sip/backtest', {
    symbol: 'NIFTY',
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    amount: 1000,
  })
  assert.equal(sip.json.status, 'success')
  assert.deepEqual(sip.json.curves, { value: [], invested: [] })
  const rot = await post(m, 'sectorrotation', {})
  assert.equal(rot.json.status, 'success')
  assert.deepEqual(rot.json.data.instruments, [])
})

test('a GET route refuses a POST with 405', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'instruments', {})
  assert.equal(r.status, 405)
})
