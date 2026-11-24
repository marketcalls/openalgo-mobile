import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PROFILES } from './profiles.mjs'
import { startMockServer } from './server.mjs'
import { runMain } from './test-helpers.mjs'

const KEY = 'ab'.repeat(32)
const WRONG_KEY = 'cd'.repeat(32)
const HTML =
  '<!doctype html><html><head><title>OpenAlgo</title></head><body><div id="root"></div></body></html>'
const UNEXPECTED = { status: 'error', message: 'An unexpected error occurred' }
const INVALID_KEY = { status: 'error', message: 'Invalid openalgo apikey' }
const MISSING = ['Missing data for required field.']
const UNKNOWN = ['Unknown field.']

// A valid request body (without the key) for every endpoint the mock serves.
const BODIES = {
  ping: {},
  funds: {},
  search: { query: 'REL', exchange: 'NSE' },
  analyzer: {},
  'analyzer/toggle': { mode: true },
  quotes: { symbol: 'RELIANCE', exchange: 'NSE' },
  multiquotes: { symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }] },
  depth: { symbol: 'RELIANCE', exchange: 'NSE' },
  history: {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    interval: 'D',
    start_date: '2026-11-02',
    end_date: '2026-11-20',
  },
  optionchain: { underlying: 'NIFTY', exchange: 'NSE_INDEX', expiry_date: '30DEC26' },
  multioptiongreeks: { symbols: [{ symbol: 'NIFTY30DEC2624000CE', exchange: 'NFO' }] },
  'portfolio/backtest': {
    holdings: [{ symbol: 'RELIANCE', weight: 1 }],
    start_date: '2025-01-01',
    end_date: '2025-12-31',
  },
  'sip/backtest': {
    symbol: 'NIFTY',
    start_date: '2025-01-01',
    end_date: '2025-12-31',
    amount: 1000,
  },
  sectorrotation: {},
}
const ENDPOINTS = Object.keys(BODIES)

async function mock(t, o = {}) {
  const m = await startMockServer({ wsPort: 'off', ...o })
  t.after(() => m.close())
  return m
}

async function call(m, method, path, body, contentType = 'application/json') {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = contentType
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetch(m.origin + path, init)
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, json }
}

const post = (m, endpoint, body, contentType) =>
  call(m, 'POST', `/api/v1/${endpoint}`, body, contentType)
const withKey = (endpoint, apikey = KEY) => ({ apikey, ...BODIES[endpoint] })
const patchControl = (m, patch) => call(m, 'POST', '/__mock/control', patch)
/** Applies a control patch, which must be accepted. */
async function control(m, patch) {
  const r = await patchControl(m, patch)
  assert.equal(r.status, 200, `${JSON.stringify(patch)}: ${r.text}`)
  return r
}

function assertHtml(r, status) {
  assert.equal(r.status, status)
  assert.match(r.type, /^text\/html/)
  assert.equal(r.text, HTML)
}

// The answer each profile gives for an endpoint it does not have (S6).
function assertMissing(r, profile, path) {
  if (profile === '2.0.3.5') {
    assert.equal(r.status, 404)
    assert.deepEqual(r.json, { status: 'error', message: 'Not found', path })
  } else {
    assertHtml(r, profile === '1.0.0.41' ? 404 : 200)
  }
}

// --- Profile table: one test per column, ✓ and – rows alike ------------------

test('profiles are exactly the five table rows', () => {
  assert.deepEqual(Object.keys(PROFILES), ['1.0.0.41', '2.0.0.0', '2.0.1.6', '2.0.2.0', '2.0.3.5'])
})

test('column app-info: 404 html on 1.0.0.41, the version JSON from 2.0.0.0', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await call(m, 'GET', '/auth/app-info')
    if (profile === '1.0.0.41') assertHtml(r, 404)
    else {
      assert.equal(r.status, 200)
      assert.deepEqual(r.json, { status: 'success', version: profile, name: 'OpenAlgo' })
    }
  }
})

test('column missing endpoint: 404 html, then 200 html, then 404 JSON on 2.0.3.5', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await post(m, 'nosuchendpoint', { apikey: KEY })
    assertMissing(r, profile, '/api/v1/nosuchendpoint')
  }
})

