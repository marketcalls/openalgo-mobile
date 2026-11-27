// Records the /api/v1 replies the golden tests feed the server's Python with (design 9.2):
//   npm run record-fixtures -- --mock <url> | --real | --from <raw dir>  [--out <dir>] [--case <id>]...
// --mock reads a local mock with its key; --real reads the test server in .env.test.local (in
// analyzer mode only); --from converts the controller's raw recordings (record-raw.mjs). Each
// case becomes <out>/<source>-<case>.json (default test/golden/inputs). Only reads are sent.
// Nothing is written when any case is refused: a failed read, or a reply holding the key or an
// api key field. Only file names and call counts are printed, never a URL or the key.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DEFAULT_API_KEY } from '../dev/mock-server/state.mjs'
import {
  CASES,
  chainCall,
  expiryCalls,
  LEGS_CHAIN,
  recordedCalls,
  requestKey,
} from './lib/golden-keys.mjs'
import { loadTestEnv } from './lib/test-env.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEST_ENV = join(ROOT, '.env.test.local')
const DEFAULT_OUT = join(ROOT, 'test/golden/inputs')
const TIMEOUT_MS = 30_000
/** Between two reads of the real server, as the controller's recorder paces them. */
const REAL_PACE_MS = 400
const KEY_FIELD = /api_?key/i
const RAW_FILE = /^(?:real|mock)-[a-z]+\.json$/
const TOP_KEYS = ['case', 'source', 'serverNowMs', 'underlying', 'exchange', 'expiry', 'fut']
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/

/** A case that cannot be stored; the message names no URL and no key. */
class Refused extends Error {}

/**
 * Why `--mock <url>` must not run, or null: it would reach the real test server (its origin in
 * .env.test.local, loopback names counted as one host), which the mock's key must never reach.
 */
export function mockOriginRefusal(url, real) {
  if (!real) return null
  const origin = (u) => {
    const x = new URL(u)
    const port = x.port || (x.protocol === 'https:' ? '443' : '80')
    return `${LOOPBACK.test(x.hostname) ? 'loopback' : x.hostname}:${port}`
  }
  return origin(url) === origin(real.url)
    ? '--mock points at the real test server in .env.test.local; run the mock with PORT=5099 WS_PORT=8799 HOST=127.0.0.1'
    : null
}

const compact = (e) => e.replaceAll('-', '')
const succeeded = (r) => r.status === 200 && r.json?.status === 'success'

/** The case's expiry from the options list (DD-MMM-YY, sorted), as DDMMMYY. */
function pickExpiry(c, options) {
  if (!Array.isArray(options) || options.length === 0) throw new Refused('no option expiries')
  const month = options[0].slice(3)
  const monthly = options.filter((d) => d.slice(3) === month).at(-1)
  return compact(c.pick === 'monthly' ? monthly : options[0])
}

/** The same-expiry future, else the first listed (oi_tracker_service.py:24-117); null with none. */
function futureSymbol(c, expiry, futures) {
  const list = Array.isArray(futures) ? futures.map(compact) : []
  const at = list.includes(expiry) ? expiry : list[0]
  return at ? `${c.underlying}${at}FUT` : null
}

/** serverNowMs: the chain's server_ts, else its Date header (servers before 2.0.2.0). */
function serverNow(reply) {
  const ms =
    typeof reply.json.server_ts === 'number' ? reply.json.server_ts * 1000 : Date.parse(reply.date)
  if (!Number.isFinite(ms)) throw new Refused(`the chain at ${LEGS_CHAIN} has no server clock`)
  return ms
}

/** The file's text: fixed top-level order, sorted responses, 2-space indent, trailing newline. */
function inputText(input) {
  const responses = Object.fromEntries(
    Object.keys(input.responses)
      .sort()
      .map((k) => [k, input.responses[k]]),
  )
  const top = Object.fromEntries(TOP_KEYS.map((k) => [k, input[k]]))
  return `${JSON.stringify({ ...top, responses }, null, 2)}\n`
}

function checkedText(input, keys) {
  const text = inputText(input)
  if (keys.some((k) => k && text.includes(k)) || KEY_FIELD.test(text)) {
    throw new Refused('a reply holds the key or an api key field')
  }
  return text
}

/** Records one case through `send(endpoint, body)` → { status, date, json }. */
async function recordCase(c, { source, send, withGreeks }) {
  const responses = {}
  const replies = {}
  const read = async ({ endpoint, body }) => {
    const r = await send(endpoint, body)
    if (!succeeded(r))
      throw new Refused(`${endpoint} answered ${r.status} ${r.json?.status ?? 'non-JSON'}`)
    const key = requestKey(endpoint, body)
    responses[key] = r.json
    replies[key] = r
    return r
  }
  const [options, futures] = expiryCalls(c)
  const expiry = pickExpiry(c, (await read(options)).json.data)
  const fut = futureSymbol(c, expiry, (await read(futures)).json.data)
  const legsKey = requestKey('optionchain', chainCall(c, expiry, LEGS_CHAIN).body)
  for (const call of recordedCalls(c, expiry, fut, { withGreeks }).slice(2)) {
    // with_greeks is a 2.0.2.0 field; so is the chain's server_ts
    if (call.body.with_greeks && typeof replies[legsKey].json.server_ts !== 'number') continue
    await read(call)
  }
  const { underlying, exchange } = c
  const serverNowMs = serverNow(replies[legsKey])
  return { case: c.id, source, serverNowMs, underlying, exchange, expiry, fut, responses }
}

