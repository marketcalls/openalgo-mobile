import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KEY, runMain } from '../dev/mock-server/test-helpers.mjs'
import {
  CASES,
  CHAIN_COUNTS,
  chainCall,
  recordedCalls,
  requestKey,
  stableJson,
} from './lib/golden-keys.mjs'
import {
  contextF,
  F_PARAMS,
  NotRecorded,
  parseInstrumentsRows,
  recordedCallsF,
  referenceOf,
  servedChain,
  servedHistory,
  wantedStrikes,
} from './lib/golden-record-f.mjs'
import { loadTestEnv } from './lib/test-env.mjs'
import { mockOriginRefusal } from './record-fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const RECORD = join(root, 'scripts/record-fixtures.mjs')
const GEN = join(root, 'scripts/gen-golden.mjs')
const HARNESS = join(root, 'scripts/golden/harness.py')
const INPUTS = join(root, 'test/golden/inputs')
const EXPECTED = join(root, 'test/golden/expected')
const ROUTES = [
  'get_oi_data',
  'calculate_max_pain',
  'get_iv_smile_data',
  'get_gex_data',
  'calculate_gamma_density',
]
/** Plan F's routes in the expected files, in order (scripts/golden/harness.py). */
const ROUTES_F = [
  'get_strike_profile',
  'get_strike_profile_all',
  'get_vol_surface_data',
  'get_iv_chart_data',
  'get_oi_profile_data',
  'get_straddle_chart_data',
  'get_custom_straddle_simulation',
  'get_strategy_chart_data',
  'get_multi_strike_oi_data',
  'get_arbitrage_universe',
]
const LEAK = /api_?key/i
const IST_MS = 19_800_000
/** The server's expiry cut-offs (option_greeks_service.py EXCHANGE_EXPIRY_TIMES), IST. */
const CUTOFF = { MCX: [23, 30], CDS: [12, 30] }
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** A DD-MMM-YY expiry's instant on `exchange`, epoch ms. */
const expiryMs = (dashed, exchange) => {
  const [dd, mmm, yy] = dashed.split('-')
  const [hour, minute] = CUTOFF[exchange] ?? [15, 30]
  return Date.UTC(2000 + Number(yy), MONTHS.indexOf(mmm), Number(dd), hour, minute) - IST_MS
}
const compact = (d) => d.replaceAll('-', '')
const ladder = (from, step, n) => Array.from({ length: n }, (_, i) => from + i * step)

/** A scratch folder, removed after the test `t`. */
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Runs a script with node; resolves with its exit code and output, never rejects. */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    )
  })
}

const mockOrigin = async (t) => {
  const ready = await runMain(t, {
    PORT: '0',
    WS_PORT: 'off',
    HOST: '127.0.0.1',
    PROFILE: '2.0.3.5',
  })
  return /rest=(\S+)/.exec(ready)[1]
}

// The app's stableJson, loaded from TypeScript: relative imports from a .ts file take .ts.
registerHooks({
  resolve(specifier, context, next) {
    const bare = specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)
    return bare && context.parentURL?.endsWith('.ts')
      ? next(`${specifier}.ts`, context)
      : next(specifier, context)
  },
  load(url, context, next) {
    return next(url, url.endsWith('.ts') ? { ...context, format: 'module-typescript' } : context)
  },
})

test('requestKey drops apikey and sorts keys', async () => {
  const body = {
    underlying: 'NIFTY',
    strike_count: 23,
    expiry_date: '02DEC26',
    exchange: 'NFO',
    apikey: KEY,
  }
  assert.equal(
    requestKey('optionchain', body),
    'optionchain {"exchange":"NFO","expiry_date":"02DEC26","strike_count":23,"underlying":"NIFTY"}',
  )
  assert.equal(
    requestKey('quotes', { symbol: 'X', exchange: 'NFO' }),
    requestKey('quotes', { exchange: 'NFO', symbol: 'X' }),
  )
  // the TS fake Api keys its answers with the app's own stableJson (src/core/http/api.ts)
  const app = await import(pathToFileURL(join(root, 'src/core/http/api.ts')).href)
  const nested = { b: [2, { z: 1, a: null }], a: { with_greeks: true, c: 'x' }, n: 1.5 }
  assert.equal(stableJson(nested), app.stableJson(nested))
  assert.equal(
    stableJson(nested),
    '{"a":{"c":"x","with_greeks":true},"b":[2,{"a":null,"z":1}],"n":1.5}',
  )
})