test('column with_greeks: optionchain refuses the field before 2.0.2.0 (S7 third shape)', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await post(m, 'optionchain', { ...withKey('optionchain'), with_greeks: true })
    if (['2.0.2.0', '2.0.3.5'].includes(profile)) {
      assert.equal(r.status, 200)
      assert.equal(r.json.status, 'success')
    } else {
      assert.equal(r.status, 400)
      assert.deepEqual(r.json, {
        status: 'error',
        message: 'Validation error',
        errors: { with_greeks: UNKNOWN },
      })
    }
  }
})

test('column portfolio+sip: portfolio/backtest and sip/backtest exist from 2.0.2.0', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    for (const endpoint of ['portfolio/backtest', 'sip/backtest']) {
      const r = await post(m, endpoint, {})
      if (['2.0.2.0', '2.0.3.5'].includes(profile)) {
        assert.equal(r.status, 400)
        assert.equal(r.json.message.apikey[0], MISSING[0])
      } else assertMissing(r, profile, `/api/v1/${endpoint}`)
    }
  }
})

test('column sectorrotation: present on 2.0.3.5 only', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await post(m, 'sectorrotation', {})
    if (profile === '2.0.3.5') {
      assert.equal(r.status, 400)
      assert.equal(r.json.status, 'error')
    } else assertMissing(r, profile, '/api/v1/sectorrotation')
  }
})

test('from 2.0.0.0 every profile has multioptiongreeks and history.source', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const presence = await post(m, 'multioptiongreeks', {})
    const source = await post(m, 'history', { ...withKey('history'), source: 'db' })
    if (profile === '1.0.0.41') {
      assertHtml(presence, 404)
      assert.equal(source.status, 400)
      // S7 second shape
      assert.deepEqual(source.json, { status: 'error', message: { source: UNKNOWN } })
    } else {
      assert.equal(presence.status, 400)
      assert.equal(presence.json.message, 'Validation failed')
      assert.equal(source.status, 200)
      assert.equal(source.json.status, 'success')
    }
  }
})

test('swagger lists each profile’s endpoints in the S9 form', async (t) => {
  for (const profile of Object.keys(PROFILES)) {
    const m = await mock(t, { profile })
    const r = await call(m, 'GET', '/api/v1/swagger.json')
    assert.equal(r.status, 200)
    const keys = Object.keys(r.json.paths)
    assert.ok(keys.includes('/ping/'))
    assert.ok(keys.includes('/analyzer/toggle'))
    const ids = keys.map((k) => k.replace(/^\/+|\/+$/g, ''))
    for (const id of ids) assert.equal((await post(m, id, {})).status, 400, id)
    assert.equal(ids.includes('multioptiongreeks'), profile !== '1.0.0.41')
    assert.equal(ids.includes('portfolio/backtest'), ['2.0.2.0', '2.0.3.5'].includes(profile))
    assert.equal(ids.includes('sectorrotation'), profile === '2.0.3.5')
  }
})

// --- Errors -------------------------------------------------------------------

test('POST {} gets a 400 naming apikey, in each endpoint’s own shape', async (t) => {
  const m = await mock(t)
  assert.deepEqual((await post(m, 'ping', {})).json, {
    status: 'error',
    message: { apikey: MISSING },
  })
  assert.deepEqual((await post(m, 'analyzer', {})).json, {
    status: 'error',
    message: "{'apikey': ['Missing data for required field.']}",
  })
  const mog = await post(m, 'multioptiongreeks', {})
  assert.deepEqual(mog.json, {
    status: 'error',
    message: 'Validation failed',
    errors: { apikey: MISSING, symbols: MISSING },
  })
  for (const endpoint of ENDPOINTS) {
    const r = await post(m, endpoint, {})
    assert.equal(r.status, 400, endpoint)
    assert.equal(r.json.status, 'error', endpoint)
    if (endpoint !== 'sectorrotation') assert.match(JSON.stringify(r.json), /apikey/, endpoint)
  }
})

test('a POST without a JSON Content-Type gets the Flask 3.1 500', async (t) => {
  const m = await mock(t)
  for (const endpoint of ENDPOINTS) {
    const r = await post(m, endpoint, '{}', 'text/plain;charset=UTF-8')
    assert.equal(r.status, 500, endpoint)
    assert.deepEqual(r.json, UNEXPECTED, endpoint)
  }
  assert.equal((await post(m, 'ping', { apikey: KEY }, 'text/plain')).status, 500)
})

