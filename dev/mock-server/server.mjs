// startMockServer: the REST port, the WS proxy port and the /__mock control routes.
import http from 'node:http'
import { createFeed } from './feed.mjs'
import { createGttEngine } from './gtt.mjs'
import { createOrderEngine } from './orders.mjs'
import { createPriceBook } from './prices.mjs'
import { createRest } from './rest.mjs'
import {
  ControlError,
  createState,
  DEFAULT_API_KEY,
  DEFAULT_BROKER,
  DEFAULT_PROFILE,
} from './state.mjs'

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function stop(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new ControlError('the patch is not JSON')
  }
}

/**
 * Starts the mock. `wsPort: 'off'` runs no WS proxy (wsUrl is null), and port 0 picks a
 * free port. A wildcard host is reported as 127.0.0.1, which the app accepts in __DEV__.
 * `broker` is the start value of the broker control, which /__mock/reset restores.
 */
export async function startMockServer(o = {}) {
  const {
    port = 0,
    wsPort = 0,
    host = '127.0.0.1',
    profile = DEFAULT_PROFILE,
    apiKey = DEFAULT_API_KEY,
    rate = 10,
    authGraceMs = 15_000,
    broker = DEFAULT_BROKER,
  } = o
  const state = createState({ profile, broker })
  const prices = createPriceBook()
  const orders = createOrderEngine({ state, prices })
  const gtt = createGttEngine({ state, prices })
  const rest = createRest({ state, prices, apiKey, orders, gtt })
  const snapshot = () => {
    const s = state.snapshot()
    s.stats.orders = orders.counts()
    return s
  }

  // The control routes keep working while the mock is banned or rate limited.
  async function control(req, res, pathname) {
    try {
      if (req.method === 'GET' && pathname === '/__mock/control') {
        return reply(res, 200, snapshot())
      }
      if (req.method === 'POST' && pathname === '/__mock/control') {
        state.patch(await readJson(req))
        return reply(res, 200, snapshot())
      }
      if (req.method === 'POST' && pathname === '/__mock/reset') {
        state.reset()
        prices.reset()
        orders.reset()
        gtt.reset()
        return reply(res, 200, snapshot())
      }
      return reply(res, 404, { error: `no mock route ${req.method} ${pathname}` })
    } catch (e) {
      if (e instanceof ControlError) return reply(res, 400, { error: e.message })
      throw e
    }
  }

  const restServer = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://mock')
    const done = pathname.startsWith('/__mock/')
      ? control(req, res, pathname)
      : rest.handle(req, res)
    done.catch((e) => {
      console.error('mock-server:', e)
      if (!res.headersSent) reply(res, 500, { error: 'mock server error' })
      res.end()
    })
  })
  restServer.on('upgrade', (req, socket) => rest.upgrade(req, socket))

  let feed = null
  let feedServer = null
  if (wsPort !== 'off') {
    feed = createFeed({ state, prices, apiKey, rate, authGraceMs })
    orders.onUpdate((u) => feed.orderUpdate(u))
    feedServer = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' })
      res.end('Upgrade Required')
    })
    feedServer.on('upgrade', (req, socket, head) => feed.handleUpgrade(req, socket, head))
  }

  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  let restPort
  let feedPort = null
  try {
    restPort = await listen(restServer, port, host)
    if (feedServer) feedPort = await listen(feedServer, wsPort, host)
  } catch (e) {
    feed?.close()
    if (restServer.listening) await stop(restServer)
    throw e
  }

  return {
    origin: `http://${shown}:${restPort}`,
    wsUrl: feedServer ? `ws://${shown}:${feedPort}` : null,
    state,
    async close() {
      feed?.close()
      await Promise.all([stop(restServer), feedServer && stop(feedServer)])
    },
  }
}
