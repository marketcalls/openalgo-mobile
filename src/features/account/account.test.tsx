import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, renderHook, userEvent, waitFor } from '@testing-library/react-native'
import { Stack } from 'expo-router'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { usePreventScreenCapture } from 'expo-screen-capture'
import type { ReactNode } from 'react'
import { Alert, Linking } from 'react-native'
import AccountTab from '~/app/(app)/(tabs)/account'
import DiagnosticsRoute from '~/app/(app)/account/diagnostics'
import KeyRoute from '~/app/(app)/account/key'
import LostPhoneRoute from '~/app/(app)/account/lost-phone'
import ServerRoute from '~/app/(app)/account/server'
import SignOutRoute from '~/app/(app)/account/sign-out'
import { usePrefs } from '~/core/config/prefs'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { useConnection } from '~/core/services/connection'
import {
  type AppDeps,
  createServices,
  disposeServices,
  type Services,
  ServicesProvider,
  useSession,
} from '~/core/services/services'
import { COPY, wsHostDiffers } from '~/features/onboarding'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, PONG } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { ANALYZER_COPY, useAnalyzer, useToggleAnalyzer } from './api'
import { LOST_PHONE_STEPS } from './screens/LostPhoneScreen'
import { SIGN_OUT_COPY } from './screens/SignOutScreen'
import { signOut } from './signOut'

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
const PID = 'p0123456789ab'
const KEY = 'ab'.repeat(32)
const KEY2 = 'cd'.repeat(32)
const T0 = Date.UTC(2026, 10, 24, 4, 0)

const PROFILE: ServerProfile = {
  id: PID,
  restOrigin: ORIGIN,
  wsUrl: 'wss://algo.example.com/ws',
  feedMode: 'live',
  httpWarningAcked: false,
  serverVersion: '2.0.3.5',
  broker: 'zerodha',
  createdAt: 0,
  lastFeedRetryAt: null,
}

const analyzer = (mode: 'live' | 'analyze'): Route => ({
  status: 200,
  body: { status: 'success', data: { mode, analyze_mode: mode === 'analyze', total_logs: 0 } },
})
const BUSY = 'Another mode change is still in progress. Try again in a moment.'
const OK_ROUTES: Record<string, Route> = {
  'POST /api/v1/analyzer': analyzer('live'),
  'GET /auth/app-info': { status: 200, body: { status: 'success', version: '2.0.3.5' } },
  'GET /api/v1/swagger.json': { status: 200, body: { paths: { '/multioptiongreeks/': {} } } },
  'POST /api/v1/search': { status: 200, body: { status: 'success', data: [] } },
  'POST /api/v1/funds': { status: 200, body: { status: 'success', data: { availablecash: '1' } } },
  'POST /api/v1/ping': {
    status: 200,
    body: { status: 'success', data: { message: 'pong', broker: 'zerodha' } },
  },
}

let services: Services | null = null
let kv = memoryKV()
let secureKV = memoryKV()
let sockets = fakeSockets()
let fetchFake = scriptedFetch({})

async function setup(
  routes: Record<string, Route> = {},
  profile: ServerProfile = PROFILE,
  unlockApp = false,
) {
  fetchFake = scriptedFetch({ ...OK_ROUTES, ...routes })
  sockets = fakeSockets()
  kv = memoryKV()
  secureKV = memoryKV({ [`oa.${profile.id}.apikey`]: KEY })
  await kv.set(`oa.${profile.id}.hasKey`, '1')
  await kv.set(`oa.${profile.id}.watchlists`, '{"lists":[]}')
  await createProfileRepo(kv).save(profile)
  Object.assign(mockDeps, {
    fetch: fetchFake,
    WebSocketImpl: sockets.WebSocketImpl,
    secureKV,
    kv,
    now: () => T0,
    uuid: () => 'u',
    allowDevHosts: false,
    lock: {
      settings: () => ({ enabled: false, lockAfterMs: 60_000 }),
      authenticate: jest.fn(async () => true),
      available: async () => true,
    },
  })
  services = createServices(profile, mockDeps)
  // the lock controller opens the app (queries wait for it); the vault alone only holds the key
  if (unlockApp) await services.lock.unlock()
  else await services.vault.unlock()
  return services
}

