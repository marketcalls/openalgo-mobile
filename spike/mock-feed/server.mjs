// THROWAWAY SPIKE. Mock OpenAlgo WebSocket server (market-data subset) so the RN spike can be benchmarked over a real socket without a broker.
//
// Mirrors openalgo/websocket_proxy/server.py for the messages the app uses:
//   - 15 s auth grace window, then close(4401, 'auth timeout')
//   - {"action":"authenticate","api_key":...}      -> {"type":"auth","status":"success",...}
//   - {"action":"subscribe","symbols":[...],"mode"} -> {"type":"subscribe","status":"success","subscriptions":[...]}
//   - {"action":"unsubscribe"|"unsubscribe_all"}    -> {"type":"unsubscribe",...}
//   - {"action":"ping"}                             -> {"type":"pong","status":"success","server_timestamp":...}
//   - errors use the real server's shape: {"status":"error","code":...,"message":...,"request_id"?}
//   - one market_data message per WebSocket frame, like the real proxy
//
// Env: PORT (8765), HOST (0.0.0.0), RATE (300 market_data msgs/s PER CONNECTION,
// spread over that connection's subscriptions), MOCK_API_KEY (unset = accept any
// non-empty key), AUTH_TIMEOUT_MS (15000), QUIET=1 (no per-client stats lines).
import os from 'node:os';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8765);
const HOST = process.env.HOST ?? '0.0.0.0';
const RATE = Number(process.env.RATE ?? 300);
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS ?? 15_000);
const API_KEY = process.env.MOCK_API_KEY ?? '';
const QUIET = process.env.QUIET === '1';
const BROKER = 'mock';
const TICK_MS = 20; // scheduler granularity: 50 bursts/s
const MAX_BUFFERED = 8 * 1024 * 1024; // drop (and count) ticks if a client stops reading
const STATS_MS = 5_000;

for (const [name, v] of Object.entries({ PORT, RATE, AUTH_TIMEOUT_MS })) {
  if (!Number.isFinite(v) || v < 0) {
    console.error(`Invalid ${name}=${process.env[name]}`);
    process.exit(2);
  }
}

// --- Deterministic per-symbol random walk -----------------------------------
function hash32(str) {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r05 = (x) => Math.max(0.05, Math.round(x * 20) / 20); // NSE tick size 0.05
const r2 = (x) => Math.round(x * 100) / 100;

const UNDERLYING = { NIFTY: 24000, BANKNIFTY: 52000, FINNIFTY: 23500, MIDCPNIFTY: 12500, SENSEX: 79000, BANKEX: 58000 };
const OPTION_RE = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;
const FUT_RE = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})FUT$/;

function basePrice(symbol, exchange, rng) {
  if (exchange === 'NFO' || exchange === 'BFO') {
    const opt = OPTION_RE.exec(symbol);
    if (opt) {
      const und = UNDERLYING[opt[1]] ?? 100 + rng() * 4900;
      const strike = Number(opt[3]);
      const intrinsic = opt[4] === 'CE' ? Math.max(0, und - strike) : Math.max(0, strike - und);
      const timeValue = 150 * Math.exp(-Math.abs(strike - und) / (und * 0.02));
      return intrinsic + timeValue + 0.05;
    }
    const fut = FUT_RE.exec(symbol);
    if (fut) return (UNDERLYING[fut[1]] ?? 100 + rng() * 4900) * 1.003;
  }
  if (exchange.endsWith('_INDEX')) return UNDERLYING[symbol] ?? 5000 + rng() * 45000;
  return 100 + rng() * 4900;
}

const instruments = new Map(); // "EXCHANGE:SYMBOL" -> walk state, shared by all clients

function instrument(symbol, exchange) {
  const key = `${exchange}:${symbol}`;
  let st = instruments.get(key);
  if (st) return st;
  const rng = mulberry32(hash32(key));
  const close = r05(basePrice(symbol, exchange, rng));
  const open = r05(close * (1 + (rng() - 0.5) * 0.01));
  const isDeriv = exchange === 'NFO' || exchange === 'BFO' || exchange === 'MCX' || exchange === 'CDS';
  st = {
    symbol,
    exchange,
    rng,
    close,
    open,
    ltp: open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    volume: Math.floor(rng() * 2_000_000),
    oi: isDeriv ? 75 * Math.floor(rng() * 100_000) : undefined,
    isDeriv,
  };
  instruments.set(key, st);
  return st;
}

