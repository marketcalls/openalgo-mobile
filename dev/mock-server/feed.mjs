// The stock server's WebSocket proxy (websocket_proxy/server.py; plan contract S11-S12). Frame
// shapes are ported from spike/mock-feed/server.mjs and follow the contract where they differ.
import { WebSocketServer } from 'ws'
import { step, tickData } from './prices.mjs'
import { banReply, writeRaw } from './rest.mjs'
import { BROKER, USER_ID } from './state.mjs'

const TICK_MS = 20
const MODE_LABEL = { 1: 'LTP', 2: 'Quote', 3: 'Depth' }
const MODE_BY_NAME = { LTP: 1, QUOTE: 2, DEPTH: 3 }
const TITLE_CASE_MODES = { LTP: 1, Quote: 2, Depth: 3 } // before 2.0.1.1
const CLOSE_REASON = {
  1001: 'server shutting down',
  1012: 'Broker credentials changed',
  4401: 'auth timeout',
}

/** websocket_proxy/mode_utils.py normalize_mode: 1-3 or LTP/Quote/Depth in any case. */
function normalizeMode(v) {
  if (Number.isInteger(v) && MODE_LABEL[v]) return v
  if (typeof v === 'string' && MODE_BY_NAME[v.trim().toUpperCase()]) {
    return MODE_BY_NAME[v.trim().toUpperCase()]
  }
  throw new RangeError(
    `Invalid mode ${JSON.stringify(v)}; expected 1 (LTP), 2 (Quote), or 3 (Depth)`,
  )
}

/** The numeric mode the server files a subscription under, by profile. */
function subscribeMode(version, raw) {
  if (version.modeLabels) return normalizeMode(raw)
  const mode = typeof raw === 'string' ? TITLE_CASE_MODES[raw] : raw
  if (!MODE_LABEL[mode]) throw new RangeError(`Invalid mode ${JSON.stringify(raw)}`)
  return mode
}

const DEFAULT_ORDER_UPDATE = {
  orderid: '25112400000001',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  action: 'BUY',
  quantity: 1,
  price: 0,
  trigger_price: 0,
  pricetype: 'MARKET',
  product: 'MIS',
  order_status: 'complete',
  filled_quantity: 1,
  pending_quantity: 0,
  average_price: 1424.05,
  rejection_reason: '',
}

