// npm run mock. Env: PORT (5000), WS_PORT (8765; 0 = ephemeral, off = no WS), HOST (0.0.0.0),
// PROFILE (2.0.3.5), MOCK_API_KEY ('ab' x 32), RATE (10 ticks/s per connection) and
// AUTH_GRACE_MS (15000). Prints `MOCK_READY rest=<origin> ws=<url|off>` once listening.
import { PROFILES } from './profiles.mjs'
import { startMockServer } from './server.mjs'
import { DEFAULT_API_KEY, DEFAULT_PROFILE } from './state.mjs'

const env = process.env

function fail(message) {
  console.error(`mock-server: ${message}`)
  process.exit(2)
}

function count(name, fallback) {
  const raw = env[name] ?? String(fallback)
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < 0) {
    fail(`${name}=${raw} is not a whole number`)
  }
  return n
}

const profile = env.PROFILE ?? DEFAULT_PROFILE
if (!PROFILES[profile]) fail(`PROFILE=${profile} is not one of ${Object.keys(PROFILES).join(', ')}`)
const apiKey = env.MOCK_API_KEY ?? DEFAULT_API_KEY
if (!/^[0-9a-f]{64}$/.test(apiKey)) fail('MOCK_API_KEY must be 64 lowercase hex characters')

const m = await startMockServer({
  port: count('PORT', 5000),
  wsPort: env.WS_PORT === 'off' ? 'off' : count('WS_PORT', 8765),
  host: env.HOST ?? '0.0.0.0',
  profile,
  apiKey,
  rate: count('RATE', 10),
  authGraceMs: count('AUTH_GRACE_MS', 15_000),
}).catch((e) => fail(e.message))

console.log(`MOCK_READY rest=${m.origin} ws=${m.wsUrl ?? 'off'}`)

async function shutdown() {
  await m.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
