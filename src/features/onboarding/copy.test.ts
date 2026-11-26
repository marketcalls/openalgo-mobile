import { ApiError } from '~/core/http/errors'
import { POLLING_BANNER } from '~/core/services/services'
import {
  COPY,
  ENV_LINES,
  HELP,
  keyErrorText,
  serverErrorLines,
  urlErrorText,
  usingUrl,
  wsHostDiffers,
} from './copy'

const ENV_SENTENCE =
  "If OpenAlgo runs on this PC with a stock .env, it listens only on 127.0.0.1. In .env set FLASK_HOST_IP='0.0.0.0' and WEBSOCKET_HOST='0.0.0.0', then restart OpenAlgo."
const LOCAL_NETWORK =
  'Also allow Local Network for OpenAlgo in Settings > Privacy & Security > Local Network.'

test('the http warning and its button', () => {
  expect(COPY.httpWarning).toBe(
    'Not encrypted: anyone on the same Wi-Fi can capture your API key. Use this only on a network you trust.',
  )
  expect(COPY.httpAck).toBe('I understand')
})

test('cleartext_public and dev_host_in_release', () => {
  expect(urlErrorText('cleartext_public')).toBe(
    'This address needs https. http is allowed only on your home network.',
  )
  expect(urlErrorText('dev_host_in_release')).toBe(
    "localhost is this phone, not your PC. Use your PC's network address, for example 192.168.1.20:5000.",
  )
})

test('every other URL error is one plain sentence', () => {
  for (const reason of ['empty', 'invalid', 'has_credentials', 'wrong_scheme'] as const) {
    const text = urlErrorText(reason)
    expect(text).toMatch(/^[A-Z].*\.$/)
    expect(text).not.toMatch(/\. [A-Z]/)
  }
})

test('unreachable on a home host adds the .env line, and on iOS the Local Network line', () => {
  const unreachable = { kind: 'unreachable' } as const
  expect(serverErrorLines(unreachable, { home: true, ios: true })).toEqual([
    COPY.unreachable,
    ENV_SENTENCE,
    LOCAL_NETWORK,
  ])
  expect(serverErrorLines(unreachable, { home: true, ios: false })).toEqual([
    COPY.unreachable,
    ENV_SENTENCE,
  ])
  expect(serverErrorLines(unreachable, { home: false, ios: true })).toEqual([COPY.unreachable])
})

test('not_openalgo, banned and URL errors', () => {
  const at = { home: true, ios: true }
  expect(serverErrorLines({ kind: 'not_openalgo' }, at)).toEqual([
    "This doesn't look like an OpenAlgo server",
  ])
  expect(serverErrorLines({ kind: 'banned', form: 'text' }, at)).toEqual([
    "This server has banned your IP address. Unban it in OpenAlgo's Security page from another network, then try again.",
  ])
  expect(serverErrorLines({ kind: 'url_error', reason: 'cleartext_public' }, at)).toEqual([
    urlErrorText('cleartext_public'),
  ])
})

test('too_old: the title and the two update lines', () => {
  expect(COPY.tooOld).toBe('Update OpenAlgo')
  expect(COPY.tooOldNative).toBe('Native install: run install/update.sh, then restart OpenAlgo.')
  expect(COPY.tooOldDocker).toBe(
    'Docker: docker pull marketcalls/openalgo:latest, then recreate the container.',
  )
})

test('the key: format, broker logged out, and the scan hint', () => {
  expect(keyErrorText({ kind: 'format' })).toBe(
    'An OpenAlgo API key is 64 characters, 0-9 and a-f.',
  )
  expect(COPY.brokerLoggedOut).toBe(
    'Your key works; log in to your broker on the OpenAlgo web to see live data.',
  )
  expect(COPY.scanHint).toBe('To scan the key with the camera, tap Show first.')
  expect(COPY.findKey).toBe('Where do I find this?')
})

test('a refused key and a failed check are plain sentences', () => {
  expect(keyErrorText({ kind: 'invalid' })).toMatch(/^[A-Z].*\.$/)
  const rateLimited = new ApiError({ kind: 'RateLimited', status: 429, endpoint: 'search' })
  expect(keyErrorText({ kind: 'error', error: rateLimited })).toBe(
    'The server is busy. Wait a few seconds and try again.',
  )
  expect(keyErrorText({ kind: 'error', error: new Error('x') })).toMatch(/^[A-Z].*\.$/)
})

test('feed failed matches the app banner, with Setup help', () => {
  expect(COPY.feedFailed).toBe('Live feed unavailable: prices refresh every few seconds')
  expect(COPY.feedFailed).toBe(POLLING_BANNER)
  expect(COPY.setupHelp).toBe('Setup help')
})

test('ws host differs', () => {
  expect(wsHostDiffers('feed.example.net', 'algo.example.com')).toBe(
    'The live feed is on feed.example.net, not algo.example.com. Your API key will be sent there. Continue?',
  )
})

test('a stripped URL', () => {
  expect(usingUrl('https://algo.example.com')).toBe('Using https://algo.example.com')
})

test('setup help holds the .env lines, docker-run, the cloudflared rule and the tunnel note', () => {
  expect(ENV_LINES).toEqual(["FLASK_HOST_IP='0.0.0.0'", "WEBSOCKET_HOST='0.0.0.0'"])
  expect(HELP.dockerRun).toContain("WEBSOCKET_HOST='0.0.0.0'")
  expect(HELP.dockerRun).toContain('install/docker-run.sh')
  expect(HELP.cloudflaredRule).toContain('path: ^/ws')
  expect(HELP.cloudflaredRule).toContain('service: http://127.0.0.1:8765')
  expect(HELP.tunnels).toMatch(/ngrok/)
  expect(HELP.tunnels).toMatch(/quick tunnel/)
  expect(HELP.tunnels).toMatch(/polling mode/)
  // the design 7.1 matrix, one entry per setup
  expect(HELP.matrix.map((r) => r.setup)).toEqual([
    'VPS installers (native or Docker, with nginx and TLS)',
    'Docker on a home PC (docker-compose or docker-build.sh)',
    'Docker via install/docker-run.sh',
    'Native install on a home PC, unchanged .env',
    'Built-in ngrok, cloudflared quick tunnel, Dev Tunnels',
    'OpenAlgo Desktop (Rust/Tauri engine)',
  ])
})