function step(st) {
  const tick = Math.max(0.05, st.close * 0.0005);
  st.ltp = r05(st.ltp + (st.rng() - 0.5) * 2 * tick);
  if (st.ltp > st.high) st.high = st.ltp;
  if (st.ltp < st.low) st.low = st.ltp;
  st.volume += 1 + Math.floor(st.rng() * 500);
  if (st.isDeriv) st.oi = Math.max(0, st.oi + 75 * Math.round((st.rng() - 0.5) * 20));
}

function depthLevels(st, side) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const off = 0.05 * (i + 1);
    out.push({
      price: r05(side === 'buy' ? st.ltp - off : st.ltp + off),
      quantity: 1 + Math.floor(st.rng() * 5000),
      orders: 1 + Math.floor(st.rng() * 50),
    });
  }
  return out;
}

function marketData(st, mode) {
  const timestamp = Date.now();
  let data;
  if (mode === 1) {
    data = { ltp: st.ltp, timestamp };
  } else {
    const change = r2(st.ltp - st.close);
    data = {
      ltp: st.ltp,
      open: st.open,
      high: st.high,
      low: st.low,
      close: st.close,
      volume: st.volume,
      change,
      change_percent: r2((change / st.close) * 100),
    };
    if (st.isDeriv) data.oi = st.oi;
    if (mode === 3) data.depth = { buy: depthLevels(st, 'buy'), sell: depthLevels(st, 'sell') };
    data.timestamp = timestamp;
  }
  return JSON.stringify({ type: 'market_data', symbol: st.symbol, exchange: st.exchange, mode, broker: BROKER, data });
}

// --- Protocol helpers --------------------------------------------------------
const MODE_LABEL = { 1: 'LTP', 2: 'Quote', 3: 'Depth' };
const MODE_BY_UPPER = { LTP: 1, QUOTE: 2, DEPTH: 3 };

/** Same rules as websocket_proxy/mode_utils.py normalize_mode. */
function normalizeMode(v) {
  if (typeof v === 'boolean') throw new TypeError(`Mode must be int or str, got bool (${v})`);
  if (typeof v === 'number' && Number.isInteger(v)) {
    if (!MODE_LABEL[v]) throw new RangeError(`Invalid mode ${v}; expected 1 (LTP), 2 (Quote), or 3 (Depth)`);
    return [v, MODE_LABEL[v]];
  }
  if (typeof v === 'string') {
    const n = MODE_BY_UPPER[v.trim().toUpperCase()];
    if (!n) throw new RangeError(`Invalid mode '${v}'; expected 'LTP', 'Quote', or 'Depth' (case-insensitive)`);
    return [n, MODE_LABEL[n]];
  }
  throw new TypeError(`Mode must be int or str, got ${typeof v}`);
}

function send(c, obj) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(obj));
}

function sendError(c, code, message, requestId) {
  const payload = { status: 'error', code, message };
  if (requestId !== undefined && requestId !== null) payload.request_id = requestId;
  send(c, payload);
}

function rebuildOrder(c) {
  c.order = Array.from(c.subs.keys());
}

// --- Handlers ----------------------------------------------------------------
function onAuthenticate(c, data) {
  const key = data.api_key ?? data.apikey;
  if (!key) return sendError(c, 'AUTHENTICATION_ERROR', 'API key is required');
  if (API_KEY && key !== API_KEY) return sendError(c, 'AUTHENTICATION_ERROR', 'Invalid API key');
  c.authed = true;
  clearTimeout(c.authTimer);
  log(`#${c.id} authenticated`);
  send(c, {
    type: 'auth',
    status: 'success',
    message: 'Authentication successful',
    broker: BROKER,
    user_id: 'spike',
    supported_features: {},
  });
}

