// What onboarding says, by case (design 7.1). Account's server settings reuse it.
import { ApiError, userMessage } from '~/core/http/errors'
import type { KeyStepResult, ServerStepResult, UrlError } from './flow'

export const ENV_LINES = ["FLASK_HOST_IP='0.0.0.0'", "WEBSOCKET_HOST='0.0.0.0'"] as const

export const COPY = {
  httpWarning:
    'Not encrypted: anyone on the same Wi-Fi can capture your API key. Use this only on a network you trust.',
  httpAck: 'I understand',
  unreachable: "Can't reach this server. Check the address and that OpenAlgo is running.",
  homeUnreachable: `If OpenAlgo runs on this PC with a stock .env, it listens only on 127.0.0.1. In .env set ${ENV_LINES[0]} and ${ENV_LINES[1]}, then restart OpenAlgo.`,
  iosLocalNetwork:
    'Also allow Local Network for OpenAlgo in Settings > Privacy & Security > Local Network.',
  notOpenAlgo: "This doesn't look like an OpenAlgo server",
  tooOld: 'Update OpenAlgo',
  tooOldNative: 'Native install: run install/update.sh, then restart OpenAlgo.',
  tooOldDocker: 'Docker: docker pull marketcalls/openalgo:latest, then recreate the container.',
  findKey: 'Where do I find this?',
  scanHint: 'To scan the key with the camera, tap Show first.',
  brokerLoggedOut: 'Your key works; log in to your broker on the OpenAlgo web to see live data.',
  feedLive: 'Live feed works.',
  feedFailed: 'Live feed unavailable: prices refresh every few seconds',
  setupHelp: 'Setup help',
  failed: 'Something went wrong. Try again.',
  saveFailed: 'Could not save this server on the phone. Try again.',
} as const

const URL_ERRORS: Record<UrlError, string> = {
  cleartext_public: 'This address needs https. http is allowed only on your home network.',
  dev_host_in_release:
    "localhost is this phone, not your PC. Use your PC's network address, for example 192.168.1.20:5000.",
  empty: "Enter your OpenAlgo server's address.",
  invalid: 'That is not a server address, for example https://algo.example.com.',
  has_credentials: 'Leave the user name and password out of the address.',
  wrong_scheme: 'A live feed address starts with wss:// or ws://.',
}

const KEY_ERRORS = {
  format: 'An OpenAlgo API key is 64 characters, 0-9 and a-f.',
  invalid: 'This server does not accept that key. Copy it again from its API key page.',
} as const

export const urlErrorText = (reason: UrlError): string => URL_ERRORS[reason]

export const usingUrl = (url: string) => `Using ${url}`

export const wsHostDiffers = (wsHost: string, restHost: string) =>
  `The live feed is on ${wsHost}, not ${restHost}. Your API key will be sent there. Continue?`

const errorText = (e: unknown) => (e instanceof ApiError ? userMessage(e) : COPY.failed)

/** The lines a server step that did not reach `ok` (or `too_old`, its own screen) shows. */
export function serverErrorLines(
  r: Exclude<ServerStepResult, { kind: 'ok' } | { kind: 'too_old' }>,
  at: { home: boolean; ios: boolean },
): string[] {
  switch (r.kind) {
    case 'url_error':
      return [urlErrorText(r.reason)]
    case 'not_openalgo':
      return [COPY.notOpenAlgo]
    case 'banned':
      return [errorText(new ApiError({ kind: 'IpBanned', status: 403, endpoint: 'probe' }))]
    case 'unreachable':
      if (!at.home) return [COPY.unreachable]
      return [COPY.unreachable, COPY.homeUnreachable, ...(at.ios ? [COPY.iosLocalNetwork] : [])]
  }
}

export function keyErrorText(r: Exclude<KeyStepResult, { kind: 'ok' }>): string {
  return r.kind === 'error' ? errorText(r.error) : KEY_ERRORS[r.kind]
}

/** Setup help (design 7.1 deployment matrix), in the user's terms. */
export const HELP = {
  matrix: [
    {
      setup: 'VPS installers (native or Docker, with nginx and TLS)',
      rest: 'https://your-domain',
      feed: 'wss://your-domain/ws',
      note: 'Works as is.',
    },
    {
      setup: 'Docker on a home PC (docker-compose or docker-build.sh)',
      rest: 'http://<PC address>:5000',
      feed: 'ws://<PC address>:8765',
      note: 'Works, with a Not encrypted badge.',
    },
    {
      setup: 'Docker via install/docker-run.sh',
      rest: 'Works',
      feed: "Off until WEBSOCKET_HOST='0.0.0.0'",
      note: 'Set that one .env line, then restart the container.',
    },
    {
      setup: 'Native install on a home PC, unchanged .env',
      rest: 'Not reachable: it listens on 127.0.0.1',
      feed: 'Not reachable',
      note: 'Set the two .env lines below, then restart OpenAlgo.',
    },
    {
      setup: 'Built-in ngrok, cloudflared quick tunnel, Dev Tunnels',
      rest: 'https tunnel address',
      feed: 'Not carried',
      note: 'Polling mode. A named cloudflared tunnel can carry the live feed (below).',
    },
    {
      setup: 'OpenAlgo Desktop (Rust/Tauri engine)',
      rest: 'Not verified',
      feed: 'Not verified',
      note: 'Not supported yet.',
    },
  ],
  envIntro: 'OpenAlgo on a PC listens only on 127.0.0.1 until you set these two lines in .env:',
  dockerRun:
    "Docker via install/docker-run.sh: set WEBSOCKET_HOST='0.0.0.0' in .env, then restart the container.",
  cloudflaredIntro:
    'cloudflared: put this ingress rule before the rule for the web port, so the live feed reaches port 8765:',
  cloudflaredRule: '- hostname: <your-domain>\n  path: ^/ws\n  service: http://127.0.0.1:8765',
  tunnels:
    'ngrok, cloudflared quick tunnels and Dev Tunnels carry only the web port, so the app runs in polling mode: prices refresh every few seconds.',
} as const
