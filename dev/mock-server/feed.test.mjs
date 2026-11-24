import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import { PROFILES } from './profiles.mjs'
import { startMockServer } from './server.mjs'
import { runMain, within } from './test-helpers.mjs'

const KEY = 'ab'.repeat(32)
const HTML =
  '<!doctype html><html><head><title>OpenAlgo</title></head><body><div id="root"></div></body></html>'
const RELIANCE = { symbol: 'RELIANCE', exchange: 'NSE' }
const ALL = Object.keys(PROFILES)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every wait is bounded (within), so a regression fails its test instead of hanging the run.
const isTick = (f) => f.type === 'market_data'

async function mock(t, o = {}) {
  const m = await startMockServer({ rate: 200, authGraceMs: 100, ...o })
  t.after(() => m.close())
  return m
}

async function control(m, patch) {
  const res = await fetch(`${m.origin}/__mock/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  assert.equal(res.status, 200, await res.clone().text())
  return res.json()
}

// A client that buffers every frame; next() consumes frames up to the first match.
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const buffer = []
    let wake = () => {}
    ws.on('message', (raw) => {
      buffer.push(JSON.parse(raw.toString()))
      wake()
    })
    const closing = new Promise((r) => {
      ws.on('close', (code, reason) => r({ code, reason: reason.toString() }))
    })
    const c = {
      ws,
      buffer,
      /** The close code and reason; fails after `ms`. */
      closed: (ms = 2000) => within(closing, ms, 'close'),
      /** The close, or 'open' if the socket is still open after `ms`. */
      outcome: (ms) => within(closing, ms, 'close').catch(() => 'open'),
      send: (o) => ws.send(JSON.stringify(o)),
      ticks: () => buffer.filter(isTick),
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
    }
    ws.once('open', () => resolve(c))
    ws.once('error', reject)
  })
}

async function authed(m) {
  const c = await open(m.wsUrl)
  c.send({ action: 'authenticate', api_key: KEY })
  const auth = await c.next((f) => f.type === 'auth' || f.status === 'error')
  assert.equal(auth.status, 'success', JSON.stringify(auth))
  return c
}

async function subscribe(c, mode, extra = {}) {
  c.send({ action: 'subscribe', symbols: [RELIANCE], mode, ...extra })
  return c.next((f) => f.type === 'subscribe' || f.status === 'error')
}

// Every frame sent before this one has arrived once its reply is consumed.
function barrier(c) {
  c.send({ action: 'barrier' })
  return c.next((f) => f.code === 'INVALID_ACTION' && f.message === 'Invalid action: barrier')
}

function refused(url) {
  const refusal = new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => {
        resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body })
        ws.terminate()
      })
    })
    ws.on('open', () => reject(new Error('the upgrade was accepted')))
    ws.on('error', () => {})
  })
  return within(refusal, 2000, 'upgrade refusal')
}

// Sends a raw upgrade request and resets the connection (RST) as soon as the answer arrives,
// before the client half-closes. Resolves with the answer's status line.
function resetAfterRefusal(url) {
  const { hostname, port, pathname } = new URL(url)
  const reset = new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port), allowHalfOpen: true })
    socket.on('error', reject)
    socket.once('connect', () => {
      // RFC 6455 4.1: the key is a random 16-byte nonce, base64-encoded.
      const nonce = randomBytes(16).toString('base64')
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    socket.once('data', (chunk) => {
      socket.resetAndDestroy()
      resolve(chunk.toString('latin1').split('\r\n')[0])
    })
  })
  return within(reset, 2000, 'upgrade refusal')
}

const inParallel = (profiles, fn) => Promise.all(profiles.map(fn))

// --- Profile table: the WebSocket columns -------------------------------------

test('column 4401: from 2.0.1.6 an unauthenticated socket closes 4401 after the grace', async (t) => {
  await inParallel(ALL, async (profile) => {
    const m = await mock(t, { profile })
    const idle = await open(m.wsUrl)
    const outcome = await idle.outcome(400)
    if (['2.0.1.6', '2.0.2.0', '2.0.3.5'].includes(profile)) {
      assert.deepEqual(outcome, { code: 4401, reason: 'auth timeout' }, profile)
    } else assert.equal(outcome, 'open', profile)
  })
  const m = await mock(t)
  const c = await authed(m)
  await sleep(300)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
})

test('column orderStream: subscribe_orders from 2.0.1.6, INVALID_ACTION before', async (t) => {
  await inParallel(ALL, async (profile) => {
    const m = await mock(t, { profile })
    const c = await authed(m)
    c.send({ action: 'subscribe_orders' })
    const reply = await c.next(() => true)
    if (['1.0.0.41', '2.0.0.0'].includes(profile)) {
      assert.deepEqual(reply, {
        status: 'error',
        code: 'INVALID_ACTION',
        message: 'Invalid action: subscribe_orders',
      })
    } else {
      assert.deepEqual(reply, {
        type: 'subscribe_orders',
        status: 'success',
        message: 'Subscribed to order updates',
      })
    }
  })
})

test('column 1012: a broker logout closes 1012 on 2.0.3.5; older sockets stay open, silent', async (t) => {
  await inParallel(ALL, async (profile) => {
    const m = await mock(t, { profile })
    const c = await authed(m)
    await subscribe(c, 1)
    await c.next(isTick)
    await control(m, { brokerLoggedOut: true })
    if (profile === '2.0.3.5') {
      assert.deepEqual(await c.closed(), { code: 1012, reason: 'Broker credentials changed' })
      const again = await open(m.wsUrl)
      again.send({ action: 'authenticate', api_key: KEY })
      assert.deepEqual(await again.next(() => true), {
        status: 'error',
        code: 'BROKER_ERROR',
        message: 'No broker configuration found for user',
      })
    } else {
      await barrier(c)
      await sleep(250)
      assert.equal(c.ticks().length, 0, profile)
      assert.equal(c.ws.readyState, WebSocket.OPEN, profile)
    }
  })
})

test('column omitAbsent: absent tick fields are omitted on 2.0.3.5, sent as 0 before', async (t) => {
  await inParallel(ALL, async (profile) => {
    const m = await mock(t, { profile })
    await control(m, { absentFields: ['close'] })
    const c = await authed(m)
    await subscribe(c, 2)
    const { data } = await c.next(isTick)
    assert.ok(data.ltp > 0)
    if (profile === '2.0.3.5') {
      // an equity's oi is absent too
      assert.ok(!('close' in data) && !('oi' in data), JSON.stringify(data))
    } else {
      assert.equal(data.close, 0, profile)
      assert.equal(data.oi, 0, profile)
    }
  })
})

test('from 2.0.0.0 every profile answers a WS ping with a pong', async (t) => {
  await inParallel(ALL, async (profile) => {
    const m = await mock(t, { profile })
    const c = await open(m.wsUrl)
    c.send({ action: 'ping' })
    const reply = await c.next(() => true)
    if (profile === '1.0.0.41') {
      assert.deepEqual(reply, {
        status: 'error',
        code: 'INVALID_ACTION',
        message: 'Invalid action: ping',
      })
    } else {
      assert.equal(reply.type, 'pong')
      assert.equal(reply.status, 'success')
      assert.ok(Math.abs(reply.server_timestamp - Date.now()) < 5000)
    }
  })
})

// --- Auth, frames and subscriptions ---------------------------------------------

test('auth: the S11 success frame, key errors, and NOT_AUTHENTICATED before auth', async (t) => {
  const m = await mock(t)
  const c = await open(m.wsUrl)
  c.send({ action: 'subscribe', symbols: [RELIANCE], mode: 1 })
  assert.equal((await c.next(() => true)).code, 'NOT_AUTHENTICATED')
  c.send({ action: 'authenticate' })
  assert.deepEqual(await c.next(() => true), {
    status: 'error',
    code: 'AUTHENTICATION_ERROR',
    message: 'API key is required',
  })
  c.send({ action: 'authenticate', api_key: 'cd'.repeat(32) })
  assert.equal((await c.next(() => true)).message, 'Invalid API key')
  c.send({ action: 'authenticate', api_key: KEY })
  const ok = await c.next(() => true)
  assert.deepEqual(Object.keys(ok).sort(), [
    'broker',
    'message',
    'status',
    'supported_features',
    'type',
    'user_id',
  ])
  assert.equal(ok.type, 'auth')
  assert.equal(ok.message, 'Authentication successful')
  assert.deepEqual(ok.supported_features, { ltp: true, quote: true, depth: true })
})

test('ticks carry the S11 frame, with the fields of their mode', async (t) => {
  const m = await mock(t)
  const c = await authed(m)
  await subscribe(c, 1)
  const ltp = await c.next(isTick)
  assert.deepEqual(Object.keys(ltp).sort(), [
    'broker',
    'data',
    'exchange',
    'mode',
    'symbol',
    'type',
  ])
  assert.equal(ltp.mode, 1)
  assert.deepEqual(Object.keys(ltp.data).sort(), ['ltp', 'ltt'])
  await subscribe(c, 2)
  const quote = await c.next((f) => isTick(f) && f.mode === 2)
  for (const f of ['ltp', 'ltt', 'open', 'high', 'low', 'close', 'volume', 'average_price']) {
    assert.equal(typeof quote.data[f], 'number', f)
  }
  assert.equal(typeof quote.data.total_buy_quantity, 'number')
  assert.equal(typeof quote.data.total_sell_quantity, 'number')
})

test('the ack mode echoes the request on 2.0.0.0 and is the label on 2.0.3.5', async (t) => {
  for (const [profile, mode] of [
    ['2.0.0.0', 3],
    ['2.0.3.5', 'Depth'],
  ]) {
    const m = await mock(t, { profile })
    const c = await authed(m)
    const ack = await subscribe(c, 3, { depth: 5 })
    assert.equal(ack.status, 'success')
    assert.equal(ack.message, 'Subscription processing complete')
    assert.deepEqual(ack.subscriptions[0], {
      ...RELIANCE,
      status: 'success',
      mode,
      depth: 5,
      broker: ack.broker,
    })
  }
})

test('a numeric per-symbol unsubscribe stops ticks; a string mode on 2.0.0.0 does not', async (t) => {
  const cases = [
    ['2.0.0.0', 2, true],
    ['2.0.3.5', 2, true],
    ['2.0.0.0', 'Quote', false],
    ['2.0.3.5', 'Quote', true],
  ]
  await inParallel(cases, async ([profile, mode, stops]) => {
    const m = await mock(t, { profile })
    const c = await authed(m)
    await subscribe(c, 2)
    await c.next(isTick)
    c.send({ action: 'unsubscribe', symbols: [{ ...RELIANCE, mode }], mode })
    const ack = await c.next((f) => f.type === 'unsubscribe')
    assert.equal(ack.status, 'success')
    assert.equal(ack.successful.length, 1)
    await sleep(250)
    assert.equal(c.ticks().length === 0, stops, `${profile} ${mode}`)
  })
})

test('control maxDepth: the ack and the ticks follow the adapter depth (5, 20 or 30)', async (t) => {
  const m = await mock(t)
  for (const [maxDepth, requested, depth] of [
    [20, 20, 20],
    [5, 20, 5],
    [30, 30, 30],
  ]) {
    await control(m, { maxDepth })
    const c = await authed(m)
    const ack = await subscribe(c, 3, { depth: requested })
    assert.equal(ack.subscriptions[0].depth, depth)
    const { data } = await c.next(isTick)
    assert.equal(data.depth.buy.length, depth)
    assert.equal(data.depth.sell.length, depth)
    assert.deepEqual(Object.keys(data.depth.buy[0]).sort(), ['orders', 'price', 'quantity'])
    assert.ok(data.depth.buy[0].price < data.depth.sell[0].price)
    assert.equal(typeof data.close, 'number')
    c.ws.close()
  }
})

test('control ackEchoesDepth: the ack says 20 while ticks carry 5 levels', async (t) => {
  const m = await mock(t)
  await control(m, { maxDepth: 5, ackEchoesDepth: true })
  const c = await authed(m)
  const ack = await subscribe(c, 3, { depth: 20 })
  assert.equal(ack.subscriptions[0].depth, 20)
  const { data } = await c.next(isTick)
  assert.equal(data.depth.buy.length, 5)
  assert.equal(data.depth.sell.length, 5)
})

test('control wsBrokerError: auth answers BROKER_ERROR and the socket stays open', async (t) => {
  const m = await mock(t)
  await control(m, { wsBrokerError: true })
  const c = await open(m.wsUrl)
  c.send({ action: 'authenticate', api_key: KEY })
  assert.deepEqual(await c.next(() => true), {
    status: 'error',
    code: 'BROKER_ERROR',
    message: 'No broker configuration found for user',
  })
  const ack = await subscribe(c, 1)
  assert.deepEqual(ack, {
    status: 'error',
    code: 'BROKER_ERROR',
    message: 'Broker adapter not found',
  })
  await sleep(250)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
  assert.equal(c.ticks().length, 0)
})

test('control wsPingUnsupported: ping gets INVALID_ACTION', async (t) => {
  const m = await mock(t)
  await control(m, { wsPingUnsupported: true })
  const c = await authed(m)
  c.send({ action: 'ping' })
  assert.deepEqual(await c.next(() => true), {
    status: 'error',
    code: 'INVALID_ACTION',
    message: 'Invalid action: ping',
  })
})

test('control emitOrderUpdate reaches only subscribe_orders subscribers', async (t) => {
  const m = await mock(t)
  const subscriber = await authed(m)
  const other = await authed(m)
  subscriber.send({ action: 'subscribe_orders' })
  await subscriber.next((f) => f.type === 'subscribe_orders')
  await control(m, { analyzer: true })
  await control(m, { emitOrderUpdate: { orderid: 'X1', order_status: 'rejected' } })
  const update = await subscriber.next((f) => f.type === 'order_update')
  assert.equal(update.orderid, 'X1')
  assert.equal(update.order_status, 'rejected')
  assert.equal(update.mode, 'analyze')
  for (const f of ['user_id', 'broker', 'symbol', 'exchange', 'action', 'quantity', 'price']) {
    assert.ok(f in update, f)
  }
  // `other` has no subscriptions, so the first frame it gets must be the barrier's reply.
  other.send({ action: 'barrier' })
  assert.equal((await other.next(() => true)).message, 'Invalid action: barrier')
})

test('control silenceFeed stops ticks until it is cleared', async (t) => {
  const m = await mock(t)
  const c = await authed(m)
  await subscribe(c, 2)
  await c.next(isTick)
  await control(m, { silenceFeed: true })
  await barrier(c)
  await sleep(250)
  assert.equal(c.ticks().length, 0)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
  await control(m, { silenceFeed: false })
  await c.next(isTick)
})

test('control closeSockets closes every socket with the code (1006 drops them)', async (t) => {
  const m = await mock(t)
  const a = await authed(m)
  const b = await open(m.wsUrl)
  await control(m, { closeSockets: 4000 })
  assert.equal((await a.closed()).code, 4000)
  assert.equal((await b.closed()).code, 4000)
  const c = await authed(m)
  await control(m, { closeSockets: 1006 })
  assert.equal((await c.closed()).code, 1006)
})

test('a ban refuses the upgrade with 403 in the ban form', async (t) => {
  const m = await mock(t)
  await control(m, { banned: 'text' })
  const text = await refused(m.wsUrl)
  assert.equal(text.status, 403)
  assert.match(text.type, /^text\/plain/)
  assert.equal(text.body, 'Access Denied: Your IP has been banned')
  await control(m, { banned: 'json' })
  const json = await refused(m.wsUrl)
  assert.equal(json.status, 403)
  assert.deepEqual(JSON.parse(json.body), { error: 'Access Denied' })
})

test('a WS upgrade on the REST port gets the 404 html page', async (t) => {
  const m = await mock(t, { wsPort: 'off' })
  assert.equal(m.wsUrl, null)
  const r = await refused(`${m.origin.replace('http', 'ws')}/ws`)
  assert.equal(r.status, 404)
  assert.match(r.type, /^text\/html/)
  assert.equal(r.body, HTML)
})

test('a client reset after an upgrade refusal (REST-port 404, ban 403) leaves the mock up', async (t) => {
  const m = await mock(t)
  assert.match(await resetAfterRefusal(`${m.origin.replace('http', 'ws')}/ws`), / 404 /)
  await control(m, { banned: 'json' })
  assert.match(await resetAfterRefusal(m.wsUrl), / 403 /)
  // The server sees the RST on its next read; an unhandled 'error' there would throw here.
  await sleep(100)
  await control(m, { banned: false })
  const c = await authed(m)
  assert.equal(c.ws.readyState, WebSocket.OPEN)
})

test('GET /__mock/control returns the state plus request and WS stats', async (t) => {
  const m = await mock(t)
  const c = await authed(m)
  c.send({ action: 'authenticate', api_key: 'cd'.repeat(32) })
  await c.next((f) => f.code === 'AUTHENTICATION_ERROR')
  await refused(`${m.origin.replace('http', 'ws')}/ws`)
  for (const path of ['/api/v1/funds', '/api/v1/funds', '/auth/app-info']) {
    await fetch(m.origin + path, { method: path.startsWith('/api') ? 'POST' : 'GET' })
  }
  const state = await (await fetch(`${m.origin}/__mock/control`)).json()
  assert.equal(state.profile, '2.0.3.5')
  assert.equal(state.maxDepth, 5)
  assert.equal(state.banned, false)
  assert.deepEqual(state.stats, {
    requests: { funds: 2, '/auth/app-info': 1, '/ws': 1 },
    wsConnections: 1,
    wsAuthAttempts: 2,
  })
})

test('main.mjs reads AUTH_GRACE_MS', async (t) => {
  const ready = await runMain(t, {
    PORT: '0',
    WS_PORT: '0',
    PROFILE: '2.0.1.6',
    AUTH_GRACE_MS: '100',
  })
  const wsUrl = / ws=(\S+)$/.exec(ready)[1]
  const c = await open(wsUrl)
  const outcome = await c.outcome(1000)
  assert.deepEqual(outcome, { code: 4401, reason: 'auth timeout' })
})