test('the cases and the calls recorded for one', () => {
  assert.deepEqual(
    CASES.map((c) => [c.id, c.underlying, c.exchange, c.pick, Boolean(c.realOnly)]),
    [
      ['nifty', 'NIFTY', 'NFO', 'nearest', false],
      ['banknifty', 'BANKNIFTY', 'NFO', 'monthly', false],
      ['sensex', 'SENSEX', 'BFO', 'nearest', false],
      ['crudeoil', 'CRUDEOIL', 'MCX', 'nearest', true],
    ],
  )
  const nifty = CASES[0]
  const keys = (calls) => calls.map((x) => requestKey(x.endpoint, x.body))
  const chain = (n, extra = {}) =>
    requestKey('optionchain', {
      underlying: 'NIFTY',
      exchange: 'NFO',
      expiry_date: '01DEC26',
      strike_count: n,
      ...extra,
    })
  const base = [
    requestKey('expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'options' }),
    requestKey('expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'futures' }),
    chain(23),
    chain(25),
    chain(45),
  ]
  const quote = requestKey('quotes', { symbol: 'NIFTY29DEC26FUT', exchange: 'NFO' })
  assert.deepEqual(keys(recordedCalls(nifty, '01DEC26', 'NIFTY29DEC26FUT')), [...base, quote])
  assert.deepEqual(keys(recordedCalls(nifty, '01DEC26', null)), base)
  assert.deepEqual(keys(recordedCalls(nifty, '01DEC26', 'NIFTY29DEC26FUT', { withGreeks: true })), [
    ...base,
    chain(20, { with_greeks: true }),
    quote,
  ])
})

test('loadTestEnv reads the settings, and null when the file is missing or incomplete', (t) => {
  const dir = tmp(t)
  const file = join(dir, 'env')
  writeFileSync(file, '# c\nOPENALGO_TEST_URL="http://h:1"\nOPENALGO_TEST_APIKEY=k\n')
  assert.deepEqual(loadTestEnv(file), { url: 'http://h:1', key: 'k', wsUrl: null })
  writeFileSync(file, 'OPENALGO_TEST_URL=http://h:1\n')
  assert.equal(loadTestEnv(file), null)
  assert.equal(loadTestEnv(join(dir, 'missing')), null)
})

test('--mock refuses the real test server origin', () => {
  const real = { url: 'http://127.0.0.1:5000', key: 'k', wsUrl: null }
  assert.match(mockOriginRefusal('http://127.0.0.1:5000', real), /test server/)
  assert.match(mockOriginRefusal('http://localhost:5000/', real), /test server/)
  assert.equal(mockOriginRefusal('http://127.0.0.1:5099', real), null)
  assert.equal(mockOriginRefusal('http://127.0.0.1:5000', null), null)
})

test('wantedStrikes: spot 24,000, step 50, 5% → 25; null → 40; clamped to 5..40', () => {
  const chain = (strikes) => ({ chain: strikes.map((strike) => ({ strike })) })
  const nifty = chain(ladder(23000, 50, 41))
  assert.equal(wantedStrikes(nifty, 24000, 5), 25)
  assert.equal(wantedStrikes(nifty, 24000, null), 40)
  assert.equal(wantedStrikes(nifty, 24000, 2), 11)
  // 49 strikes a side for 10%: the ceiling
  assert.equal(wantedStrikes(nifty, 24000, 10), 40)
  // 4 for CRUDEOIL at 2% of 6,000 in steps of 50: the floor
  assert.equal(wantedStrikes(chain(ladder(5000, 50, 41)), 6000, 2), 5)
  // the smallest step of an uneven ladder, and fewer than two strikes
  assert.equal(wantedStrikes(chain([23000, 23500, 23600, 24000]), 24000, 5), 13)
  assert.equal(wantedStrikes(chain([24000, 24000]), 24000, 5), 20)
  assert.deepEqual(F_PARAMS, {
    interval: '5m',
    straddleInterval: '1m',
    ranges: [5, null],
    profileExpiries: 6,
    surfaceExpiries: 4,
    surfaceStrikes: 40,
    days: { ivchart: 1, oiprofile: 5, straddle: 3, straddlepnl: 1, strategy: 3 },
  })
})

test('the straddle superset holds every ATM strike the 1m closes reach', () => {
  // Fri 27 Nov 26, 15:30 IST: the straddle window (3 days) runs 11 days back to Mon 16
  const nowMs = Date.UTC(2026, 10, 27, 10, 0)
  const at = (day, hhmm) => Date.parse(`2026-11-${day}T${hhmm}:00+05:30`) / 1000
  const refMinute = [
    // Mon 23 Nov is not one of the newest 3 dates, but its strike is still read: the server
    // reads every ATM strike of the window, and keeps the last 3 dates only after the merge
    { timestamp: at(23, '09:15'), close: 23790 },
    // 24,025 is halfway: the first of the two, as min() takes it
    { timestamp: at(25, '10:00'), close: 24025 },
    { timestamp: at(26, '11:00') * 1000, close: 24130 },
    { timestamp: at(27, '15:29'), close: 24199.9 },
  ]
  const ctx = {
    expiries: ['01-DEC-26', '08-DEC-26'],
    futExpiries: ['29-DEC-26'],
    chain20: null,
    master: { strikes: { '01DEC26': ladder(23800, 50, 9) }, futures: [], lotRows: [] },
    nowMs,
    refMinute,
  }
  const minute = recordedCallsF(CASES[0], ctx).filter(
    (x) => x.endpoint === 'history' && x.body.interval === '1m',
  )
  assert.deepEqual(minute[0].body, {
    symbol: 'NIFTY',
    exchange: 'NSE_INDEX',
    interval: '1m',
    start_date: '2026-11-16',
    end_date: '2026-11-27',
  })
  const legs = minute.slice(1)
  assert.deepEqual(
    legs.map((x) => x.body.symbol),
    [23800, 24000, 24150, 24200].flatMap((k) => [`NIFTY01DEC26${k}CE`, `NIFTY01DEC26${k}PE`]),
  )
  // the option candles only of the 3 dates the straddle keeps (the merge drops the rest)
  for (const x of legs) {
    assert.deepEqual(
      [x.body.exchange, x.body.start_date, x.body.end_date],
      ['NFO', '2026-11-25', '2026-11-27'],
    )
  }
  // no reference candles yet: no leg is read
  const none = recordedCallsF(CASES[0], { ...ctx, refMinute: undefined })
  assert.equal(none.filter((x) => x.body.interval === '1m').length, 1)
})

test('record-fixtures --mock writes master strikes, NFO and MCX futures with none expired, and no key', async (t) => {
  const origin = await mockOrigin(t)
  const out = tmp(t)
  const r = await run(RECORD, ['--mock', origin, '--out', out])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const lines = r.stdout.trim().split('\n').sort()
  assert.equal(lines.length, 3, r.stdout)
  for (const [i, id] of ['banknifty', 'nifty', 'sensex'].entries()) {
    assert.match(lines[i], new RegExp(`^mock-${id}\\.json: \\d+ calls$`))
  }
  assert.ok(!r.stdout.includes(origin) && !r.stdout.includes(KEY))
  assert.equal(r.stderr, '')
  for (const c of CASES.filter((x) => !x.realOnly)) {
    const text = readFileSync(join(out, `mock-${c.id}.json`), 'utf8')
    assert.ok(!text.includes(KEY) && !LEAK.test(text), c.id)
    assert.ok(text.endsWith('}\n') && text.startsWith('{\n  "case"'), c.id)
    const input = JSON.parse(text)
    assert.deepEqual(Object.keys(input), [
      'case',
      'source',
      'serverNowMs',
      'underlying',
      'exchange',
      'expiry',
      'fut',
      'master',
      'strategyLegs',
      'responses',
    ])
    assert.equal(input.case, c.id)
    assert.equal(input.source, 'mock')
    assert.match(input.expiry, /^\d{2}[A-Z]{3}\d{2}$/)
    const keys = Object.keys(input.responses)
    assert.deepEqual(keys, [...keys].sort())
    const calls = recordedCalls(c, input.expiry, input.fut)
    // exactly E's calls and F's superset, which the recording itself completes
    const ctx = contextF(c, input)
    const callsF = recordedCallsF(c, ctx)
    // OI Profile reads the probe's legs, the ones its daily OI is read for (preflight F 5c)
    const legs = (chain) => chain.chain.flatMap((row) => [row.ce?.symbol, row.pe?.symbol])
    assert.deepEqual(legs(ctx.oiChain), legs(ctx.chain20), c.id)
    assert.deepEqual(
      keys,
      [...new Set([...calls, ...callsF].map((x) => requestKey(x.endpoint, x.body)))].sort(),
    )
    for (const x of callsF)
      assert.equal(input.responses[requestKey(x.endpoint, x.body)].status, 'success')
    // every expiry's strikes the master lists, ascending; the case's first expiry among them
    const { strikes, futures: masterFutures, lotRows } = input.master
    assert.ok(compact(ctx.expiries[0]) in strikes, c.id)
    for (const list of Object.values(strikes)) {
      assert.ok(list.length > 0 && list.every((k, i) => i === 0 || k > list[i - 1]), c.id)
    }
    // the futures of NFO, MCX and the case's own exchange, none past its expiry instant
    const exchanges = new Set(masterFutures.map((f) => f.exchange))
    assert.ok(exchanges.has('NFO') && exchanges.has('MCX'), c.id)
    assert.deepEqual([...exchanges].sort(), [...new Set(['NFO', 'MCX', c.exchange])].sort())
    for (const f of masterFutures) {
      assert.ok(f.itype === 'FUT' && f.symbol.endsWith('FUT'), f.symbol)
      assert.ok(expiryMs(f.expiry, f.exchange) >= input.serverNowMs, f.symbol)
    }
    assert.equal(lotRows.length, 1)
    assert.ok(lotRows[0].symbol.startsWith(c.underlying) && lotRows[0].lotsize > 0)
    assert.equal(lotRows[0].exchange, c.exchange)
    // the builder's legs: the ATM straddle of the first expiry's 20-strike chain, sold
    const atm = ctx.chain20.chain.find((row) => row.strike === ctx.chain20.atm_strike)
    assert.deepEqual(
      input.strategyLegs,
      ['ce', 'pe'].map((side) => ({
        symbol: atm[side].symbol,
        exchange: c.exchange,
        side: 'SELL',
        segment: 'OPTION',
        active: true,
        price: atm[side].ltp,
        strike: atm.strike,
        optionType: side.toUpperCase(),
        expiry: compact(ctx.expiries[0]),
      })),
    )
    const options = input.responses[requestKey(calls[0].endpoint, calls[0].body)].data
    const futures = input.responses[requestKey(calls[1].endpoint, calls[1].body)].data
    const dashed = `${input.expiry.slice(0, 2)}-${input.expiry.slice(2, 5)}-${input.expiry.slice(5)}`
    const month = options[0].slice(3)
    assert.equal(
      dashed,
      c.pick === 'monthly' ? options.filter((d) => d.slice(3) === month).at(-1) : options[0],
    )
    const futExpiry = futures.includes(dashed) ? dashed : futures[0]
    assert.equal(input.fut, `${c.underlying}${futExpiry.replaceAll('-', '')}FUT`)
    const chain25 = input.responses[requestKey(calls[3].endpoint, calls[3].body)]
    assert.equal(calls[3].body.strike_count, 25)
    assert.equal(input.serverNowMs, chain25.server_ts * 1000)
  }
  assert.ok(!existsSync(join(out, 'mock-crudeoil.json')))
})

/**
 * A server that answers every read with success, and `extra` merged into each body; the
 * instruments GET with a header and no rows.
 */
async function stubServer(t, extra) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/csv')
        res.end(
          'symbol,brsymbol,name,exchange,brexchange,token,expiry,strike,lotsize,instrumenttype,tick_size\n',
        )
        return
      }
      const b = JSON.parse(raw)
      const body =
        b.instrumenttype !== undefined
          ? { status: 'success', data: ['01-DEC-26'] }
          : b.strike_count !== undefined
            ? { status: 'success', chain: [], server_ts: 1_800_000_000 }
            : { status: 'success', data: { ltp: 1 } }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ...body, ...extra(b) }))
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

