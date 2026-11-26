import { fireEvent, userEvent } from '@testing-library/react-native'
import * as Clipboard from 'expo-clipboard'
import { Stack } from 'expo-router'
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library'
import { usePreventScreenCapture } from 'expo-screen-capture'
import { Linking, Platform } from 'react-native'
import AppHelpRoute from '~/app/(app)/help'
import OnboardingLayout from '~/app/(onboarding)/_layout'
import FeedRoute from '~/app/(onboarding)/feed'
import HelpRoute from '~/app/(onboarding)/help'
import OnboardingIndex from '~/app/(onboarding)/index'
import KeyRoute from '~/app/(onboarding)/key'
import ServerRoute from '~/app/(onboarding)/server'
import UpdateRoute from '~/app/(onboarding)/update'
import type { ServerProfile } from '~/core/config/profile'
import type { AppDeps } from '~/core/services/services'
import { useSession } from '~/core/services/services'
import { type Route, scriptedFetch } from '../../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, PONG, wsError } from '../../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../../test/helpers/memoryKV'
import { KeyField } from '../components/KeyField'
import { COPY, ENV_LINES, HELP } from '../copy'

// The routes read the app's deps from deps.ts; each test puts its fakes here.
const mockDeps = {} as AppDeps
jest.mock('~/core/services/deps', () => ({
  get defaultDeps() {
    return mockDeps
  },
}))
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }))
jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(async () => ''),
  setStringAsync: jest.fn(async () => true),
}))

const ORIGIN = 'https://algo.example.com'
const LAN = 'http://192.168.1.20:5000'
const KEY = 'ab'.repeat(32)
const T0 = Date.UTC(2026, 10, 24, 4, 0)
const UUID = '0123abcd-4567-4890-a123-456789abcdef'

const BAD_KEY: Route = {
  status: 403,
  body: { status: 'error', message: 'Invalid openalgo apikey' },
}
const OK_ROUTES: Record<string, Route> = {
  'GET /auth/app-info': { status: 200, body: { status: 'success', version: '2.0.3.5' } },
  'GET /api/v1/swagger.json': { status: 200, body: { paths: { '/multioptiongreeks/': {} } } },
  'POST /api/v1/search': { status: 200, body: { status: 'success', data: [] } },
  'POST /api/v1/funds': { status: 200, body: { status: 'success', data: { availablecash: '1' } } },
  'POST /api/v1/ping': {
    status: 200,
    body: { status: 'success', data: { message: 'pong', broker: 'zerodha' } },
  },
}

const ROUTES = {
  _layout: OnboardingLayout,
  index: OnboardingIndex,
  server: ServerRoute,
  update: UpdateRoute,
  key: KeyRoute,
  feed: FeedRoute,
  help: HelpRoute,
}

function setup(routes: Record<string, Route> = {}, seed: Record<string, string> = {}) {
  const fetch = scriptedFetch({ ...OK_ROUTES, ...routes })
  const ws = fakeSockets()
  const kv = memoryKV(seed)
  const secureKV = memoryKV()
  Object.assign(mockDeps, {
    fetch,
    WebSocketImpl: ws.WebSocketImpl,
    kv,
    secureKV,
    now: () => T0,
    uuid: () => UUID,
    allowDevHosts: false,
  })
  return { fetch, ws, kv, secureKV }
}

async function open() {
  await renderRouter(ROUTES, { initialUrl: '/' })
  await screen.findByTestId('server-url')
}

async function submitServer(text: string) {
  await fireEvent.changeText(screen.getByTestId('server-url'), text)
  await userEvent.press(screen.getByTestId('server-continue'))
}

/** From the server screen to the key screen, over https. */
async function toKey() {
  await open()
  await submitServer(ORIGIN)
  await screen.findByTestId('key-input')
}

async function toFeed() {
  await toKey()
  await fireEvent.changeText(screen.getByTestId('key-input'), KEY)
  await userEvent.press(screen.getByTestId('key-continue'))
  await screen.findByTestId('feed-url')
}

