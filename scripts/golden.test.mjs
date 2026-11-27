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
import { CASES, recordedCalls, requestKey, stableJson } from './lib/golden-keys.mjs'
import { loadTestEnv } from './lib/test-env.mjs'
import { mockOriginRefusal } from './record-fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const RECORD = join(root, 'scripts/record-fixtures.mjs')
const GEN = join(root, 'scripts/gen-golden.mjs')
const INPUTS = join(root, 'test/golden/inputs')
const EXPECTED = join(root, 'test/golden/expected')
const ROUTES = [
  'get_oi_data',
  'calculate_max_pain',
  'get_iv_smile_data',
  'get_gex_data',
  'calculate_gamma_density',
]
const LEAK = /api_?key/i

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

test('record-fixtures --mock writes the recorded calls for a case and no key', async (t) => {
  const origin = await mockOrigin(t)
  const out = tmp(t)
  const r = await run(RECORD, ['--mock', origin, '--out', out])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [
    'mock-banknifty.json: 6 calls',
    'mock-nifty.json: 6 calls',
    'mock-sensex.json: 6 calls',
  ])
  assert.ok(!r.stdout.includes(origin) && !r.stdout.includes(KEY))
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
      'responses',
    ])
    assert.equal(input.case, c.id)
    assert.equal(input.source, 'mock')
    assert.match(input.expiry, /^\d{2}[A-Z]{3}\d{2}$/)
    const keys = Object.keys(input.responses)
    assert.deepEqual(keys, [...keys].sort())
    const calls = recordedCalls(c, input.expiry, input.fut)
    assert.deepEqual(keys, calls.map((x) => requestKey(x.endpoint, x.body)).sort())
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

/** A server that answers every read with success, and `extra` merged into each body. */
async function stubServer(t, extra) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
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
    const c = CASES.find((x) => x.id === input.case)
    const chain25 = recordedCalls(c, input.expiry, input.fut)[3]
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
  assert.ok(b76.edges.length >= 3)
  assert.equal(b76.symbols.length, 12)
})