test('a body holding the key is refused and nothing is written', async (t) => {
  for (const extra of [
    (b) => ({ echo: b.apikey }),
    () => ({ message: 'Invalid openalgo apikey' }),
  ]) {
    const origin = await stubServer(t, extra)
    const out = tmp(t)
    const r = await run(RECORD, ['--mock', origin, '--out', out, '--case', 'nifty'])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /nifty: refused/)
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY))
    assert.deepEqual(readdirSync(out), [])
  }
})

/** Records one case from the mock in the controller's raw shape (record-raw.mjs). */
async function rawRecording(origin, c) {
  const calls = []
  const call = async (endpoint, body) => {
    const res = await fetch(`${origin}/api/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apikey: KEY, ...body }),
    })
    const json = await res.json()
    calls.push({
      endpoint,
      body,
      status: res.status,
      dateHeader: res.headers.get('date'),
      receivedAtMs: Date.now(),
      json,
    })
    return json
  }
  await call('analyzer', {})
  const options = (
    await call('expiry', { symbol: c.underlying, exchange: c.exchange, instrumenttype: 'options' })
  ).data
  const futures = (
    await call('expiry', { symbol: c.underlying, exchange: c.exchange, instrumenttype: 'futures' })
  ).data
  const monthly = options.filter((d) => d.slice(3) === options[0].slice(3)).at(-1)
  const expiry = c.pick === 'monthly' ? monthly : options[0]
  const futExpiry = futures.includes(expiry) ? expiry : futures[0]
  const fut = `${c.underlying}${futExpiry.replaceAll('-', '')}FUT`
  // the chains at 23, 25, 45 and the with_greeks 20, for the case's expiry and the nearest
  for (const e of new Set([expiry, options[0]])) {
    const chain = {
      underlying: c.underlying,
      exchange: c.exchange,
      expiry_date: e.replaceAll('-', ''),
    }
    for (const n of [23, 25, 45]) await call('optionchain', { ...chain, strike_count: n })
    await call('optionchain', { ...chain, strike_count: 20, with_greeks: true })
  }
  await call('quotes', { symbol: fut, exchange: c.exchange })
  return {
    case: c.id,
    source: 'real',
    recordedAtMs: Date.now(),
    underlying: c.underlying,
    exchange: c.exchange,
    pick: c.pick,
    expiry,
    nearest: options[0],
    fut,
    futExpiry,
    calls,
  }
}

test('record-fixtures --from converts a raw recording: analyzer dropped, extra calls kept', async (t) => {
  const origin = await mockOrigin(t)
  const raw = tmp(t)
  const banknifty = CASES[1]
  const rec = await rawRecording(origin, banknifty)
  writeFileSync(join(raw, 'real-banknifty.json'), JSON.stringify(rec, null, 1))
  writeFileSync(join(raw, 'real-nifty.partial.json'), '{}')
  const out = tmp(t)
  const r = await run(RECORD, ['--from', raw, '--out', out])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  // every call but the analyzer read: the expiry reads, 4 chains per expiry, the quote
  const calls = rec.calls.length - 1
  assert.equal(r.stdout.trim(), `real-banknifty.json: ${calls} calls`)
  assert.deepEqual(readdirSync(out), ['real-banknifty.json'])
  const input = JSON.parse(readFileSync(join(out, 'real-banknifty.json'), 'utf8'))
  assert.equal(input.source, 'real')
  assert.equal(input.expiry, rec.expiry.replaceAll('-', ''))
  assert.equal(input.fut, rec.fut)
  const keys = Object.keys(input.responses)
  assert.equal(keys.length, calls)
  assert.ok(!keys.some((k) => k.startsWith('analyzer')))
  const all = recordedCalls(banknifty, input.expiry, input.fut, { withGreeks: true })
  for (const x of all) {
    assert.ok(keys.includes(requestKey(x.endpoint, x.body)), requestKey(x.endpoint, x.body))
  }
  const chain25 = recordedCalls(banknifty, input.expiry, input.fut)[3]
  assert.equal(
    input.serverNowMs,
    input.responses[requestKey(chain25.endpoint, chain25.body)].server_ts * 1000,
  )
})

test('record-fixtures --from refuses a raw file with a failed call or a key field', async (t) => {
  const origin = await mockOrigin(t)
  const nifty = CASES[0]
  for (const spoil of [
    (rec) =>
      Object.assign(rec.calls.at(-1), { status: 400, json: { status: 'error', message: 'x' } }),
    (rec) => Object.assign(rec.calls.at(-1).json, { api_key: 'redacted' }),
  ]) {
    const rec = await rawRecording(origin, nifty)
    spoil(rec)
    const raw = tmp(t)
    writeFileSync(join(raw, 'real-nifty.json'), JSON.stringify(rec))
    const out = tmp(t)
    const r = await run(RECORD, ['--from', raw, '--out', out])
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /nifty: refused/)
    assert.deepEqual(readdirSync(out), [])
  }
})

test('gen-golden --dry-run names uv sync --frozen and the harness', async (t) => {
  const ref = readFileSync(join(root, 'openalgo.ref'), 'utf8').trim()
  const own = await run(GEN, ['--dry-run'])
  assert.equal(own.code, 0, own.stdout + own.stderr)
  assert.match(own.stdout, new RegExp(`git -C \\S+ archive --format=tar ${ref}`))
  assert.ok(own.stdout.includes(`.cache/openalgo-server-${ref}`))
  const dir = join(tmp(t), 'server')
  const given = await run(GEN, ['--server', dir, '--dry-run'])
  assert.equal(given.code, 0, given.stdout + given.stderr)
  const lines = given.stdout.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(!given.stdout.includes('archive'))
  assert.equal(
    lines[0],
    `uv sync --frozen --no-dev --project ${dir} --python 3.12 --managed-python`,
  )
  assert.equal(
    lines[1],
    `uv run --frozen --no-sync --project ${dir} --python 3.12 --managed-python python ${join(root, 'scripts/golden/harness.py')} ` +
      `--server ${dir} --in ${INPUTS} --out ${EXPECTED}`,
  )
  assert.ok(!existsSync(dir))
})

test('the synthetic inputs are what synthetic.mjs builds from the mock NIFTY recording', async () => {
  const r = await run(join(root, 'scripts/golden/synthetic.mjs'), ['--check'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const inputs = readdirSync(INPUTS).filter((f) => f.startsWith('synthetic-'))
  assert.deepEqual(inputs.sort(), [
    'synthetic-crudeoil-mcx-2000.json',
    'synthetic-nifty-expired-1545.json',
    'synthetic-nifty-expiry-1500.json',
    'synthetic-nifty-gaps.json',
    'synthetic-nifty-unpriced-1545.json',
  ])
  // the edges they hold, as the server's Python saw them
  const out = (f) => JSON.parse(readFileSync(join(EXPECTED, f), 'utf8'))
  assert.equal(out('synthetic-nifty-expired-1545.json').withGreeks.years, 0)
  assert.ok(out('synthetic-nifty-expiry-1500.json').withGreeks.years > 0)
  assert.deepEqual(out('synthetic-nifty-unpriced-1545.json').legs, [])
  // MCX trades to 23:30: at 20:00 on its expiry day the option has not expired
  assert.ok(out('synthetic-crudeoil-mcx-2000.json').withGreeks.years > 0)
})

test('every input has its expected file and every expected route has status 200 or the server error', () => {
  const inputs = readdirSync(INPUTS).filter((f) => f.endsWith('.json'))
  assert.deepEqual(inputs.filter((f) => f.startsWith('mock-')).sort(), [
    'mock-banknifty.json',
    'mock-nifty.json',
    'mock-sensex.json',
  ])
  const expected = readdirSync(EXPECTED).filter((f) => f.endsWith('.json'))
  assert.deepEqual(expected.sort(), [...inputs, 'black76.json'].sort())
  for (const f of inputs) {
    const input = JSON.parse(readFileSync(join(INPUTS, f), 'utf8'))
    const out = JSON.parse(readFileSync(join(EXPECTED, f), 'utf8'))
    assert.equal(out.case, input.case, f)
    // a synthetic case is not a recorded one: its own underlying and exchange
    const c = CASES.find((x) => x.id === input.case) ?? {
      id: input.case,
      underlying: input.underlying,
      exchange: input.exchange,
    }
    const chain25 = recordedCalls(c, input.expiry, input.fut)[3]
    if (!(requestKey(chain25.endpoint, chain25.body) in input.responses)) {
      // a real case recorded by part F's recorder alone (preflight F conflict 11): E pending
      assert.ok(input.source === 'real' && !('routes' in out), f)
      continue
    }
    assert.deepEqual(Object.keys(out.routes), ROUTES, f)
    for (const name of ROUTES) {
      const { status, body } = out.routes[name]
      if (status === 200) assert.equal(body.status, 'success', `${f} ${name}`)
      else {
        assert.ok(status >= 400, `${f} ${name}`)
        assert.equal(body.status, 'error', `${f} ${name}`)
        assert.equal(typeof body.message, 'string', `${f} ${name}`)
      }
    }
    const chain = input.responses[requestKey(chain25.endpoint, chain25.body)].chain
    const priced = chain.flatMap((row) => [row.ce, row.pe]).filter((leg) => leg?.ltp > 0)
    assert.deepEqual(
      out.legs.map((leg) => leg.symbol),
      priced.map((leg) => leg.symbol),
      f,
    )
    for (const leg of out.legs)
      assert.ok([200, 400, 500].includes(leg.status), `${f} ${leg.symbol}`)
    assert.deepEqual(
      out.withGreeks.rows.map((row) => row.strike),
      chain.map((row) => row.strike),
      f,
    )
    assert.ok(out.withGreeks.forward > 0, f)
  }
  const b76 = JSON.parse(readFileSync(join(EXPECTED, 'black76.json'), 'utf8'))
  assert.equal(b76.grid.length, 2 * 3 * 7 * 5 * 4)
  assert.equal(b76.edges.length, 11)
  assert.equal(b76.symbols.length, 12)
  // plan F's edges: opengreeks saturates below 5, and answers 1e-6 at intrinsic, with Greeks
  const edge = (label) => b76.edges.find((e) => e.label === label)
  assert.equal(edge('a price from sigma 6.2').iv, 4.999999999999996)
  assert.equal(edge('at intrinsic').iv, 1e-6)
  for (const e of b76.edges) {
    if (e.iv === null) assert.equal(e.greeks, null, e.label)
    else assert.deepEqual(Object.keys(e.greeks), ['delta', 'gamma', 'theta', 'vega'], e.label)
  }
})

/** The page's request for each of plan F's routes, as the harness sends it for `input`. */
function argsF(input) {
  const c = { underlying: input.underlying, exchange: input.exchange }
  const options =
    input.responses[
      requestKey('expiry', {
        symbol: c.underlying,
        exchange: c.exchange,
        instrumenttype: 'options',
      })
    ].data.map(compact)
  const at = { ...c, expiry_date: options[0] }
  const chain20 = servedChain(input, chainCall(c, options[0], 20, { withGreeks: true }).body)
  const lot = chain20.chain.flatMap((row) => [row.ce, row.pe]).find((leg) => leg?.lotsize)?.lotsize
  const { days, interval, straddleInterval: minute } = F_PARAMS
  const strategy = { ...c, legs: input.strategyLegs, interval, days: days.strategy }
  return {
    get_strike_profile: {
      ...c,
      expiry_dates: options.slice(0, F_PARAMS.profileExpiries),
      range_pct: 5,
    },
    get_strike_profile_all: {
      ...c,
      expiry_dates: options.slice(0, F_PARAMS.profileExpiries),
      range_pct: null,
    },
    get_vol_surface_data: {
      ...c,
      expiry_dates: options.slice(0, F_PARAMS.surfaceExpiries),
      strike_count: F_PARAMS.surfaceStrikes,
    },
    get_iv_chart_data: { ...at, interval, days: days.ivchart },
    get_oi_profile_data: { ...at, interval, days: days.oiprofile },
    get_straddle_chart_data: { ...at, interval: minute, days: days.straddle },
    get_custom_straddle_simulation: {
      ...at,
      interval: minute,
      days: days.straddlepnl,
      adjustment_points: 50,
      lot_size: lot,
      lots: 1,
    },
    get_strategy_chart_data: strategy,
    get_multi_strike_oi_data: strategy,
    get_arbitrage_universe: { exchanges: ['NFO', 'MCX'] },
  }
}

test('every input has routesF, each status 200 or the server error; crudeoil (real) answers 200', (t) => {
  const inputs = readdirSync(INPUTS).filter((f) => f.endsWith('.json'))
  for (const f of inputs) {
    const input = JSON.parse(readFileSync(join(INPUTS, f), 'utf8'))
    const out = JSON.parse(readFileSync(join(EXPECTED, f), 'utf8'))
    // every mock recording has part F; a synthetic one is E's edges, built from the mock NIFTY
    // recording without it; a real one without it is part-F pending (preflight F conflict 11)
    assert.ok(input.source !== 'mock' || 'master' in input, f)
    if (!('master' in input)) {
      assert.ok(!('routesF' in out), f)
      continue
    }
    assert.deepEqual(Object.keys(out.routesF), ROUTES_F, f)
    const args = argsF(input)
    for (const name of ROUTES_F) {
      const { status, body } = out.routesF[name]
      assert.deepEqual(out.routesF[name].args, args[name], `${f} ${name}`)
      if (status === 200) assert.equal(body.status, 'success', `${f} ${name}`)
      else {
        assert.ok(status >= 400, `${f} ${name}`)
        assert.equal(body.status, 'error', `${f} ${name}`)
        assert.equal(typeof body.message, 'string', `${f} ${name}`)
      }
      // the mock has every option, future and candle a route asks for, so it answers all
      if (input.source === 'mock' || f === 'real-crudeoil.json')
        assert.equal(status, 200, `${f} ${name}`)
    }
    // the universe is a pure master read; its clock stamp is left out
    assert.ok(!('generated_at' in out.routesF.get_arbitrage_universe.body.data), f)
  }
  if (!inputs.includes('real-crudeoil.json')) {
    t.diagnostic('real-crudeoil: no real recording yet (plan F T15 converts the controller raw)')
  }
})

/** Runs Python `code` with `stdin` JSON; null when no python3 is installed. */
function python(code, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      // -B: no __pycache__ beside the harness
      ['-B', '-c', code],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error?.code === 'ENOENT') resolve(null)
        else if (error) reject(new Error(`python3: ${stderr}`))
        else resolve(JSON.parse(stdout))
      },
    )
    child.stdin.end(JSON.stringify(stdin))
  })
}

test('the harness and record-fixtures serve a superset recording by one rule (preflight 5a)', async (t) => {
  const input = JSON.parse(readFileSync(join(INPUTS, 'mock-nifty.json'), 'utf8'))
  const c = CASES[0]
  const ex = (d) =>
    compact(
      input.responses[
        requestKey('expiry', { symbol: 'NIFTY', exchange: 'NFO', instrumenttype: 'options' })
      ].data[d],
    )
  const responses = { ...input.responses }
  // with Greeks as a server computes them (the mock computes none)
  const g20 = requestKey('optionchain', chainCall(c, ex(1), 20, { withGreeks: true }).body)
  const greeks = structuredClone(responses[g20])
  Object.assign(greeks, { greeks_included: true, forward_price: greeks.underlying_ltp })
  for (const leg of greeks.chain.flatMap((row) => [row.ce, row.pe]).filter(Boolean)) {
    Object.assign(leg, { implied_volatility: 12.5, delta: 0.5, gamma: 0.001, theta: -9, vega: 12 })
  }
  responses[g20] = greeks
  // each recorded chain names itself, so a reply shows which one it was served from
  const prefix = 'optionchain '
  for (const key of Object.keys(responses).filter((k) => k.startsWith(prefix))) {
    const b = JSON.parse(key.slice(prefix.length))
    const recorded = `${b.expiry_date} ${b.strike_count}${b.with_greeks ? ' greeks' : ''}`
    responses[key] = { ...responses[key], recorded }
  }
  // a reference read in milliseconds, as some brokers answer
  const ref5 = Object.keys(responses).find(
    (k) => k.startsWith('history ') && k.includes('"NSE_INDEX"') && k.includes('"5m"'),
  )
  const ms = structuredClone(responses[ref5])
  for (const row of ms.data) row.timestamp *= 1000
  responses[ref5] = ms
  const fixture = { ...input, responses }
  // the Strike Profile's with-Greeks count at 5 % (25 or 26 at the mock's spot)
  const probe =
    input.responses[requestKey('optionchain', chainCall(c, ex(0), 20, { withGreeks: true }).body)]
  const wanted = wantedStrikes(probe, probe.underlying_ltp, 5)
  assert.ok(wanted > 23 && wanted < 30, String(wanted))
  // A plain read takes the narrowest wide-enough chain of either kind, plain on a tie; a
  // with_greeks read the narrowest with-Greeks one, else the narrowest plain one (preflight F
  // 5a, with 5c: OI Profile's plain 20 is the with-Greeks 20 whose legs' daily OI is recorded).
  // The first expiry also has E's plain 23, 25 and 45.
  const chains = [
    [chainCall(c, ex(0), 20, { withGreeks: true }).body, `${ex(0)} 20 greeks`], // as asked
    [chainCall(c, ex(1), 30, { withGreeks: true }).body, `${ex(1)} 40 greeks`], // cut to 30 a side
    [chainCall(c, ex(1), 20).body, `${ex(1)} 20 greeks`], // without them, not the plain 40 cut
    [chainCall(c, ex(0), 20).body, `${ex(0)} 20 greeks`], // OI Profile's: not E's plain 23 cut
    [chainCall(c, ex(0), 22).body, `${ex(0)} 23`], // a plain one when it is the narrowest
    [chainCall(c, ex(1), 30).body, `${ex(1)} 40`], // the plain 40, on a tie with the with-Greeks 40
    [chainCall(c, ex(0), 21, { withGreeks: true }).body, `${ex(0)} ${wanted} greeks`], // not plain 23
    [chainCall(c, ex(0), 41, { withGreeks: true }).body, `${ex(0)} 45`], // no with-Greeks one that wide
    [chainCall(c, ex(2), 3).body, `${ex(2)} 20 greeks`], // cut to 3, without them
    [chainCall(c, ex(1), 41, { withGreeks: true }).body, 'NotRecorded'], // nothing that wide
    [{ underlying: 'NIFTY', exchange: 'NFO' }, 'NotRecorded'], // not a chain read
  ]
  // the newest day the reference has candles on (a weekend recording has none today)
  const lastDay = new Date(input.responses[ref5].data.at(-1).timestamp * 1000 + IST_MS)
    .toISOString()
    .slice(0, 10)
  const leg = JSON.parse(
    Object.keys(responses)
      .find((k) => k.startsWith('history ') && k.includes('"D"'))
      .slice(8),
  )
  const histories = [
    { ...JSON.parse(ref5.slice(8)), start_date: lastDay }, // milliseconds, the last day only
    { ...JSON.parse(ref5.slice(8)), symbol: 'nifty', exchange: 'nse_index', interval: '5M' }, // case-folded
    { ...leg, start_date: '2001-01-01', end_date: '2001-01-02' }, // no candle in the window
    { ...leg, symbol: `${leg.symbol}X` }, // never recorded
  ]
  const serve = (f, ask) => {
    try {
      return f(fixture, ask)
    } catch (e) {
      if (e instanceof NotRecorded) return 'NotRecorded'
      throw e
    }
  }
  // MCX has no spot: the near-month future of the exact base, unexpired (RF 4)
  const fut = (symbol, expiry, itype = 'FUT') => ({
    symbol,
    name: 'CRUDEOIL',
    exchange: 'MCX',
    expiry,
    strike: 0,
    lotsize: 100,
    tick: 1,
    itype,
    underlying: symbol.slice(0, -10),
  })
  const mcx = {
    futures: [
      fut('CRUDEOILM18DEC26FUT', '18-DEC-26'), // another product sharing the prefix
      fut('CRUDEOIL26JAN27FUT', '26-JAN-27'),
      fut('CRUDEOIL29DEC26FUT', '29-DEC-26'),
      fut('CRUDEOIL20NOV26FUT', '20-NOV-26'), // expired
      fut('CRUDEOIL22DEC26FUT', '22-DEC-26', 'OPTFUT'), // not a FUT row
    ],
  }
  const asks = chains.map(([ask]) => ask)
  const ours = {
    chains: asks.map((ask) => serve(servedChain, ask)),
    histories: histories.map((ask) => serve(servedHistory, ask)),
    reference: referenceOf({ underlying: 'CRUDEOIL', exchange: 'MCX' }, mcx, input.serverNowMs),
  }
  const theirs = await python(
    [
      'import json, sys',
      "sys.path.insert(0, 'scripts/golden')",
      'import harness',
      'arg = json.load(sys.stdin)',
      "rec = harness.Recording(arg['input'])",
      'def serve(f, ask):',
      '    try:',
      '        return f(ask)',
      '    except harness.Missing:',
      "        return 'NotRecorded'",
      "resolve = harness.near_month_future(arg['mcx'], arg['input']['serverNowMs'])",
      "symbol, exchange = resolve('CRUDEOIL', 'MCX')",
      "out = {'chains': [serve(lambda a: rec.chain(a)[0], a) for a in arg['chains']],",
      "       'histories': [serve(rec.history, a) for a in arg['histories']],",
      "       'reference': {'symbol': symbol, 'exchange': exchange}}",
      'json.dump(out, sys.stdout)',
    ].join('\n'),
    { input: fixture, chains: asks, histories, mcx },
  )
  if (theirs === null) return t.skip('python3 is not installed')
  assert.deepEqual(theirs, ours)
  // the source each read was served from
  assert.deepEqual(
    ours.chains.map((x) => x.recorded ?? x),
    chains.map(([, source]) => source),
  )
  // the slices themselves
  const [exact, cut, stripped, oi, plain23, tie, narrower, plain45, three] = ours.chains
  assert.equal(exact.chain.length, 41)
  assert.equal(cut.chain.length, 61)
  for (const chain of [stripped, oi, three]) {
    assert.ok(
      chain.chain.every(
        (row) => !('delta' in (row.ce ?? {})) && !('implied_volatility' in (row.pe ?? {})),
      ),
    )
    assert.deepEqual([chain.greeks_included, chain.forward_price], [false, null])
  }
  // the server's ATM ± 20 legs as the probe saw them: exactly those F read daily OI for
  assert.deepEqual(oi.chain, exact.chain)
  assert.deepEqual(
    [stripped, plain23, tie, narrower, plain45].map((chain) => chain.chain.length),
    [41, 45, 61, 43, 81],
  )
  assert.deepEqual(
    three.chain.map((row) => row.strike),
    ladder(three.atm_strike - 150, 50, 7),
  )
  for (const chain of ours.chains.slice(0, -2))
    assert.equal(chain.server_ts, input.serverNowMs / 1000)
  const [lastOnly, folded, empty, missing] = ours.histories
  assert.ok(lastOnly.data.length > 0 && lastOnly.data.length < ms.data.length)
  assert.equal(folded.data.length, ms.data.length)
  assert.deepEqual([empty, missing], [{ status: 'success', data: [] }, 'NotRecorded'])
  assert.deepEqual(ours.reference, { symbol: 'CRUDEOIL29DEC26FUT', exchange: 'MCX' })
})

/** The golden server tree and its uv, or null when either is missing (CI's script job). */
function goldenServer() {
  const ref = readFileSync(join(root, 'openalgo.ref'), 'utf8').trim()
  const server = join(root, '.cache', `openalgo-server-${ref}`)
  return existsSync(join(server, '.venv')) ? server : null
}

test('the harness is frozen at serverNowMs: two runs 2 s apart write the same goldens', async (t) => {
  const server = goldenServer()
  if (!server) return t.skip('no golden server tree (npm run gen-golden extracts it)')
  const inputs = tmp(t)
  writeFileSync(join(inputs, 'mock-nifty.json'), readFileSync(join(INPUTS, 'mock-nifty.json')))
  const harness = (out) =>
    new Promise((resolve) => {
      const uv = [
        'run',
        '--frozen',
        '--no-sync',
        '--project',
        server,
        '--python',
        '3.12',
        '--managed-python',
      ]
      execFile(
        'uv',
        [...uv, 'python', HARNESS, '--server', server, '--in', inputs, '--out', out],
        { cwd: root, encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
      )
    })
  const first = tmp(t)
  const a = await harness(first)
  if (a.code === 'ENOENT') return t.skip('uv is not installed')
  assert.equal(a.code, 0, a.stdout + a.stderr)
  await new Promise((ok) => setTimeout(ok, 2000))
  const second = tmp(t)
  const b = await harness(second)
  assert.equal(b.code, 0, b.stdout + b.stderr)
  const text = readFileSync(join(first, 'mock-nifty.json'), 'utf8')
  assert.equal(readFileSync(join(second, 'mock-nifty.json'), 'utf8'), text)
  // and the committed golden is that run's
  assert.equal(readFileSync(join(EXPECTED, 'mock-nifty.json'), 'utf8'), text)
})

/** The mock's instruments CSV of `exchange`. */
async function instrumentsCsv(origin, exchange) {
  const q = new URLSearchParams({ apikey: KEY, exchange, format: 'csv' })
  return (await fetch(`${origin}/api/v1/instruments?${q}`)).text()
}

/** The controller's raw part-F shape (record-raw-f.mjs) of a recorded input, its CSVs in `dir`. */
async function rawRecordingF(origin, input, dir) {
  for (const ex of ['NFO', 'BFO', 'MCX']) {
    writeFileSync(join(dir, `instruments-${ex}.csv`), await instrumentsCsv(origin, ex))
  }
  const ctx = contextF(
    CASES.find((x) => x.id === input.case),
    input,
  )
  const calls = Object.entries(input.responses).map(([key, json]) => {
    const at = key.indexOf(' ')
    return {
      endpoint: key.slice(0, at),
      body: JSON.parse(key.slice(at + 1)),
      status: 200,
      dateHeader: new Date(input.serverNowMs).toUTCString(),
      receivedAtMs: input.serverNowMs,
      json,
    }
  })
  return {
    case: input.case,
    source: 'real',
    recordedAtMs: input.serverNowMs,
    underlying: input.underlying,
    exchange: input.exchange,
    ref: null,
    expiries: ctx.expiries,
    futExpiries: ctx.futExpiries,
    nearFut: null,
    calls: [
      {
        endpoint: 'analyzer',
        body: {},
        status: 200,
        json: { status: 'success', data: { mode: 'analyze' } },
      },
      ...calls,
    ],
  }
}

test('record-fixtures --from with --from-f merges each case: E clock and expiry, F replies and master', async (t) => {
  const origin = await mockOrigin(t)
  const recorded = tmp(t)
  const r0 = await run(RECORD, ['--mock', origin, '--out', recorded, '--case', 'nifty'])
  assert.equal(r0.code, 0, r0.stdout + r0.stderr)
  const input = JSON.parse(readFileSync(join(recorded, 'mock-nifty.json'), 'utf8'))
  const fdir = tmp(t)
  const rawF = await rawRecordingF(origin, input, fdir)
  writeFileSync(join(fdir, 'real-nifty.json'), JSON.stringify(rawF))
  writeFileSync(join(fdir, 'real-sensex.partial.json'), '{}')
  const edir = tmp(t)
  const rawE = await rawRecording(origin, CASES[0])
  writeFileSync(join(edir, 'real-nifty.json'), JSON.stringify(rawE))

  // F alone: its clock is the first expiry's with-Greeks 20, its expiry the first
  const fOnly = tmp(t)
  const r1 = await run(RECORD, ['--from-f', fdir, '--out', fOnly])
  assert.equal(r1.code, 0, r1.stdout + r1.stderr)
  assert.match(r1.stdout, /^real-nifty\.json: \d+ calls$/m)
  const f = JSON.parse(readFileSync(join(fOnly, 'real-nifty.json'), 'utf8'))
  assert.equal(f.source, 'real')
  assert.equal(f.expiry, compact(rawF.expiries[0]))
  const chain20 =
    input.responses[
      requestKey('optionchain', chainCall(CASES[0], f.expiry, 20, { withGreeks: true }).body)
    ]
  assert.equal(f.serverNowMs, chain20.server_ts * 1000)
  assert.deepEqual(f.strategyLegs, input.strategyLegs)
  assert.deepEqual(f.responses, input.responses)
  // the same master from the raw CSVs as from the mock's own instruments reads
  assert.deepEqual(f.master, input.master)

  // both: E's clock, expiry and future; every reply of both, F's on a clash
  const both = tmp(t)
  const r2 = await run(RECORD, ['--from', edir, '--from-f', fdir, '--out', both])
  assert.equal(r2.code, 0, r2.stdout + r2.stderr)
  const merged = JSON.parse(readFileSync(join(both, 'real-nifty.json'), 'utf8'))
  const chain25 = rawE.calls.find(
    (x) =>
      x.endpoint === 'optionchain' &&
      x.body.strike_count === 25 &&
      x.body.expiry_date === compact(rawE.expiry),
  )
  assert.equal(merged.serverNowMs, chain25.json.server_ts * 1000)
  assert.deepEqual([merged.expiry, merged.fut], [compact(rawE.expiry), rawE.fut])
  for (const x of rawE.calls.filter((y) => y.endpoint !== 'analyzer')) {
    const key = requestKey(x.endpoint, x.body)
    assert.deepEqual(
      merged.responses[key],
      key in input.responses ? input.responses[key] : x.json,
      key,
    )
  }
  for (const [key, body] of Object.entries(input.responses))
    assert.deepEqual(merged.responses[key], body, key)
  assert.deepEqual([merged.master, merged.strategyLegs], [f.master, f.strategyLegs])

  // a raw F whose nearest expiry is not E's is not the same session: refused
  const odd = tmp(t)
  writeFileSync(
    join(odd, 'real-nifty.json'),
    JSON.stringify({ ...rawF, expiries: rawF.expiries.slice(1) }),
  )
  for (const ex of ['NFO', 'BFO', 'MCX'])
    writeFileSync(
      join(odd, `instruments-${ex}.csv`),
      readFileSync(join(fdir, `instruments-${ex}.csv`)),
    )
  const none = tmp(t)
  const r3 = await run(RECORD, ['--from', edir, '--from-f', odd, '--out', none])
  assert.equal(r3.code, 1, r3.stdout + r3.stderr)
  assert.match(r3.stdout, /nifty: refused, .*nearest expiry/)
  assert.deepEqual(readdirSync(none), [])
})

test('record-fixtures --from with --from-f: an ATM move between the two loops leaves part F whole (preflight F 5c)', async (t) => {
  const origin = await mockOrigin(t)
  const recorded = tmp(t)
  const r0 = await run(RECORD, ['--mock', origin, '--out', recorded, '--case', 'nifty'])
  assert.equal(r0.code, 0, r0.stdout + r0.stderr)
  const input = JSON.parse(readFileSync(join(recorded, 'mock-nifty.json'), 'utf8'))
  const fdir = tmp(t)
  const rawF = await rawRecordingF(origin, input, fdir)
  // the controller's part-F recorder reads none of E's plain chains (record-raw-f.mjs)
  rawF.calls = rawF.calls.filter(
    (x) =>
      x.endpoint !== 'optionchain' ||
      x.body.with_greeks === true ||
      !CHAIN_COUNTS.includes(x.body.strike_count),
  )
  writeFileSync(join(fdir, 'real-nifty.json'), JSON.stringify(rawF))
  // E's loop ran 20 minutes before F's and saw the index a strike higher: its chains centre there
  const rawE = await rawRecording(origin, CASES[0])
  for (const x of rawE.calls) {
    if (x.endpoint !== 'optionchain' || x.body.with_greeks === true) continue
    const at = x.json.chain.findIndex((row) => row.strike === x.json.atm_strike)
    x.json.atm_strike = x.json.chain[at + 1].strike
  }
  const edir = tmp(t)
  writeFileSync(join(edir, 'real-nifty.json'), JSON.stringify(rawE))
  const out = tmp(t)
  const r = await run(RECORD, ['--from', edir, '--from-f', fdir, '--out', out])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /pending/)
  const merged = JSON.parse(readFileSync(join(out, 'real-nifty.json'), 'utf8'))
  assert.ok('master' in merged && 'strategyLegs' in merged)
  // OI Profile's plain 20 is F's with-Greeks 20 without its Greeks, not E's plain 23 cut to 20:
  // exactly the legs F read daily OI for
  const ctx = contextF(CASES[0], merged)
  const legs = (chain) => chain.chain.flatMap((row) => [row.ce?.symbol, row.pe?.symbol])
  assert.deepEqual(legs(ctx.oiChain), legs(ctx.chain20))
  assert.equal(ctx.oiChain.atm_strike, ctx.chain20.atm_strike)
})

test('record-fixtures --from-f refuses a failed read, and a case it cannot serve is part-F pending', async (t) => {
  const origin = await mockOrigin(t)
  const recorded = tmp(t)
  const r0 = await run(RECORD, ['--mock', origin, '--out', recorded, '--case', 'sensex'])
  assert.equal(r0.code, 0, r0.stdout + r0.stderr)
  const input = JSON.parse(readFileSync(join(recorded, 'mock-sensex.json'), 'utf8'))
  const fdir = tmp(t)
  const rawF = await rawRecordingF(origin, input, fdir)
  const failed = structuredClone(rawF)
  Object.assign(failed.calls.at(-1), { status: 429, json: { status: 'error', message: 'x' } })
  writeFileSync(join(fdir, 'real-sensex.json'), JSON.stringify(failed))
  const out = tmp(t)
  const r1 = await run(RECORD, ['--from-f', fdir, '--out', out])
  assert.equal(r1.code, 1, r1.stdout + r1.stderr)
  assert.match(r1.stdout, /sensex: refused, 1 reads did not succeed/)
  assert.deepEqual(readdirSync(out), [])
  // a daily OI read left out: with E's side the case keeps E's goldens, part F pending
  const short = structuredClone(rawF)
  const daily = short.calls.findIndex((x) => x.endpoint === 'history' && x.body.interval === 'D')
  short.calls.splice(daily, 1)
  writeFileSync(join(fdir, 'real-sensex.json'), JSON.stringify(short))
  const edir = tmp(t)
  writeFileSync(
    join(edir, 'real-sensex.json'),
    JSON.stringify(await rawRecording(origin, CASES[2])),
  )
  const r2 = await run(RECORD, ['--from', edir, '--from-f', fdir, '--out', out])
  assert.equal(r2.code, 0, r2.stdout + r2.stderr)
  assert.match(r2.stdout, /^sensex: part F pending, 1 reads not recorded \(history /m)
  const kept = JSON.parse(readFileSync(join(out, 'real-sensex.json'), 'utf8'))
  assert.ok(!('master' in kept) && !('strategyLegs' in kept))
})

test('the master rows are the app parse of the instruments CSV (src/market/master/csv.ts)', async () => {
  const { parseInstrumentsCsv } = await import(
    pathToFileURL(join(root, 'src/market/master/csv.ts')).href
  )
  const text = [
    'symbol,brsymbol,name,exchange,brexchange,token,expiry,strike,lotsize,instrumenttype,tick_size',
    'NIFTY29DEC26FUT,NIFTY26DECFUT,NIFTY,NFO,NFO,1,29-DEC-26,0,65,FUT,0.1',
    '"M&M29DEC263500CE",X,"MAHINDRA, & MAHINDRA",NFO,NFO,2,29-DEC-26,3500,700,CE,0.05',
    'BAJAJ-AUTO29DEC269000PE,Y,"BAJAJ ""AUTO""",NFO,NFO,3,29-DEC-26,9000.5,,PE,',
    '',
    'CRUDEOIL18DEC26FUT,Z,CRUDEOIL,MCX,MCX,4,18-DEC-26,,100,FUT,1',
  ].join('\r\n')
  const app = []
  await parseInstrumentsCsv(text, async (rows) => {
    app.push(...rows)
  })
  assert.equal(app.length, 4)
  assert.deepEqual(parseInstrumentsRows(text), app)
})
