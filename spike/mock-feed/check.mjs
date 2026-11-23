// THROWAWAY SPIKE. Self-check for server.mjs: proves ping, the auth gate, auth, the app's exact subscribe, tick rate and shape, unsubscribe, and the 4401 auth timeout.
//
//   node check.mjs                 spawn server.mjs on a spare port, run all checks, stop it (waits the real 15 s auth timeout)
//   node check.mjs --fast          same, but the spawned server uses a 1.5 s auth timeout
//   node check.mjs --url ws://H:P  check an already-running server (e.g. from another machine on the LAN)
//
// Exits 0 when every check passes, 1 otherwise.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const RATE = Number(process.env.RATE ?? 300);
const AUTH_TIMEOUT_MS = urlArg ? Number(process.env.AUTH_TIMEOUT_MS ?? 15_000) : fast ? 1500 : 15_000;
const PORT = Number(process.env.CHECK_PORT ?? 18765);
const API_KEY = process.env.MOCK_API_KEY ?? 'spike-check-key';

// Use the app's real universe (100 NSE + NIFTY index + 80 NFO options) when the
// app source is next door; Node >= 22.18 strips the TypeScript types itself.
let universe;
try {
  const mod = await import(path.join(here, '../app/src/core/symbols.ts'));
  universe = mod.ALL_STREAMED.map((i) => ({ symbol: i.symbol, exchange: i.exchange }));
} catch (e) {
  console.log(`(could not import app symbols.ts: ${e.message}; using a small fallback list)`);
  universe = [
    { symbol: 'RELIANCE', exchange: 'NSE' },
    { symbol: 'TCS', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
    { symbol: 'NIFTY27NOV2624000CE', exchange: 'NFO' },
    { symbol: 'NIFTY27NOV2624000PE', exchange: 'NFO' },
  ];
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', RATE: String(RATE), AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS), MOCK_API_KEY: API_KEY, QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in 5 s')), 5000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`server exited early with ${code}`)));
  });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      msg.__bytes = raw.length;
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.once('open', () =>
      resolve({
        ws,
        queue,
        send: (o) => ws.send(JSON.stringify(o)),
        /** Next message (queued or future) matching pred, ignoring market_data unless asked. */
        next(pred, ms = 3000) {
          const i = queue.findIndex(pred);
          if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { pred, resolve: (m) => (clearTimeout(t), res(m)) };
            const t = setTimeout(() => {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error(`timeout after ${ms} ms`));
            }, ms);
            waiters.push(w);
          });
        },
        drainTicks() {
          const ticks = queue.filter((m) => m.type === 'market_data');
          queue.length = 0;
          return ticks;
        },
      }),
    );
    ws.once('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTick = (m) => m.type === 'market_data';

async function main() {
  const url = urlArg ?? `ws://127.0.0.1:${PORT}`;
  if (!urlArg) await startServer();
  console.log(`checking ${url}  rate=${RATE}/s  symbols=${universe.length}  authTimeout=${AUTH_TIMEOUT_MS} ms`);

  // Start the auth-timeout probe first so it runs in parallel with everything else.
  const timeoutProbe = (async () => {
    const t0 = performance.now();
    const ws = new WebSocket(url);
    const code = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
    return { code, ms: Math.round(performance.now() - t0) };
  })();

  const c = await open(url);

  c.send({ action: 'ping', timestamp: 123, _pingId: 'p1' });
  const pong = await c.next((m) => m.type === 'pong');
  check('ping -> pong', pong.status === 'success' && typeof pong.server_timestamp === 'number' && pong.client_timestamp === 123 && pong._pingId === 'p1');

  c.send({ action: 'subscribe', symbols: universe.slice(0, 1), mode: 'Quote', request_id: 'early' });
  const early = await c.next((m) => m.request_id === 'early');
  check('subscribe before auth is rejected', early.status === 'error' && early.code === 'NOT_AUTHENTICATED');

  if (!urlArg || process.env.MOCK_API_KEY) {
    c.send({ action: 'authenticate', api_key: `${API_KEY}-wrong` });
    const bad = await c.next((m) => m.status === 'error' && m.code === 'AUTHENTICATION_ERROR');
    check('wrong API key is rejected (MOCK_API_KEY set)', bad.message === 'Invalid API key');
  }

  c.send({ action: 'authenticate', api_key: API_KEY });
  const auth = await c.next((m) => m.type === 'auth');
  check('authenticate -> auth success', auth.status === 'success' && auth.broker === 'mock' && auth.user_id === 'spike' && typeof auth.supported_features === 'object');

  c.send({ action: 'subscribe', symbols: [{ symbol: 'RELIANCE', exchange: 'NSE' }], mode: 'Bogus', request_id: 'badmode' });
  const badMode = await c.next((m) => m.request_id === 'badmode');
  check('invalid mode is rejected', badMode.status === 'error' && badMode.code === 'INVALID_MODE');

  // Exactly what WsFeed in the app sends.
  c.send({ action: 'subscribe', symbols: universe, mode: 'Quote', request_id: 'spike-1' });
  const ack = await c.next((m) => m.type === 'subscribe');
  check(
    'subscribe (app request, mode "Quote") -> ack',
    ack.status === 'success' &&
      ack.request_id === 'spike-1' &&
      ack.subscriptions.length === universe.length &&
      ack.subscriptions.every((s) => s.status === 'success' && s.mode === 'Quote'),
    `${ack.subscriptions.length} subscriptions`,
  );

  c.drainTicks();
  const windowMs = 3000;
  await sleep(windowMs);
  const ticks = c.drainTicks();
  const rate = (ticks.length * 1000) / windowMs;
  check(`tick rate ~ RATE (${RATE}/s +/-10%)`, Math.abs(rate - RATE) <= RATE * 0.1, `${Math.round(rate)}/s over ${windowMs} ms`);

  const subscribed = new Set(universe.map((s) => `${s.exchange}:${s.symbol}`));
  const shapeOk = ticks.every((m) => {
    const d = m.data;
    const nums = ['ltp', 'open', 'high', 'low', 'close', 'volume', 'change', 'change_percent', 'timestamp'].every((k) => typeof d[k] === 'number' && Number.isFinite(d[k]));
    const oiOk = m.exchange === 'NFO' ? typeof d.oi === 'number' : d.oi === undefined;
    return m.mode === 2 && m.broker === 'mock' && subscribed.has(`${m.exchange}:${m.symbol}`) && nums && oiOk && d.low <= d.ltp && d.ltp <= d.high && d.ltp >= 0.05;
  });
  check('market_data shape (Quote fields, oi only on NFO, low<=ltp<=high)', shapeOk && ticks.length > 0);
  const distinct = new Set(ticks.map((m) => `${m.exchange}:${m.symbol}`)).size;
  const sample = ticks.find((m) => m.exchange === 'NFO') ?? ticks[0];
  const avgBytes = Math.round(ticks.reduce((a, m) => a + m.__bytes, 0) / Math.max(1, ticks.length));
  check('ticks spread across many symbols', distinct >= Math.min(30, universe.length), `${distinct} distinct; avg ${avgBytes} B/msg`);
  delete sample.__bytes;
  console.log(`      sample: ${JSON.stringify(sample)}`);

  // Random walk continuity: consecutive ltps for one symbol move by small steps.
  const rel = ticks.filter((m) => m.symbol === universe[0].symbol).map((m) => m.data.ltp);
  const maxJump = rel.slice(1).reduce((a, v, i) => Math.max(a, Math.abs(v - rel[i])), 0);
  check(`random walk is continuous for ${universe[0].symbol}`, rel.length > 1 && maxJump <= Math.max(0.05, rel[0] * 0.0005) + 0.051, `${rel.length} ticks, max step ${maxJump.toFixed(2)}`);

  // Unsubscribe everything except the first symbol; afterwards only it ticks.
  const keep = universe[0];
  c.send({ action: 'unsubscribe', symbols: universe.slice(1), mode: 'Quote', request_id: 'unsub-1' });
  const unack = await c.next((m) => m.type === 'unsubscribe');
  c.drainTicks();
  check('unsubscribe -> ack', unack.status === 'success' && unack.successful.length === universe.length - 1 && unack.request_id === 'unsub-1');
  await sleep(1000);
  const after = c.drainTicks();
  check(`after unsubscribe only ${keep.symbol} ticks`, after.length > 0 && after.every((m) => m.symbol === keep.symbol && m.exchange === keep.exchange), `${after.length} ticks in 1 s`);

  c.send({ action: 'subscribe', symbols: [{ symbol: 'TCS', exchange: 'NSE' }], mode: 2, request_id: 'num' });
  const numAck = await c.next((m) => m.request_id === 'num');
  check('numeric mode 2 accepted, echoed as "Quote"', numAck.status === 'success' && numAck.subscriptions[0].mode === 'Quote');

  c.send({ action: 'unsubscribe_all', request_id: 'all' });
  const allAck = await c.next((m) => m.request_id === 'all');
  c.drainTicks();
  await sleep(300);
  check('unsubscribe_all stops ticks', allAck.type === 'unsubscribe' && allAck.status === 'success' && c.drainTicks().length === 0);

  c.send({ action: 'nope' });
  const inv = await c.next((m) => m.code === 'INVALID_ACTION');
  check('unknown action -> INVALID_ACTION', inv.status === 'error');
  c.ws.close();

  console.log(`waiting for the unauthenticated socket to be closed (~${AUTH_TIMEOUT_MS} ms)...`);
  const probe = await Promise.race([timeoutProbe, sleep(AUTH_TIMEOUT_MS + 5000).then(() => ({ code: null, ms: null }))]);
  check('unauthenticated socket closed with 4401 at the timeout', probe.code === 4401 && probe.ms >= AUTH_TIMEOUT_MS - 50 && probe.ms <= AUTH_TIMEOUT_MS + 1500, `code ${probe.code} after ${probe.ms} ms`);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  check('check script ran to completion', false, e.message);
}
if (server) {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  console.log('server stopped');
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) exitCode = 1;
process.exit(exitCode);