test('a wrong key gets 403 Invalid openalgo apikey (multioptiongreeks: 401)', async (t) => {
  const m = await mock(t)
  for (const endpoint of ENDPOINTS) {
    const r = await post(m, endpoint, withKey(endpoint, WRONG_KEY))
    // restx_api/multi_option_greeks.py:104-110 answers 401 for a bad key.
    assert.equal(r.status, endpoint === 'multioptiongreeks' ? 401 : 403, endpoint)
    assert.deepEqual(r.json, INVALID_KEY, endpoint)
  }
})

test('every endpoint answers a valid request with success', async (t) => {
  const m = await mock(t)
  for (const endpoint of ENDPOINTS) {
    const r = await post(m, endpoint, withKey(endpoint))
    assert.equal(r.status, 200, endpoint)
    assert.equal(r.json.status, 'success', endpoint)
  }
})

test('S7 unknown fields: an extra analyzer field and an extra multioptiongreeks field', async (t) => {
  const m = await mock(t)
  assert.deepEqual((await post(m, 'analyzer', { apikey: KEY, extra: 1 })).json, {
    status: 'error',
    message: "{'extra': ['Unknown field.']}",
  })
  const r = await post(m, 'multioptiongreeks', { ...withKey('multioptiongreeks'), extra: 1 })
  assert.equal(r.status, 400)
  assert.deepEqual(r.json, {
    status: 'error',
    message: 'Validation failed',
    errors: { extra: UNKNOWN },
  })
})

// --- Data ---------------------------------------------------------------------

test('multiquotes returns string prices, with an error entry for an unknown symbol', async (t) => {
  const m = await mock(t)
  const r = await post(m, 'multiquotes', {
    apikey: KEY,
    symbols: [
      { symbol: 'RELIANCE', exchange: 'NSE' },
      { symbol: 'NOT LISTED', exchange: 'NSE' },
    ],
  })
  assert.equal(r.status, 200)
  const [bad, good] = r.json.results
  assert.deepEqual(Object.keys(bad).sort(), ['error', 'exchange', 'symbol'])
  assert.equal(bad.symbol, 'NOT LISTED')
  assert.match(bad.error, /^Symbol 'NOT LISTED' not found for exchange 'NSE'/)
  assert.equal(good.symbol, 'RELIANCE')
  for (const f of ['ltp', 'open', 'high', 'low', 'prev_close', 'bid', 'ask']) {
    assert.match(good.data[f], /^\d+\.\d{2}$/, f)
  }
  const none = await post(m, 'multiquotes', {
    apikey: KEY,
    symbols: [{ symbol: 'NOT LISTED', exchange: 'NSE' }],
  })
  assert.equal(none.status, 400)
  assert.equal(none.json.status, 'error')
  assert.equal(none.json.invalid_symbols[0].symbol, 'NOT LISTED')
})

test('depth returns 5 bid and 5 ask levels around the LTP', async (t) => {
  const m = await mock(t)
  const { data } = (await post(m, 'depth', withKey('depth'))).json
  assert.equal(data.bids.length, 5)
  assert.equal(data.asks.length, 5)
  for (const level of [...data.bids, ...data.asks]) {
    assert.deepEqual(Object.keys(level).sort(), ['price', 'quantity'])
  }
  assert.ok(data.bids[0].price < data.asks[0].price)
  assert.ok(data.bids[0].price > data.bids[4].price)
})

test('funds, depth, multiquotes and analyzer carry the docs fixtures’ fields', async (t) => {
  const m = await mock(t)
  const fixture = (name) =>
    JSON.parse(
      readFileSync(new URL(`../../test/fixtures/openalgo-docs/${name}.json`, import.meta.url)),
    )
  const keys = (o) => Object.keys(o).sort()
  for (const name of ['funds', 'depth', 'analyzer-live']) {
    const endpoint = name.replace('-live', '')
    const r = await post(m, endpoint, withKey(endpoint))
    assert.ok(fixture(name)._source.startsWith('openalgo-docs/'))
    assert.deepEqual(keys(r.json.data), keys(fixture(name).data), name)
  }
  const mq = await post(m, 'multiquotes', withKey('multiquotes'))
  assert.deepEqual(keys(mq.json.results[0].data), keys(fixture('multiquotes').results[0].data))
  await control(m, { analyzer: true })
  const an = await post(m, 'analyzer', withKey('analyzer'))
  assert.equal(an.json.data.mode, fixture('analyzer-analyze').data.mode)
  assert.deepEqual(keys(an.json.data), keys(fixture('analyzer-analyze').data))
})

// --- Controls: one test per field ----------------------------------------------