export function createFeed({ state, prices, apiKey, rate, authGraceMs }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const clients = new Set()

  const send = (c, obj) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(obj))
  }
  const error = (c, code, message) => send(c, { status: 'error', code, message })

  function close(c, code) {
    // 1006 is an abnormal closure, which no close frame can carry: drop the connection.
    if (code === 1006) c.ws.terminate()
    else c.ws.close(code, CLOSE_REASON[code] ?? '')
  }

  function authenticate(c, data) {
    state.stats.wsAuthAttempts++
    const key = data.api_key ?? data.apikey
    if (!key) return error(c, 'AUTHENTICATION_ERROR', 'API key is required')
    if (key !== apiKey) return error(c, 'AUTHENTICATION_ERROR', 'Invalid API key')
    // The user is mapped before the broker lookup, so a BROKER_ERROR socket stays open.
    c.authed = true
    clearTimeout(c.authTimer)
    const s = state.current
    if (s.wsBrokerError || s.brokerLoggedOut) {
      c.adapter = false
      return error(c, 'BROKER_ERROR', 'No broker configuration found for user')
    }
    c.adapter = true
    send(c, {
      type: 'auth',
      status: 'success',
      message: 'Authentication successful',
      broker: BROKER,
      user_id: USER_ID,
      supported_features: { ltp: true, quote: true, depth: true },
    })
  }

  function subscribe(c, data) {
    if (!c.authed) return error(c, 'NOT_AUTHENTICATED', 'You must authenticate first')
    const version = state.version
    const raw = data.mode ?? 'Quote'
    let mode
    try {
      mode = subscribeMode(version, raw)
    } catch (e) {
      return error(c, 'INVALID_MODE', e.message)
    }
    let symbols = Array.isArray(data.symbols) ? data.symbols : []
    if (!symbols.length && data.symbol && data.exchange) {
      symbols = [{ symbol: data.symbol, exchange: data.exchange }]
    }
    if (!symbols.length) {
      return error(c, 'INVALID_PARAMETERS', 'At least one symbol must be specified')
    }
    if (!c.adapter) return error(c, 'BROKER_ERROR', 'Broker adapter not found')

    const { maxDepth, ackEchoesDepth } = state.current
    const requested = Number.isInteger(data.depth) && data.depth > 0 ? data.depth : 5
    // The ack reports the adapter's actual_depth, or echoes the request when it has none.
    const levels = Math.min(requested, maxDepth)
    const ackDepth = mode === 3 && !ackEchoesDepth ? levels : requested
    const subscriptions = []
    for (const s of symbols) {
      if (!s?.symbol || !s?.exchange) continue
      const key = `${s.exchange}:${s.symbol}`
      if (!c.subs.has(key)) {
        c.subs.set(key, { symbol: s.symbol, exchange: s.exchange, modes: new Map() })
      }
      c.subs.get(key).modes.set(mode, levels)
      subscriptions.push({
        symbol: s.symbol,
        exchange: s.exchange,
        status: 'success',
        mode: version.modeLabels ? MODE_LABEL[mode] : raw,
        depth: ackDepth,
        broker: BROKER,
      })
    }
    send(c, {
      type: 'subscribe',
      status: 'success',
      subscriptions,
      message: 'Subscription processing complete',
      broker: BROKER,
    })
  }

  function unsubscribe(c, data, action) {
    if (!c.authed) return error(c, 'NOT_AUTHENTICATED', 'You must authenticate first')
    const all = action === 'unsubscribe_all'
    const symbols = Array.isArray(data.symbols) ? data.symbols : []
    if (!all && !symbols.length) {
      return error(c, 'INVALID_PARAMETERS', 'Either symbols or unsubscribe_all is required')
    }
    if (!c.adapter) return error(c, 'BROKER_ERROR', 'Broker adapter not found')
    const labels = state.version.modeLabels
    const entry = (s, mode) => ({
      symbol: s.symbol,
      exchange: s.exchange,
      ...(labels ? { mode: MODE_LABEL[mode] ?? null } : {}),
      status: 'success',
      broker: BROKER,
    })
    const successful = []
    const failed = []
    if (all) {
      for (const sub of c.subs.values()) {
        for (const mode of sub.modes.keys()) successful.push(entry(sub, mode))
      }
      c.subs.clear()
    }
    for (const s of all ? [] : symbols) {
      if (!s?.symbol || !s?.exchange) continue
      let mode = 'mode' in s ? s.mode : (data.mode ?? 2)
      if (labels) {
        try {
          mode = normalizeMode(mode)
        } catch (e) {
          failed.push({ ...entry(s, null), status: 'error', message: e.message })
          continue
        }
      }
      // Before 2.0.1.1 only the numeric mode matches, and a miss still reports success.
      const key = `${s.exchange}:${s.symbol}`
      const sub = c.subs.get(key)
      sub?.modes.delete(mode)
      if (sub && !sub.modes.size) c.subs.delete(key)
      successful.push(entry(s, mode))
    }
    const status = failed.length ? (successful.length ? 'partial' : 'error') : 'success'
    send(c, {
      type: 'unsubscribe',
      status,
      message: 'Unsubscription processing complete',
      successful,
      failed,
      broker: BROKER,
    })
  }

  function orders(c, on) {
    const action = on ? 'subscribe_orders' : 'unsubscribe_orders'
    if (!state.version.orderStream) return error(c, 'INVALID_ACTION', `Invalid action: ${action}`)
    if (!c.authed) return error(c, 'NOT_AUTHENTICATED', 'You must authenticate first')
    c.orders = on
    send(c, {
      type: action,
      status: 'success',
      message: on ? 'Subscribed to order updates' : 'Unsubscribed from order updates',
    })
  }

  function ping(c, data) {
    if (!state.version.wsPing || state.current.wsPingUnsupported) {
      return error(c, 'INVALID_ACTION', 'Invalid action: ping')
    }
    const pong = { type: 'pong', status: 'success', server_timestamp: Date.now() }
    if (data.timestamp !== undefined) pong.client_timestamp = data.timestamp
    if (data._pingId !== undefined) pong._pingId = data._pingId
    send(c, pong)
  }

  function onMessage(c, raw) {
    let data
    try {
      data = JSON.parse(raw.toString())
    } catch {
      return error(c, 'INVALID_JSON', 'Invalid JSON message')
    }
    if (!data || typeof data !== 'object') return error(c, 'INVALID_JSON', 'Invalid JSON message')
    const action = data.action ?? data.type
    switch (action) {
      case 'authenticate':
      case 'auth':
        return authenticate(c, data)
      case 'subscribe':
        return subscribe(c, data)
      case 'unsubscribe':
      case 'unsubscribe_all':
        return unsubscribe(c, data, action)
      case 'subscribe_orders':
        return orders(c, true)
      case 'unsubscribe_orders':
        return orders(c, false)
      case 'ping':
        return ping(c, data)
      default:
        return error(c, 'INVALID_ACTION', `Invalid action: ${action}`)
    }
  }

  function onConnection(ws) {
    const c = {
      ws,
      authed: false,
      adapter: false,
      subs: new Map(),
      orders: false,
      credit: 0,
      turn: 0,
    }
    // From 2.0.0.5 a socket that does not authenticate in time is closed (S11).
    if (state.version.authDeadline) {
      c.authTimer = setTimeout(() => {
        if (!c.authed) close(c, 4401)
      }, authGraceMs)
    }
    clients.add(c)
    ws.on('message', (raw) => onMessage(c, raw))
    ws.on('close', () => {
      clearTimeout(c.authTimer)
      clients.delete(c)
    })
    ws.on('error', () => {})
  }

  // A tick for one subscription, at its highest mode, with the profile's absent-field rule.
  function tickFrame(sub) {
    const st = prices.get(sub.symbol, sub.exchange)
    step(st)
    const mode = Math.max(...sub.modes.keys())
    const data = tickData(st, mode, sub.modes.get(3) ?? 0)
    const absent = state.current.absentFields
    for (const k of Object.keys(data)) {
      if (data[k] !== undefined && !absent.includes(k)) continue
      // S10: from 2.0.3.3 a field the broker did not send is omitted; before, it is 0.
      if (state.version.omitAbsent) delete data[k]
      else data[k] = 0
    }
    return {
      type: 'market_data',
      symbol: sub.symbol,
      exchange: sub.exchange,
      mode,
      broker: BROKER,
      data,
    }
  }

  let last = performance.now()
  const ticker = setInterval(() => {
    const now = performance.now()
    const dt = now - last
    last = now
    const s = state.current
    if (s.silenceFeed || s.brokerLoggedOut) return
    for (const c of clients) {
      if (!c.adapter || !c.subs.size || c.ws.readyState !== c.ws.OPEN) continue
      // Credit pacing keeps `rate` ticks/s per connection, round-robin over its symbols.
      c.credit = Math.min(c.credit + (rate * dt) / 1000, Math.max(1, rate * 0.2))
      const subs = [...c.subs.values()]
      for (; c.credit >= 1; c.credit--) send(c, tickFrame(subs[c.turn++ % subs.length]))
    }
  }, TICK_MS)

  const offPatch = state.onPatch((p, prev) => {
    if (p.closeSockets !== undefined) for (const c of clients) close(c, p.closeSockets)
    if (p.emitOrderUpdate) {
      const extra = typeof p.emitOrderUpdate === 'object' ? p.emitOrderUpdate : {}
      const update = {
        type: 'order_update',
        user_id: USER_ID,
        mode: state.current.analyzer ? 'analyze' : 'live',
        broker: BROKER,
        ...DEFAULT_ORDER_UPDATE,
        ...extra,
      }
      for (const c of clients) if (c.authed && c.orders) send(c, update)
    }
    // From 2.0.3.5 a broker logout closes the user's sockets 1012; before, they go silent.
    if (state.current.brokerLoggedOut && !prev.brokerLoggedOut && state.version.close1012) {
      for (const c of clients) if (c.authed) close(c, 1012)
    }
  })

  return {
    handleUpgrade(req, socket, head) {
      state.stats.wsConnections++
      const banned = state.current.banned
      if (banned) return writeRaw(socket, banReply(banned))
      wss.handleUpgrade(req, socket, head, onConnection)
    },
    close() {
      clearInterval(ticker)
      offPatch()
      for (const c of clients) c.ws.terminate()
      wss.close()
    },
  }
}