function onSubscribe(c, data) {
  const requestId = data.request_id;
  if (!c.authed) return sendError(c, 'NOT_AUTHENTICATED', 'You must authenticate first', requestId);
  let mode, label;
  try {
    [mode, label] = normalizeMode(data.mode ?? 'Quote');
  } catch (e) {
    return sendError(c, 'INVALID_MODE', e.message, requestId);
  }
  let symbols = Array.isArray(data.symbols) ? data.symbols : [];
  if (!symbols.length && data.symbol && data.exchange) symbols = [{ symbol: data.symbol, exchange: data.exchange }];
  if (!symbols.length) return sendError(c, 'INVALID_PARAMETERS', 'At least one symbol must be specified', requestId);

  const subscriptions = [];
  for (const s of symbols) {
    if (!s || typeof s.symbol !== 'string' || typeof s.exchange !== 'string' || !s.symbol || !s.exchange) continue;
    const key = `${s.exchange}:${s.symbol}`;
    let modes = c.subs.get(key);
    if (!modes) c.subs.set(key, (modes = new Set()));
    modes.add(mode);
    instrument(s.symbol, s.exchange);
    subscriptions.push({ symbol: s.symbol, exchange: s.exchange, status: 'success', mode: label, depth: 5, broker: BROKER });
  }
  rebuildOrder(c);
  const res = {
    type: 'subscribe',
    status: 'success',
    subscriptions,
    message: 'Subscription processing complete',
    broker: BROKER,
  };
  if (requestId !== undefined && requestId !== null) res.request_id = requestId;
  send(c, res);
  log(`#${c.id} subscribed ${subscriptions.length} (${label}); now ${c.subs.size} symbols`);
}

function onUnsubscribe(c, data, action) {
  const requestId = data.request_id;
  if (!c.authed) return sendError(c, 'NOT_AUTHENTICATED', 'You must authenticate first', requestId);
  const all = action === 'unsubscribe_all' || data.type === 'unsubscribe_all' || data.action === 'unsubscribe_all';
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  if (!all && !symbols.length) {
    return sendError(c, 'INVALID_PARAMETERS', 'Either symbols or unsubscribe_all is required', requestId);
  }
  const successful = [];
  const failed = [];
  if (all) {
    for (const [key, modes] of c.subs) {
      const [exchange, ...rest] = key.split(':');
      for (const m of modes) successful.push({ symbol: rest.join(':'), exchange, mode: MODE_LABEL[m], status: 'success', broker: BROKER });
    }
    c.subs.clear();
  } else {
    for (const s of symbols) {
      if (!s || !s.symbol || !s.exchange) continue;
      let mode, label;
      try {
        [mode, label] = normalizeMode('mode' in s ? s.mode : (data.mode ?? 2));
      } catch (e) {
        failed.push({ symbol: s.symbol, exchange: s.exchange, mode: null, status: 'error', message: e.message, broker: BROKER });
        continue;
      }
      const key = `${s.exchange}:${s.symbol}`;
      const modes = c.subs.get(key);
      if (!modes || !modes.has(mode)) {
        failed.push({ symbol: s.symbol, exchange: s.exchange, mode: label, status: 'error', message: 'Not subscribed', broker: BROKER });
        continue;
      }
      modes.delete(mode);
      if (!modes.size) c.subs.delete(key);
      successful.push({ symbol: s.symbol, exchange: s.exchange, mode: label, status: 'success', broker: BROKER });
    }
  }
  rebuildOrder(c);
  const status = failed.length && successful.length ? 'partial' : failed.length ? 'error' : 'success';
  const res = { type: 'unsubscribe', status, message: 'Unsubscription processing complete', successful, failed, broker: BROKER };
  if (requestId !== undefined && requestId !== null) res.request_id = requestId;
  send(c, res);
  log(`#${c.id} unsubscribed ${successful.length}; now ${c.subs.size} symbols`);
}

function onPing(c, data) {
  const res = { type: 'pong', status: 'success', server_timestamp: Date.now() };
  if (data.timestamp !== undefined) res.client_timestamp = data.timestamp;
  if (data._pingId !== undefined) res._pingId = data._pingId;
  send(c, res);
}

function onMessage(c, raw) {
  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return sendError(c, 'INVALID_JSON', 'Invalid JSON message');
  }
  if (!data || typeof data !== 'object') return sendError(c, 'INVALID_JSON', 'Invalid JSON message');
  const action = data.action ?? data.type;
  switch (action) {
    case 'authenticate':
    case 'auth':
      return onAuthenticate(c, data);
    case 'subscribe':
      return onSubscribe(c, data);
    case 'unsubscribe':
    case 'unsubscribe_all':
      return onUnsubscribe(c, data, action);
    case 'ping':
      return onPing(c, data);
    default:
      return sendError(c, 'INVALID_ACTION', `Invalid action: ${action}`);
  }
}