test('control profile switches the emulated version', async (t) => {
  const m = await mock(t)
  await control(m, { profile: '2.0.0.0' })
  assert.equal((await call(m, 'GET', '/auth/app-info')).json.version, '2.0.0.0')
  assertMissing(await post(m, 'sectorrotation', {}), '2.0.0.0')
})

test('control brokerLoggedOut: 403 everywhere except search', async (t) => {
  const m = await mock(t)
  await control(m, { brokerLoggedOut: true })
  for (const endpoint of ENDPOINTS) {
    const r = await post(m, endpoint, withKey(endpoint))
    if (endpoint === 'search') assert.equal(r.status, 200)
    else {
      assert.equal(r.status, 403, endpoint)
      assert.deepEqual(r.json, INVALID_KEY, endpoint)
    }
  }
})

test('control semiAuto: analyzer/toggle still succeeds (the server bug, spec 5.9)', async (t) => {
  const m = await mock(t)
  assert.equal((await call(m, 'GET', '/__mock/control')).json.semiAuto, false)
  assert.equal((await control(m, { semiAuto: true })).json.semiAuto, true)
  const r = await post(m, 'analyzer/toggle', { apikey: KEY, mode: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.mode, 'analyze')
  assert.equal(r.json.data.message, 'Analyzer mode switched to analyze')
  assert.equal((await call(m, 'GET', '/__mock/control')).json.semiAuto, true)
})

test('control analyzer: sets the mode that analyzer reports and toggle changes', async (t) => {
  const m = await mock(t)
  await control(m, { analyzer: true })
  const on = await post(m, 'analyzer', { apikey: KEY })
  assert.deepEqual(on.json.data, { mode: 'analyze', analyze_mode: true, total_logs: 0 })
  const off = await post(m, 'analyzer/toggle', { apikey: KEY, mode: false })
  assert.equal(off.json.data.mode, 'live')
  assert.equal((await call(m, 'GET', '/__mock/control')).json.analyzer, false)
  const bad = await post(m, 'analyzer/toggle', { apikey: KEY, mode: 'analyze' })
  assert.deepEqual(bad.json, { status: 'error', message: "{'mode': ['Not a valid boolean.']}" })
})

test('control appInfo: false makes app-info answer as a missing route', async (t) => {
  const m = await mock(t)
  await control(m, { appInfo: false })
  assertHtml(await call(m, 'GET', '/auth/app-info'), 404)
  await control(m, { profile: '2.0.0.0' })
  assertHtml(await call(m, 'GET', '/auth/app-info'), 200)
})

test('control swagger: false makes swagger.json answer as a missing route', async (t) => {
  const m = await mock(t)
  await control(m, { swagger: false })
  assertMissing(await call(m, 'GET', '/api/v1/swagger.json'), '2.0.3.5', '/api/v1/swagger.json')
  await control(m, { profile: '2.0.2.0' })
  assertHtml(await call(m, 'GET', '/api/v1/swagger.json'), 200)
})

test('control banned: both S4 forms, and control keeps working while banned', async (t) => {
  const m = await mock(t)
  await control(m, { banned: 'text' })
  for (const r of [
    await post(m, 'funds', withKey('funds')),
    await call(m, 'GET', '/auth/app-info'),
  ]) {
    assert.equal(r.status, 403)
    assert.match(r.type, /^text\/plain/)
    assert.equal(r.text, 'Access Denied: Your IP has been banned')
  }
  assert.equal((await control(m, { banned: 'json' })).status, 200)
  const r = await post(m, 'funds', withKey('funds'))
  assert.equal(r.status, 403)
  assert.match(r.type, /^application\/json/)
  assert.deepEqual(r.json, { error: 'Access Denied' })
  assert.equal((await call(m, 'GET', '/__mock/control')).json.banned, 'json')
  await control(m, { banned: false })
  assert.equal((await post(m, 'funds', withKey('funds'))).status, 200)
})

test('control rateLimited: the three S5 shapes on /api/v1, swagger exempt', async (t) => {
  const m = await mock(t)
  await control(m, { rateLimited: 'restx' })
  const restx = await post(m, 'funds', withKey('funds'))
  assert.equal(restx.status, 429)
  assert.deepEqual(restx.json, { message: '10 per 1 second' })
  assert.equal((await call(m, 'GET', '/api/v1/swagger.json')).status, 200)
  await control(m, { rateLimited: 'busy' })
  const busy = await post(m, 'funds', withKey('funds'))
  assert.equal(busy.status, 429)
  assert.equal(busy.json.status, 'error')
  assert.match(busy.json.message, /pacing requests to stay within your broker's rate limit/)
  await control(m, { rateLimited: 'nginx' })
  const nginx = await post(m, 'funds', withKey('funds'))
  assert.equal(nginx.status, 429)
  assert.match(nginx.type, /^text\/html/)
  assert.match(nginx.text, /<title>429 Too Many Requests<\/title>[\s\S]*nginx/)
  await control(m, { rateLimited: false })
  assert.equal((await post(m, 'funds', withKey('funds'))).status, 200)
})

test('control failNext: the next request to that path gets the given answer, once', async (t) => {
  const m = await mock(t)
  await control(m, {
    failNext: {
      path: 'funds',
      status: 502,
      body: '<html>Bad gateway</html>',
      contentType: 'text/html',
    },
  })
  assert.equal((await post(m, 'ping', withKey('ping'))).status, 200)
  const failed = await post(m, 'funds', withKey('funds'))
  assert.equal(failed.status, 502)
  assert.match(failed.type, /^text\/html/)
  assert.equal(failed.text, '<html>Bad gateway</html>')
  assert.equal((await post(m, 'funds', withKey('funds'))).status, 200)
  await control(m, { failNext: { path: '/auth/app-info', status: 500, body: { status: 'error' } } })
  const json = await call(m, 'GET', '/auth/app-info')
  assert.equal(json.status, 500)
  assert.deepEqual(json.json, { status: 'error' })
  assert.equal((await call(m, 'GET', '/__mock/control')).json.failNext, null)
})

test('control rejects an unknown field or a bad value with 400', async (t) => {
  const m = await mock(t)
  for (const patch of [
    { nope: true },
    { profile: '9.9.9.9' },
    { banned: 'yes' },
    { rateLimited: true },
    { maxDepth: 10 },
    { absentFields: 'close' },
    { failNext: { status: 500 } },
    { closeSockets: 1005 },
  ]) {
    const r = await patchControl(m, patch)
    assert.equal(r.status, 400, JSON.stringify(patch))
    assert.equal(typeof r.json.error, 'string')
  }
  assert.equal((await call(m, 'GET', '/__mock/control')).json.profile, '2.0.3.5')
})

test('POST /__mock/reset restores the start state and clears the stats', async (t) => {
  const m = await mock(t, { profile: '2.0.2.0' })
  const initial = (await call(m, 'GET', '/__mock/control')).json
  await post(m, 'funds', withKey('funds'))
  await control(m, { profile: '2.0.3.5', banned: 'json', analyzer: true, maxDepth: 20 })
  await control(m, { failNext: { path: 'funds', status: 500, body: {} } })
  const reset = await call(m, 'POST', '/__mock/reset')
  assert.equal(reset.status, 200)
  assert.deepEqual(reset.json, initial)
  assert.deepEqual(initial.stats, { requests: {}, wsConnections: 0, wsAuthAttempts: 0 })
  assert.equal((await post(m, 'funds', withKey('funds'))).status, 200)
  assert.equal((await call(m, 'GET', '/auth/app-info')).json.version, '2.0.2.0')
})

// --- main.mjs ---------------------------------------------------------------------

test('main.mjs reads the env and prints MOCK_READY with a loopback origin', async (t) => {
  const off = await runMain(t, { PORT: '0', WS_PORT: 'off', HOST: '0.0.0.0' })
  const [, origin] = /^MOCK_READY rest=(http:\/\/127\.0\.0\.1:\d+) ws=off$/.exec(off) ?? []
  assert.ok(origin, off)
  assert.equal((await (await fetch(`${origin}/auth/app-info`)).json()).version, '2.0.3.5')

  const on = await runMain(t, {
    PORT: '0',
    WS_PORT: '0',
    HOST: '127.0.0.1',
    PROFILE: '2.0.0.0',
    MOCK_API_KEY: WRONG_KEY,
  })
  const [, origin2] =
    /^MOCK_READY rest=(http:\/\/127\.0\.0\.1:\d+) ws=ws:\/\/127\.0\.0\.1:\d+$/.exec(on) ?? []
  assert.ok(origin2, on)
  assert.equal((await (await fetch(`${origin2}/auth/app-info`)).json()).version, '2.0.0.0')
  const funds = await fetch(`${origin2}/api/v1/funds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: WRONG_KEY }),
  })
  assert.equal(funds.status, 200)
})