const wrapper = ({ children }: { children: ReactNode }) =>
  services ? (
    <ServicesProvider value={services}>
      <QueryClientProvider client={services.queryClient}>{children}</QueryClientProvider>
    </ServicesProvider>
  ) : null

function Layout() {
  if (!services) return null
  return (
    <ServicesProvider value={services}>
      <QueryClientProvider client={services.queryClient}>
        <Stack />
      </QueryClientProvider>
    </ServicesProvider>
  )
}

const ROUTES = {
  _layout: Layout,
  index: AccountTab,
  'account/server': ServerRoute,
  'account/key': KeyRoute,
  'account/diagnostics': DiagnosticsRoute,
  'account/lost-phone': LostPhoneRoute,
  'account/sign-out': SignOutRoute,
}

const calls = (path: string) =>
  fetchFake.calls.filter((c) => c.method === 'POST' && c.url.endsWith(path))

/** The confirm button of the last Alert. */
const confirmAlert = async (spy: jest.SpyInstance) => {
  const buttons = spy.mock.calls.at(-1)?.[2] as { text: string; onPress: () => void }[]
  await act(async () => buttons[1]?.onPress())
}

beforeEach(() => {
  useSession.setState({ status: 'ready', profileId: PID })
  useConnection.getState().reset()
  usePrefs.setState({ confirmLiveWrites: false })
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})
afterEach(async () => {
  // unmount first, so no observer touches a query the disposal has dropped
  await cleanup()
  if (services) disposeServices(services)
  services = null
  jest.restoreAllMocks()
})

describe('useAnalyzer', () => {
  test.each(['live', 'analyze'] as const)('reads %s and writes conn.analyzer', async (mode) => {
    await setup({ 'POST /api/v1/analyzer': analyzer(mode) }, PROFILE, true)
    const { result } = await renderHook(() => useAnalyzer(), { wrapper })
    await waitFor(() => expect(result.current).toBe(mode))
    expect(useConnection.getState().analyzer).toBe(mode)
  })

  test('an error is unknown', async () => {
    // a refusal is not retried, so the query settles in error at once
    await setup(
      { 'POST /api/v1/analyzer': { status: 400, body: { status: 'error', message: 'bad' } } },
      PROFILE,
      true,
    )
    useConnection.getState().set({ analyzer: 'live' })
    const { result } = await renderHook(() => useAnalyzer(), { wrapper })
    await waitFor(() => expect(calls('/analyzer')).toHaveLength(1))
    await waitFor(() => expect(services?.queryClient.isFetching()).toBe(0))
    expect(result.current).toBe('unknown')
    expect(useConnection.getState().analyzer).toBe('unknown')
  })
})

describe('useToggleAnalyzer', () => {
  test('going LIVE confirms, then sends {mode:false} once and asks the mode again', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await setup({ 'POST /api/v1/analyzer/toggle': analyzer('live') }, PROFILE, true)
    const { result } = await renderHook(
      () => {
        useAnalyzer()
        return useToggleAnalyzer()
      },
      { wrapper },
    )
    await waitFor(() => expect(calls('/analyzer')).toHaveLength(1))
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = result.current.toggle('live')
    })
    expect(alert).toHaveBeenCalledWith(
      ANALYZER_COPY.live.title,
      ANALYZER_COPY.live.message,
      expect.any(Array),
      expect.anything(),
    )
    expect(ANALYZER_COPY.live.title).toBe('Switch to LIVE?')
    expect(calls('/analyzer/toggle')).toHaveLength(0)
    await confirmAlert(alert)
    await act(async () => done)
    expect(calls('/analyzer/toggle')).toHaveLength(1)
    expect(calls('/analyzer/toggle')[0]?.body).toMatchObject({ mode: false })
    await waitFor(() => expect(calls('/analyzer')).toHaveLength(2))
  })

  test('a cancelled confirm sends nothing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await setup()
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    await act(async () => {
      void result.current.toggle('analyze')
    })
    const buttons = alert.mock.calls[0]?.[2] as { onPress: () => void }[]
    await act(async () => buttons[0]?.onPress())
    expect(calls('/analyzer/toggle')).toHaveLength(0)
  })

  test('a failed biometric check stops a switch to LIVE', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    usePrefs.setState({ confirmLiveWrites: true })
    await setup()
    mockDeps.lock.authenticate = jest.fn(async () => false)
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    await act(async () => {
      void result.current.toggle('live')
    })
    await confirmAlert(alert)
    expect(mockDeps.lock.authenticate).toHaveBeenCalled()
    expect(calls('/analyzer/toggle')).toHaveLength(0)
  })

  test("a 409 shows the server's message", async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    await setup({
      'POST /api/v1/analyzer/toggle': { status: 409, body: { status: 'error', message: BUSY } },
    })
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    await act(async () => {
      void result.current.toggle('analyze')
    })
    await confirmAlert(alert)
    await waitFor(() => expect(result.current.error).toBe(BUSY))
    expect(calls('/analyzer/toggle')).toHaveLength(1)
  })
})