/** One raw recording (record-raw.mjs shape) as an input: the analyzer read dropped, extras kept. */
function fromRaw(rec) {
  const c = CASES.find((x) => x.id === rec.case)
  if (!c || !['real', 'mock'].includes(rec.source)) throw new Refused('not a golden case')
  const calls = (rec.calls ?? []).filter((x) => x.endpoint !== 'analyzer')
  const bad = calls.filter((x) => !succeeded(x))
  if (bad.length) throw new Refused(`${bad.length} reads did not succeed`)
  const responses = {}
  const replies = {}
  for (const x of calls) {
    const key = requestKey(x.endpoint, x.body)
    responses[key] = x.json
    replies[key] = { json: x.json, date: x.dateHeader }
  }
  const expiry = compact(String(rec.expiry))
  const fut = rec.fut ?? null
  for (const x of recordedCalls(c, expiry, fut)) {
    if (!(requestKey(x.endpoint, x.body) in responses))
      throw new Refused(`no ${x.endpoint} read for the case`)
  }
  const serverNowMs = serverNow(
    replies[requestKey('optionchain', chainCall(c, expiry, LEGS_CHAIN).body)],
  )
  const { underlying, exchange } = c
  return {
    case: c.id,
    source: rec.source,
    serverNowMs,
    underlying,
    exchange,
    expiry,
    fut,
    responses,
  }
}

function parseRaw(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Refused('the file is not JSON')
  }
}

function client(url, key, paceMs) {
  const base = url.replace(/\/+$/, '')
  return async (endpoint, body) => {
    let r
    try {
      const res = await fetch(`${base}/api/v1/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: key, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {}
      r = { status: res.status, date: res.headers.get('date'), json }
    } catch (e) {
      throw new Refused(`${endpoint}: the request failed (${e?.name ?? 'Error'})`)
    }
    if (paceMs) await new Promise((ok) => setTimeout(ok, paceMs))
    return r
  }
}

function usage(message) {
  console.log(`record-fixtures: ${message}`)
  console.log('usage: --mock <url> | --real | --from <raw dir>  [--out <dir>] [--case <id>]...')
  process.exit(2)
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        mock: { type: 'string' },
        real: { type: 'boolean' },
        from: { type: 'string' },
        out: { type: 'string' },
        case: { type: 'string', multiple: true },
      },
    }))
  } catch (e) {
    usage(e.message)
  }
  const modes = ['mock', 'real', 'from'].filter((m) => values[m] !== undefined)
  if (modes.length !== 1) usage('give exactly one of --mock, --real and --from')
  const only = values.case ?? []
  const unknown = only.filter((id) => !CASES.some((c) => c.id === id))
  if (unknown.length) usage(`unknown case ${unknown.join(', ')}`)
  const chosen = (c) => only.length === 0 || only.includes(c.id)
  const out = resolve(values.out ?? DEFAULT_OUT)
  const real = loadTestEnv(TEST_ENV)

  const files = [] // [name, text, calls]
  const refuse = (id, e) => {
    if (!(e instanceof Refused)) throw e
    console.log(`${id}: refused, ${e.message}`)
    return true
  }
  let refused = false
  if (values.from) {
    const dir = resolve(values.from)
    for (const name of readdirSync(dir)
      .filter((f) => RAW_FILE.test(f))
      .sort()) {
      const id = name.replace(/^[a-z]+-|\.json$/g, '')
      if (!chosen({ id })) continue
      try {
        const input = fromRaw(parseRaw(readFileSync(join(dir, name), 'utf8')))
        const text = checkedText(input, [real?.key, DEFAULT_API_KEY])
        files.push([
          `${input.source}-${input.case}.json`,
          text,
          Object.keys(input.responses).length,
        ])
      } catch (e) {
        refused = refuse(id, e) || refused
      }
    }
  } else {
    const source = values.real ? 'real' : 'mock'
    let url
    let key
    if (source === 'real') {
      if (!real) usage('.env.test.local is missing or incomplete')
      ;({ url, key } = real)
    } else {
      let refusal
      try {
        if (!/^https?:$/.test(new URL(values.mock).protocol)) throw new Error('not http')
        refusal = mockOriginRefusal(values.mock, real)
      } catch {
        usage('--mock needs an http(s) URL')
      }
      if (refusal) usage(refusal)
      url = values.mock
      key = process.env.MOCK_API_KEY ?? DEFAULT_API_KEY
    }
    const send = client(url, key, source === 'real' ? REAL_PACE_MS : 0)
    if (source === 'real') {
      const mode = await send('analyzer', {}).catch(() => null)
      if (mode?.json?.data?.mode !== 'analyze')
        usage('the test server is not in analyzer mode; only its mode was read')
    }
    for (const c of CASES.filter((x) => chosen(x) && (source === 'real' || !x.realOnly))) {
      try {
        const input = await recordCase(c, { source, send, withGreeks: source === 'real' })
        const text = checkedText(input, [key])
        files.push([`${source}-${c.id}.json`, text, Object.keys(input.responses).length])
      } catch (e) {
        refused = refuse(c.id, e) || refused
      }
    }
  }
  if (refused) process.exit(1)
  if (files.length === 0) usage('no case to record')
  mkdirSync(out, { recursive: true })
  for (const [name, text, calls] of files) {
    writeFileSync(join(out, name), text)
    console.log(`${name}: ${calls} calls`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    const message = String(e?.message ?? '')
      .replace(/https?:\/\/\S+/g, '<url>')
      .replace(/api_?key\S*/gi, '<redacted>')
    console.log(`record-fixtures: ${e?.name ?? 'Error'}: ${message}`)
    process.exit(1)
  })
}