const posts = (fetch: ReturnType<typeof scriptedFetch>) =>
  fetch.calls.filter((c) => c.method === 'POST')

beforeEach(() => {
  useSession.setState({ status: 'onboarding', profileId: null })
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(() => jest.restoreAllMocks())

describe('server', () => {
  test('LAN http needs the ack before anything is sent', async () => {
    const { fetch } = setup()
    await open()
    await submitServer('192.168.1.20')
    expect(screen.getByText(COPY.httpWarning)).toBeOnTheScreen()
    expect(fetch.calls).toHaveLength(0)
    await userEvent.press(screen.getByTestId('http-ack'))
    expect(await screen.findByTestId('key-input')).toBeOnTheScreen()
    expect(screen).toHavePathname('/key')
    expect(fetch.calls[0]?.url).toBe(`${LAN}/auth/app-info`)
  })

  test('https needs no ack', async () => {
    setup()
    await open()
    await submitServer(ORIGIN)
    expect(await screen.findByTestId('key-input')).toBeOnTheScreen()
    expect(screen.queryByText(COPY.httpWarning)).toBeNull()
  })

  test('the ack is one-time: a saved profile that acked is prefilled and not asked again', async () => {
    const old: ServerProfile = {
      id: 'pexisting0001',
      restOrigin: LAN,
      wsUrl: 'ws://192.168.1.20:8765',
      feedMode: 'live',
      httpWarningAcked: true,
      serverVersion: '2.0.3.5',
      broker: null,
      createdAt: 0,
      lastFeedRetryAt: null,
    }
    setup({}, { 'oa.profiles.v1': JSON.stringify({ activeId: old.id, profiles: [old] }) })
    await open()
    expect(screen.getByTestId('server-url').props.value).toBe(LAN)
    await userEvent.press(screen.getByTestId('server-continue'))
    expect(await screen.findByTestId('key-input')).toBeOnTheScreen()
    expect(screen.queryByText(COPY.httpWarning)).toBeNull()
  })

  test('a stripped URL shows "Using …"', async () => {
    setup()
    await open()
    await fireEvent.changeText(screen.getByTestId('server-url'), `${ORIGIN}/dashboard?tab=1`)
    expect(screen.getByText(`Using ${ORIGIN}`)).toBeOnTheScreen()
    await fireEvent.changeText(screen.getByTestId('server-url'), ORIGIN)
    expect(screen.queryByText(/^Using /)).toBeNull()
  })

  test('a failure on a home host shows the .env lines (and, on iOS, Local Network)', async () => {
    setup({ 'GET /auth/app-info': 'throw' })
    await open()
    await submitServer('192.168.1.20')
    await userEvent.press(screen.getByTestId('http-ack'))
    expect(await screen.findByText(COPY.homeUnreachable)).toBeOnTheScreen()
    for (const line of ENV_LINES) expect(COPY.homeUnreachable).toContain(line)
    expect(screen.getByText(COPY.iosLocalNetwork)).toBeOnTheScreen()
    expect(screen).toHavePathname('/server')
  })

  test('a failure on a public host shows no .env lines', async () => {
    setup({ 'GET /auth/app-info': 'throw' })
    await open()
    await submitServer(ORIGIN)
    expect(await screen.findByText(COPY.unreachable)).toBeOnTheScreen()
    expect(screen.queryByText(COPY.homeUnreachable)).toBeNull()
  })

  test('a refused URL says why and sends nothing', async () => {
    const { fetch } = setup()
    await open()
    await submitServer('http://algo.example.com')
    expect(
      screen.getByText('This address needs https. http is allowed only on your home network.'),
    ).toBeOnTheScreen()
    expect(fetch.calls).toHaveLength(0)
  })

  test('something else answering is not_openalgo', async () => {
    setup({
      'GET /auth/app-info': { status: 200, contentType: 'text/html', body: '<html></html>' },
      'GET /api/v1/swagger.json': { status: 200, contentType: 'text/html', body: '<html></html>' },
      'POST /api/v1/multioptiongreeks': { status: 200, contentType: 'text/html', body: '<p>' },
      'POST /api/v1/ping': { status: 200, contentType: 'text/html', body: '<p>' },
    })
    await open()
    await submitServer(ORIGIN)
    expect(await screen.findByText(COPY.notOpenAlgo)).toBeOnTheScreen()
  })

  test('too_old goes to /update with the update steps', async () => {
    setup({ 'GET /auth/app-info': { status: 200, body: { version: '1.0.0.41' } } })
    await open()
    await submitServer(ORIGIN)
    expect(await screen.findByText(COPY.tooOldNative)).toBeOnTheScreen()
    expect(screen.getByText(COPY.tooOldDocker)).toBeOnTheScreen()
    expect(screen.getByText(/1\.0\.0\.41/)).toBeOnTheScreen()
    expect(screen).toHavePathname('/update')
  })
})

describe('key', () => {
  test('the key stays masked until the toggle is pressed; the screen blocks capture', async () => {
    setup()
    await toKey()
    const input = () => screen.getByTestId('key-input')
    expect(input().props.secureTextEntry).toBe(true)
    await fireEvent.changeText(input(), KEY)
    expect(input().props.secureTextEntry).toBe(true)
    expect(screen.getByText(COPY.scanHint)).toBeOnTheScreen()
    await userEvent.press(screen.getByTestId('key-show'))
    expect(input().props).toMatchObject({
      secureTextEntry: false,
      autoCorrect: false,
      spellCheck: false,
      autoCapitalize: 'none',
      autoComplete: 'off',
      importantForAutofill: 'no',
    })
    await userEvent.press(screen.getByTestId('key-show'))
    expect(input().props.secureTextEntry).toBe(true)
    expect(usePreventScreenCapture).toHaveBeenCalledWith('oa-key')
  })

  test('a format error is refused with nothing sent', async () => {
    const { fetch } = setup()
    await toKey()
    await fireEvent.changeText(screen.getByTestId('key-input'), `api key: ${KEY}`)
    await userEvent.press(screen.getByTestId('key-continue'))
    expect(
      await screen.findByText('An OpenAlgo API key is 64 characters, 0-9 and a-f.'),
    ).toBeOnTheScreen()
    expect(posts(fetch)).toHaveLength(0)
  })

  test('a refused key stays on the key screen', async () => {
    setup({ 'POST /api/v1/search': BAD_KEY })
    await toKey()
    await fireEvent.changeText(screen.getByTestId('key-input'), KEY)
    await userEvent.press(screen.getByTestId('key-continue'))
    await waitFor(() => expect(screen.getByTestId('key-error')).toBeOnTheScreen())
    expect(screen).toHavePathname('/key')
  })

  test('a logged-out broker shows the message, and continuing is still allowed', async () => {
    setup({ 'POST /api/v1/funds': BAD_KEY, 'POST /api/v1/ping': BAD_KEY })
    await toKey()
    await fireEvent.changeText(screen.getByTestId('key-input'), KEY)
    await userEvent.press(screen.getByTestId('key-continue'))
    expect(await screen.findByText(COPY.brokerLoggedOut)).toBeOnTheScreen()
    expect(screen).toHavePathname('/key')
    await userEvent.press(screen.getByTestId('key-continue'))
    expect(await screen.findByTestId('feed-url')).toBeOnTheScreen()
  })

  test('a pasted key that validates is cleared from the clipboard', async () => {
    setup()
    jest.mocked(Clipboard.getStringAsync).mockResolvedValue(KEY)
    await toKey()
    await fireEvent.changeText(screen.getByTestId('key-input'), KEY)
    await userEvent.press(screen.getByTestId('key-continue'))
    await screen.findByTestId('feed-url')
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('')
  })

  test('"Where do I find this?" opens {origin}/apikey in the browser', async () => {
    setup()
    await toKey()
    await userEvent.press(screen.getByText(COPY.findKey))
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/apikey`)
  })

  test('shown on Android, the keyboard is visible-password', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    await act(async () => {
      await renderRouter({ index: () => <KeyField value="" onChangeText={() => {}} /> })
    })
    expect(screen.getByTestId('key-input').props.secureTextEntry).toBe(true)
    await userEvent.press(screen.getByTestId('key-show'))
    expect(screen.getByTestId('key-input').props.keyboardType).toBe('visible-password')
  })
})

describe('feed', () => {
  test('the feed URL is derived, and the same host runs the test with no confirm', async () => {
    const { ws } = setup()
    await toFeed()
    expect(screen.getByTestId('feed-url').props.value).toBe('wss://algo.example.com/ws')
    await userEvent.press(screen.getByTestId('feed-test'))
    expect(ws.sockets).toHaveLength(1)
    expect(ws.last().url).toBe('wss://algo.example.com/ws')
  })

  test('a different WS host needs a confirm before the key goes there', async () => {
    const { ws } = setup()
    await toFeed()
    await fireEvent.changeText(screen.getByTestId('feed-url'), 'wss://feed.example.net/ws')
    await userEvent.press(screen.getByTestId('feed-test'))
    expect(
      screen.getByText(
        'The live feed is on feed.example.net, not algo.example.com. Your API key will be sent there. Continue?',
      ),
    ).toBeOnTheScreen()
    expect(ws.sockets).toHaveLength(0)
    await userEvent.press(screen.getByTestId('feed-host-continue'))
    expect(ws.last().url).toBe('wss://feed.example.net/ws')
  })

  test('cancelling the confirm sends nothing', async () => {
    const { ws } = setup()
    await toFeed()
    await fireEvent.changeText(screen.getByTestId('feed-url'), 'wss://feed.example.net/ws')
    await userEvent.press(screen.getByTestId('feed-test'))
    await userEvent.press(screen.getByTestId('feed-host-cancel'))
    expect(screen.queryByTestId('feed-host-continue')).toBeNull()
    expect(ws.sockets).toHaveLength(0)
  })

  test('ws:// to a public host is refused', async () => {
    const { ws } = setup()
    await toFeed()
    await fireEvent.changeText(screen.getByTestId('feed-url'), 'ws://feed.example.net:8765')
    await userEvent.press(screen.getByTestId('feed-test'))
    expect(
      screen.getByText('This address needs https. http is allowed only on your home network.'),
    ).toBeOnTheScreen()
    expect(ws.sockets).toHaveLength(0)
  })

  test('a live feed saves the profile and the key, then the session is ready', async () => {
    const { ws, kv, secureKV } = setup()
    await toFeed()
    expect(screen.queryByTestId('onboarding-save')).toBeNull()
    await userEvent.press(screen.getByTestId('feed-test'))
    await act(async () => {
      const s = ws.last()
      s.serverOpen()
      s.serverSend(AUTH_OK)
      s.serverSend(PONG)
    })
    expect(await screen.findByTestId('feed-live')).toBeOnTheScreen()
    await userEvent.press(screen.getByTestId('onboarding-save'))
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
    const { activeId, profiles } = JSON.parse(kv.data.get('oa.profiles.v1') ?? '{}')
    expect(useSession.getState().profileId).toBe(activeId)
    expect(profiles[0]).toMatchObject({
      restOrigin: ORIGIN,
      wsUrl: 'wss://algo.example.com/ws',
      feedMode: 'live',
      broker: 'zerodha',
      serverVersion: '2.0.3.5',
    })
    expect(secureKV.data.get(`oa.${activeId}.apikey`)).toBe(KEY)
    expect(kv.data.get(`oa.${activeId}.hasKey`)).toBe('1')
  })

  test('a failed feed offers Setup help and saves in polling mode', async () => {
    const { ws, kv } = setup()
    await toFeed()
    await userEvent.press(screen.getByTestId('feed-test'))
    await act(async () => {
      ws.last().serverOpen()
      ws.last().serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    })
    expect(await screen.findByText(COPY.feedFailed)).toBeOnTheScreen()
    expect(screen.getByTestId('feed-help')).toBeOnTheScreen()
    await userEvent.press(screen.getByTestId('onboarding-save'))
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
    const { profiles } = JSON.parse(kv.data.get('oa.profiles.v1') ?? '{}')
    expect(profiles[0]).toMatchObject({ feedMode: 'polling', lastFeedRetryAt: T0 })
  })

  test('with the broker logged out, BROKER_ERROR shows the broker message and saves live', async () => {
    const { ws, kv } = setup({ 'POST /api/v1/funds': BAD_KEY, 'POST /api/v1/ping': BAD_KEY })
    await toKey()
    await fireEvent.changeText(screen.getByTestId('key-input'), KEY)
    await userEvent.press(screen.getByTestId('key-continue'))
    await screen.findByText(COPY.brokerLoggedOut)
    await userEvent.press(screen.getByTestId('key-continue'))
    await screen.findByTestId('feed-url')
    await userEvent.press(screen.getByTestId('feed-test'))
    await act(async () => {
      ws.last().serverOpen()
      ws.last().serverSend(wsError('BROKER_ERROR', 'No broker configuration found for user'))
    })
    const banner = await screen.findByTestId('feed-broker')
    expect(banner).toHaveTextContent(COPY.brokerLoggedOut)
    expect(screen.queryByText(COPY.feedFailed)).toBeNull()
    expect(screen.queryByTestId('feed-help')).toBeNull()
    expect(screen.queryByTestId('feed-live')).toBeNull()
    expect(ws.sockets).toHaveLength(1)
    await userEvent.press(screen.getByTestId('onboarding-save'))
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
    const { profiles } = JSON.parse(kv.data.get('oa.profiles.v1') ?? '{}')
    expect(profiles[0]).toMatchObject({
      wsUrl: 'wss://algo.example.com/ws',
      feedMode: 'live',
      lastFeedRetryAt: null,
      broker: null,
    })
  })

  test('Setup help opens the help screen', async () => {
    const { ws } = setup()
    await toFeed()
    await userEvent.press(screen.getByTestId('feed-test'))
    await act(async () => {
      ws.last().serverOpen()
      ws.last().serverSend(wsError('AUTHENTICATION_ERROR', 'Invalid API key'))
    })
    await userEvent.press(await screen.findByTestId('feed-help'))
    expect(await screen.findByText(HELP.cloudflaredRule)).toBeOnTheScreen()
    expect(screen).toHavePathname('/help')
  })

  test('editing the URL after a test asks for a new test', async () => {
    const { ws } = setup()
    await toFeed()
    await userEvent.press(screen.getByTestId('feed-test'))
    await act(async () => {
      ws.last().serverOpen()
      ws.last().serverSend(AUTH_OK)
      ws.last().serverSend(PONG)
    })
    await screen.findByTestId('onboarding-save')
    await fireEvent.changeText(screen.getByTestId('feed-url'), 'wss://algo.example.com/ws2')
    expect(screen.queryByTestId('onboarding-save')).toBeNull()
  })
})

describe('setup help', () => {
  test('shows the matrix, the .env lines, docker-run, the cloudflared rule and the tunnel note', async () => {
    setup()
    await renderRouter({ _layout: () => <Stack />, help: AppHelpRoute }, { initialUrl: '/help' })
    for (const row of HELP.matrix) expect(screen.getByText(row.setup)).toBeOnTheScreen()
    for (const line of ENV_LINES) expect(screen.getByText(line)).toBeOnTheScreen()
    expect(screen.getByText(HELP.dockerRun)).toBeOnTheScreen()
    expect(screen.getByText(HELP.cloudflaredRule)).toBeOnTheScreen()
    expect(screen.getByText(HELP.tunnels)).toBeOnTheScreen()
  })
})