// --- Tick scheduler ----------------------------------------------------------
const clients = new Set();

function pick(c) {
  // Skewed like SimFeed in the app: 60% of ticks go to the first 30 subscribed
  // names (busy large caps), 40% spread over everything.
  const n = c.order.length;
  const hot = Math.min(30, n);
  const r = Math.random();
  const idx = r < 0.6 ? Math.floor(Math.random() * hot) : Math.floor(Math.random() * n);
  return c.order[idx];
}

let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  for (const c of clients) {
    if (!c.authed || !c.order.length || c.ws.readyState !== c.ws.OPEN) continue;
    // Credit-based pacing keeps the average at RATE even when timers drift; the
    // cap stops a long event-loop stall from turning into a giant burst.
    c.credit = Math.min(c.credit + (RATE * dt) / 1000, Math.max(1, RATE * 0.2));
    let n = Math.floor(c.credit);
    c.credit -= n;
    while (n-- > 0) {
      const key = pick(c);
      const modes = c.subs.get(key);
      if (!modes) continue;
      const st = instruments.get(key);
      step(st);
      if (c.ws.bufferedAmount > MAX_BUFFERED) {
        c.dropped++;
        continue;
      }
      c.ws.send(marketData(st, Math.max(...modes)));
      c.sent++;
    }
  }
}, TICK_MS);

setInterval(() => {
  if (QUIET) return;
  for (const c of clients) {
    if (!c.authed) continue;
    const sec = (performance.now() - c.statsAt) / 1000;
    const rate = Math.round((c.sent - c.statsSent) / sec);
    console.log(
      `#${c.id} ${c.ip} subs=${c.subs.size} sent=${c.sent} (${rate}/s) dropped=${c.dropped} buffered=${c.ws.bufferedAmount}B`,
    );
    c.statsAt = performance.now();
    c.statsSent = c.sent;
  }
}, STATS_MS);

// --- Server ------------------------------------------------------------------
function log(msg) {
  if (!QUIET) console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}

let nextId = 0;
const wss = new WebSocketServer({ host: HOST, port: PORT, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const c = {
    id: ++nextId,
    ws,
    ip: req.socket.remoteAddress,
    authed: false,
    subs: new Map(), // "EXCHANGE:SYMBOL" -> Set<mode>
    order: [],
    credit: 0,
    sent: 0,
    dropped: 0,
    statsAt: performance.now(),
    statsSent: 0,
    authTimer: null,
  };
  c.authTimer = setTimeout(() => {
    if (!c.authed) {
      log(`#${c.id} did not authenticate within ${AUTH_TIMEOUT_MS} ms, closing 4401`);
      ws.close(4401, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);
  clients.add(c);
  log(`#${c.id} connected from ${c.ip}`);
  ws.on('message', (raw) => onMessage(c, raw));
  ws.on('close', (code, reason) => {
    clearTimeout(c.authTimer);
    clients.delete(c);
    log(`#${c.id} closed ${code} ${reason.toString()} (sent ${c.sent}, dropped ${c.dropped})`);
  });
  ws.on('error', (err) => log(`#${c.id} error ${err.message}`));
});

wss.on('error', (err) => {
  console.error(`mock-feed: ${err.message}`);
  process.exit(1);
});

function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, url: `ws://${a.address}:${PORT}` });
    }
  }
  return out;
}

wss.on('listening', () => {
  const lan = lanUrls();
  console.log(`OpenAlgo mock feed listening on ${HOST}:${PORT}`);
  console.log(`  rate: ${RATE} market_data msgs/s per connection, spread over its subscriptions`);
  console.log(`  auth: ${API_KEY ? 'MOCK_API_KEY required' : 'any non-empty API key'} (timeout ${AUTH_TIMEOUT_MS} ms -> close 4401)`);
  console.log(`  local: ws://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const { name, url } of lan) console.log(`  LAN:   ${url}   (${name})`);
    if (!lan.length) console.log('  LAN:   no non-internal IPv4 interface found');
  }
  console.log('In the app: Results tab -> Feed = WebSocket, URL = one of the LAN URLs, any API key, tap Use WebSocket.');
});

function shutdown() {
  for (const c of clients) c.ws.close(1001, 'server shutting down');
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