describe('account screen', () => {
  test('shows the URL, and "unknown, 2.0.0.0 or later" when the version is not known', async () => {
    await setup({}, { ...PROFILE, serverVersion: null })
    await renderRouter(ROUTES, { initialUrl: '/' })
    expect(await screen.findByText(ORIGIN)).toBeOnTheScreen()
    expect(screen.getByText('OpenAlgo unknown, 2.0.0.0 or later')).toBeOnTheScreen()
  })

  test('the toggle is replaced by a note once Semi-Auto has been seen', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/' })
    expect(await screen.findByTestId('analyzer-toggle')).toBeOnTheScreen()
    await act(async () => useConnection.getState().set({ semiAutoSeen: true }))
    expect(screen.queryByTestId('analyzer-toggle')).toBeNull()
    expect(
      screen.getByText(
        'Mode switching is off because this account uses Semi-Auto orders. Change the mode on the web.',
      ),
    ).toBeOnTheScreen()
  })

  test('a logged-out broker offers a login that opens {origin}/login', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/' })
    await screen.findByTestId('analyzer-toggle')
    expect(screen.queryByTestId('broker-login')).toBeNull()
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    await userEvent.press(screen.getByText('Log in to your broker'))
    expect(Linking.openURL).toHaveBeenCalledWith(`${ORIGIN}/login`)
  })

  test('links to the other screens', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/' })
    await userEvent.press(await screen.findByTestId('link-key'))
    expect(screen).toHavePathname('/account/key')
  })
})

describe('sign out', () => {
  test('keeps watchlists unless asked; deletes the key and marker; keeps the profile id', async () => {
    const s = await setup()
    await signOut(s, { deleteUserContent: false })
    expect(secureKV.data.has(`oa.${PID}.apikey`)).toBe(false)
    expect(kv.data.has(`oa.${PID}.hasKey`)).toBe(false)
    expect(kv.data.has(`oa.${PID}.watchlists`)).toBe(true)
    expect((await createProfileRepo(kv).load())?.id).toBe(PID)
    expect(useSession.getState().status).toBe('onboarding')
  })

  test('deletes the watchlists when asked', async () => {
    const s = await setup()
    await signOut(s, { deleteUserContent: true })
    expect(kv.data.has(`oa.${PID}.watchlists`)).toBe(false)
    expect((await createProfileRepo(kv).load())?.restOrigin).toBe(ORIGIN)
  })

  test('the screen says what stays and signs out with the switch off by default', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/account/sign-out' })
    expect(await screen.findByText(SIGN_OUT_COPY.notRevoked)).toBeOnTheScreen()
    expect(screen.getByTestId('sign-out-delete').props.value).toBe(false)
    await userEvent.press(screen.getByTestId('sign-out-confirm'))
    await waitFor(() => expect(useSession.getState().status).toBe('onboarding'))
    expect(kv.data.has(`oa.${PID}.watchlists`)).toBe(true)
  })
})

describe('lost phone', () => {
  test('shows the two steps in order', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/account/lost-phone' })
    expect(await screen.findByTestId('lost-step-1')).toHaveTextContent(
      new RegExp(LOST_PHONE_STEPS[0].title),
    )
    expect(screen.getByTestId('lost-step-2')).toHaveTextContent(
      new RegExp(LOST_PHONE_STEPS[1].title),
    )
    expect(screen.getByText(/breaks other API clients/)).toBeOnTheScreen()
  })
})

