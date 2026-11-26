import { QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  isHiddenFromAccessibility,
  renderHook,
  userEvent,
  waitFor,
} from '@testing-library/react-native'
import Constants from 'expo-constants'
import { Stack } from 'expo-router'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { usePreventScreenCapture } from 'expo-screen-capture'
import * as Sharing from 'expo-sharing'
import type { ReactNode } from 'react'
import { Alert, Linking } from 'react-native'
import AccountTab from '~/app/(app)/(tabs)/account'
import BackupRoute from '~/app/(app)/account/backup'
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
import { TradingProvider } from '~/market/trading'
import { type Route, scriptedFetch } from '../../../test/helpers/fakeFetch'
import { AUTH_OK, fakeSockets, PONG } from '../../../test/helpers/fakeSocket'
import { memoryKV } from '../../../test/helpers/memoryKV'
import { ANALYZER_COPY, CONFIRM_FAILED, LIVE_PROMPT, useAnalyzer, useToggleAnalyzer } from './api'
import { LOST_PHONE_STEPS } from './screens/LostPhoneScreen'
import { SIGN_OUT_COPY } from './screens/SignOutScreen'
import { signOut } from './signOut'
import { resetUpdateCheck, useUpdateNotice } from './update'

const mockDeps = {} as AppDeps
jest.mock('~/core/services/deps', () => ({
  get defaultDeps() {
    return mockDeps
  },
}))
// the share sheet and the file system are the native edges of the backup
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => {}) }))
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }))
jest.mock('expo-file-system', () => {
  const written = new Map<string, string>()
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : 'cache')).join('/')
    }
    create() {}
    async write(text: string) {
      written.set(this.uri, text)
    }
    async text() {
      return written.get(this.uri) ?? ''
    }
  }
  return { File, Paths: { cache: 'cache' }, __written: written }
})
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }))
// AppState is never 'active' in jest; the diagnostics screen's GTT read waits for focus
jest.mock('~/core/realtime/useScreenActive', () => ({ useScreenActive: () => true }))
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
/** The routes `fetchFake` answers from; a test may change them. */
let liveRoutes: Record<string, Route> = {}

async function setup(
  routes: Record<string, Route> = {},
  profile: ServerProfile = PROFILE,
  unlockApp = false,
) {
  liveRoutes = { ...OK_ROUTES, ...routes }
  fetchFake = scriptedFetch(liveRoutes)
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
      confirm: jest.fn(async () => 'ok' as const),
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
      <TradingProvider now={() => T0}>
        <QueryClientProvider client={services.queryClient}>
          <Stack />
        </QueryClientProvider>
      </TradingProvider>
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
  'account/backup': BackupRoute,
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
  usePrefs.setState({ confirmLiveWrites: false, updateCheck: true })
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

  test('a replaced key refetches the mode, and the broker is checked again', async () => {
    const BAD_KEY: Route = {
      status: 403,
      body: { status: 'error', message: 'Invalid openalgo apikey' },
    }
    // the key was regenerated on the web: every keyed call is refused, search included
    await setup({ 'POST /api/v1/analyzer': BAD_KEY, 'POST /api/v1/search': BAD_KEY }, PROFILE, true)
    const { result } = await renderHook(() => useAnalyzer(), { wrapper })
    await waitFor(() => expect(useConnection.getState().keyState).toBe('invalid'))
    await waitFor(() => expect(services?.queryClient.isFetching()).toBe(0))
    expect(result.current).toBe('unknown')
    const funds = calls('/funds').length

    // the user saves the new key on /account/key
    liveRoutes['POST /api/v1/analyzer'] = analyzer('live')
    liveRoutes['POST /api/v1/search'] = OK_ROUTES['POST /api/v1/search'] as Route
    await act(async () => services?.vault.replace(KEY2))
    await waitFor(() => expect(result.current).toBe('live'))
    expect(calls('/analyzer').at(-1)?.body).toMatchObject({ apikey: KEY2 })
    await waitFor(() => expect(calls('/funds').length).toBe(funds + 1))
    expect(useConnection.getState()).toMatchObject({ keyState: 'ok', brokerSession: 'active' })
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

  test('a failed biometric check stops a switch to LIVE and says why', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    usePrefs.setState({ confirmLiveWrites: true })
    await setup()
    mockDeps.lock.confirm = jest.fn(async () => 'failed' as const)
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    await act(async () => {
      void result.current.toggle('live')
    })
    await confirmAlert(alert)
    // ruling 5: the prompt names the live write, not the unlock
    expect(mockDeps.lock.confirm).toHaveBeenCalledWith(LIVE_PROMPT)
    expect(LIVE_PROMPT).toBe('Switch to LIVE trading')
    expect(mockDeps.lock.authenticate).not.toHaveBeenCalled()
    expect(calls('/analyzer/toggle')).toHaveLength(0)
    await waitFor(() => expect(result.current.error).toBe(CONFIRM_FAILED))
  })

  test('a cancelled biometric prompt stops a switch to LIVE without an error', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    usePrefs.setState({ confirmLiveWrites: true })
    await setup()
    mockDeps.lock.confirm = jest.fn(async () => 'cancelled' as const)
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    await act(async () => {
      void result.current.toggle('live')
    })
    await confirmAlert(alert)
    expect(calls('/analyzer/toggle')).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })

  test('with no passcode or biometrics, the switch to LIVE goes ahead with no prompt', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
    usePrefs.setState({ confirmLiveWrites: true })
    await setup({ 'POST /api/v1/analyzer/toggle': analyzer('live') })
    mockDeps.lock.available = async () => false
    const { result } = await renderHook(() => useToggleAnalyzer(), { wrapper })
    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = result.current.toggle('live')
    })
    await confirmAlert(alert)
    await act(async () => done)
    expect(mockDeps.lock.confirm).not.toHaveBeenCalled()
    expect(calls('/analyzer/toggle')).toHaveLength(1)
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