describe('diagnostics screen', () => {
  test('shows the capability report', async () => {
    await setup()
    await services?.caps.save({
      host: ORIGIN,
      version: '2.0.1.6',
      versionSource: 'app-info',
      endpoints: null,
      probed: {},
      fields: {},
      ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
      probedAt: 0,
    })
    await renderRouter(ROUTES, { initialUrl: '/account/diagnostics' })
    expect(await screen.findByTestId('cap-optionchainGreeks')).toHaveTextContent(/needs 2\.0\.2\.0/)
    expect(screen.getByTestId('diagnostics-copy')).toBeOnTheScreen()
  })
})

describe('change key', () => {
  test('blocks screenshots, and a valid key goes to vault.replace', async () => {
    const s = await setup()
    const replace = jest.spyOn(s.vault, 'replace')
    await renderRouter(ROUTES, { initialUrl: '/account/key' })
    await screen.findByTestId('key-input')
    expect(usePreventScreenCapture).toHaveBeenCalled()
    await fireEvent.changeText(screen.getByTestId('key-input'), KEY2)
    await userEvent.press(screen.getByTestId('key-save'))
    await waitFor(() => expect(replace).toHaveBeenCalledWith(KEY2))
    expect(secureKV.data.get(`oa.${PID}.apikey`)).toBe(KEY2)
  })

  test('a malformed key sends nothing and is not saved', async () => {
    const s = await setup()
    const replace = jest.spyOn(s.vault, 'replace')
    await renderRouter(ROUTES, { initialUrl: '/account/key' })
    await fireEvent.changeText(await screen.findByTestId('key-input'), 'nope')
    await userEvent.press(screen.getByTestId('key-save'))
    expect(await screen.findByTestId('key-error')).toBeOnTheScreen()
    expect(replace).not.toHaveBeenCalled()
    expect(fetchFake.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})

describe('server settings', () => {
  test('a new URL keeps the id, watchlist and key, and forces a re-probe', async () => {
    await setup()
    const NEW = 'https://algo2.example.com'
    await services?.storage.setJSON('caps', { stale: true })
    await renderRouter(ROUTES, { initialUrl: '/account/server' })
    await fireEvent.changeText(await screen.findByTestId('server-url'), NEW)
    await userEvent.press(screen.getByTestId('server-save'))
    await waitFor(async () => expect((await createProfileRepo(kv).load())?.restOrigin).toBe(NEW))
    const saved = await createProfileRepo(kv).load()
    expect(saved?.id).toBe(PID)
    expect(kv.data.has(`oa.${PID}.watchlists`)).toBe(true)
    expect(secureKV.data.get(`oa.${PID}.apikey`)).toBe(KEY)
    expect(kv.data.has(`oa.${PID}.hasKey`)).toBe(true)
    // no stored capabilities: the next start probes the server again
    expect(kv.data.has(`oa.${PID}.caps`)).toBe(false)
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
  })

  test('ws:// to a public host shows the cleartext_public error and opens no socket', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/account/server' })
    await fireEvent.changeText(await screen.findByTestId('feed-url'), 'ws://feed.example.net/ws')
    await userEvent.press(screen.getByTestId('feed-test'))
    expect(
      await screen.findByText(
        'This address needs https. http is allowed only on your home network.',
      ),
    ).toBeOnTheScreen()
    expect(sockets.sockets).toHaveLength(0)
  })

  test('a different feed host needs the confirm, then the test saves the result', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/account/server' })
    await fireEvent.changeText(await screen.findByTestId('feed-url'), 'wss://feed.example.net/ws')
    await userEvent.press(screen.getByTestId('feed-test'))
    expect(
      screen.getByText(wsHostDiffers('feed.example.net', 'algo.example.com')),
    ).toBeOnTheScreen()
    expect(sockets.sockets).toHaveLength(0)
    await userEvent.press(screen.getByTestId('feed-host-continue'))
    await waitFor(() => expect(sockets.sockets.length).toBeGreaterThan(0))
    const ws = sockets.sockets[0] as NonNullable<(typeof sockets.sockets)[0]>
    expect(ws.url).toBe('wss://feed.example.net/ws')
    await act(async () => {
      ws.serverOpen()
      ws.serverSend(AUTH_OK)
      ws.serverSend(PONG)
    })
    expect(await screen.findByText(COPY.feedLive)).toBeOnTheScreen()
    expect((await createProfileRepo(kv).load())?.wsUrl).toBe('wss://feed.example.net/ws')
  })
})