// before any renderRouter test: renderHook does not render once the router test library has run
describe('useUpdateNotice', () => {
  const releaseFetch = () =>
    scriptedFetch({
      'GET /repos/marketcalls/openalgo-mobile/releases/latest': {
        status: 200,
        body: {
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/marketcalls/openalgo-mobile/releases/tag/v99.0.0',
        },
      },
    })

  beforeEach(() => {
    resetUpdateCheck()
    usePrefs.setState({ updateCheck: true })
  })

  test('turning the switch off stops the check', async () => {
    await setup()
    mockDeps.fetch = releaseFetch()
    usePrefs.setState({ updateCheck: false })
    await renderHook(() => useUpdateNotice())
    await act(async () => {})
    expect((mockDeps.fetch as ReturnType<typeof scriptedFetch>).calls).toHaveLength(0)
  })

  test('a mount before the prefs load sends nothing when the saved choice is off', async () => {
    await setup()
    const f = releaseFetch()
    mockDeps.fetch = f
    let finish: () => void = () => {}
    const hydrated = jest.spyOn(usePrefs.persist, 'hasHydrated').mockReturnValue(false)
    const onFinish = jest.spyOn(usePrefs.persist, 'onFinishHydration').mockImplementation((fn) => {
      finish = () => fn(usePrefs.getState())
      return () => {}
    })
    try {
      await renderHook(() => useUpdateNotice())
      await act(async () => {})
      expect(f.calls).toHaveLength(0)
      usePrefs.setState({ updateCheck: false }) // the saved value arrives
      hydrated.mockReturnValue(true)
      await act(async () => finish())
      expect(f.calls).toHaveLength(0)
    } finally {
      hydrated.mockRestore()
      onFinish.mockRestore()
    }
  })

  test('two concurrent mounts send one request and both get the notice', async () => {
    await setup()
    const f = releaseFetch()
    mockDeps.fetch = f
    const { result } = await renderHook(() => [useUpdateNotice(), useUpdateNotice()] as const)
    await waitFor(() => expect(result.current?.[0].notice?.version).toBe('99.0.0'))
    expect(result.current?.[1].notice?.version).toBe('99.0.0')
    expect(f.calls).toHaveLength(1)
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

  test('with no passcode or biometrics, the confirm-live switch is off and disabled, with a note', async () => {
    usePrefs.setState({ confirmLiveWrites: true })
    await setup()
    mockDeps.lock.available = async () => false
    await renderRouter(ROUTES, { initialUrl: '/' })
    expect(await screen.findByTestId('confirm-live-unavailable')).toHaveTextContent(
      'Set a device passcode to confirm live actions',
    )
    const sw = screen.getByTestId('pref-confirm-live')
    expect(sw.props.value).toBe(false)
    expect(sw.props.disabled).toBe(true)
  })

  test('the update switch is on by default, saves its choice, and shows a stored notice', async () => {
    await setup()
    await kv.set(
      'oa.update.v1',
      JSON.stringify({ checkedAt: 1, latest: { version: '99.0.0', url: 'u' } }),
    )
    usePrefs.setState({ updateCheck: true })
    await renderRouter(ROUTES, { initialUrl: '/' })
    const sw = await screen.findByTestId('pref-update-check')
    expect(sw.props.value).toBe(true)
    expect(await screen.findByTestId('account-update')).toHaveTextContent(
      'Version 99.0.0 is available',
    )
    expect(screen.getByText(/Nothing about you or your server is sent/)).toBeOnTheScreen()
    await act(async () => fireEvent(sw, 'valueChange', false))
    expect(usePrefs.getState().updateCheck).toBe(false)
    expect(screen.queryByTestId('account-update')).toBeNull()
  })

  test('About shows the OpenAlgo mark with the app name and version', async () => {
    // The test runtime has no app config (a build embeds app.config.ts), so give it one.
    const config = Constants.expoConfig as unknown as Record<string, unknown>
    const saved = { ...config }
    Object.assign(config, { name: 'OpenAlgo', version: '9.8.7' })
    try {
      await setup()
      await renderRouter(ROUTES, { initialUrl: '/' })
      expect(await screen.findByTestId('account-about')).toHaveTextContent(
        'AboutOpenAlgoVersion 9.8.7',
      )
      const mark = screen.getByTestId('about-mark', { includeHiddenElements: true })
      expect(JSON.stringify(mark.props.source)).toContain('assets/brand/openalgo-mark.png')
      // decorative: the name beside it says OpenAlgo
      expect(isHiddenFromAccessibility(mark)).toBe(true)
    } finally {
      for (const k of Object.keys(config)) delete config[k]
      Object.assign(config, saved)
    }
  })

  test('links to back up and restore', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/' })
    await userEvent.press(await screen.findByText('Back up and restore'))
    expect(screen).toHavePathname('/account/backup')
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

describe('sign out backup', () => {
  test('signout-backup shares the lists first and does not sign out', async () => {
    await setup()
    await renderRouter(ROUTES, { initialUrl: '/account/sign-out' })
    await userEvent.press(await screen.findByTestId('signout-backup'))
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledTimes(1))
    const [uri, options] = jest.mocked(Sharing.shareAsync).mock.calls[0] ?? []
    expect(uri).toMatch(/^cache\/openalgo-backup-\d{8}-\d{4}\.json$/)
    expect(options).toMatchObject({ mimeType: 'application/json', dialogTitle: 'Save backup' })
    const written = (jest.requireMock('expo-file-system') as { __written: Map<string, string> })
      .__written
    expect(JSON.parse(written.get(uri ?? '') ?? '').kind).toBe('openalgo-mobile-backup')
    expect(useSession.getState().status).not.toBe('onboarding')
  })

  test('a failed backup says so and leaves the sign-out button usable', async () => {
    await setup()
    jest.mocked(Sharing.shareAsync).mockRejectedValueOnce(new Error('no space'))
    await renderRouter(ROUTES, { initialUrl: '/account/sign-out' })
    await userEvent.press(await screen.findByTestId('signout-backup'))
    expect(await screen.findByText(SIGN_OUT_COPY.backupFailed)).toBeOnTheScreen()
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
      features: {},
      ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
      probedAt: 0,
    })
    await renderRouter(ROUTES, { initialUrl: '/account/diagnostics' })
    expect(await screen.findByTestId('cap-optionchainGreeks')).toHaveTextContent(/needs 2\.0\.2\.0/)
    expect(screen.getByTestId('diagnostics-copy')).toBeOnTheScreen()
  })

  test('shows GTT support, which one read of the GTT book settles while it is open', async () => {
    await setup(
      { 'POST /api/v1/gttorderbook': { status: 200, body: { status: 'success', data: [] } } },
      PROFILE,
      true,
    )
    useConnection.getState().set({ analyzer: 'live' })
    await services?.caps.save({
      host: ORIGIN,
      version: '2.0.1.6',
      versionSource: 'app-info',
      endpoints: null,
      probed: {},
      fields: {},
      features: {},
      ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
      probedAt: 0,
    })
    await renderRouter(ROUTES, { initialUrl: '/account/diagnostics' })
    await waitFor(() =>
      expect(screen.getByTestId('cap-gtt')).toHaveTextContent(
        'on   gtt: The server serves GTT for zerodha in LIVE',
      ),
    )
    expect(calls('/gttorderbook')).toHaveLength(1)
    expect(services?.caps.get()?.features).toEqual({ 'gtt:zerodha:live': true })
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
  test('a new URL keeps the id, watchlist and key, and stores the probe it ran', async () => {
    // the old server was a tunnel: polling, with a live-feed retry a moment ago
    await setup({}, { ...PROFILE, feedMode: 'polling', lastFeedRetryAt: T0 })
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
    // the new server's feed is tried afresh: live, with no retry clock from the old one
    expect(saved).toMatchObject({
      wsUrl: 'wss://algo2.example.com/ws',
      feedMode: 'live',
      lastFeedRetryAt: null,
      serverVersion: '2.0.3.5',
    })
    // the probe just run is kept, so the next start does not probe the new server again
    const caps = JSON.parse(kv.data.get(`oa.${PID}.caps`) ?? '{}')
    expect(caps).toMatchObject({ host: NEW, version: '2.0.3.5' })
    await waitFor(() => expect(useSession.getState().status).toBe('ready'))
    const probes = () => fetchFake.calls.filter((c) => c.url.endsWith('/swagger.json')).length
    const before = probes()
    const next = createServices(saved as ServerProfile, mockDeps)
    try {
      await next.lifecycle.coldStart()
      expect(probes()).toBe(before)
    } finally {
      disposeServices(next)
    }
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
