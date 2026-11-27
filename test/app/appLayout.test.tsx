import AsyncStorage from '@react-native-async-storage/async-storage'
import { userEvent } from '@testing-library/react-native'
import { Slot } from 'expo-router'
import {
  act,
  isHiddenFromAccessibility,
  renderRouter,
  screen,
  waitFor,
} from 'expo-router/testing-library'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { Text } from 'react-native'
import RootLayout from '~/app/_layout'
import AppLayout from '~/app/(app)/_layout'
import type { Capabilities } from '~/core/capabilities/gates'
import { useConnection } from '~/core/services/connection'
import { defaultDeps } from '~/core/services/deps'
import { type Services, useServices, useSession } from '~/core/services/services'
import { applyServerUrl } from '~/features/account/serverChange'
import { signOut } from '~/features/account/signOut'
import { type Trading, useTrading } from '~/market/trading'

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
}))

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async () => 'ab'.repeat(32)),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}))

// The unlock prompt stays up, so the shell never sends a keyed request or opens a socket.
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(() => new Promise(() => {})),
  getEnrolledLevelAsync: jest.fn(async () => 3),
}))

// SQLite is native: the shell's symbol master lives in memory here.
jest.mock('~/market/master/sqlite', () => {
  const { createMemoryMasterDb } = jest.requireActual('~/market/master/memoryDb')
  return { openMasterDb: jest.fn(async () => createMemoryMasterDb()) }
})

const secure: { deleteItemAsync: jest.Mock } = jest.requireMock('expo-secure-store')
const sqlite: { openMasterDb: jest.Mock } = jest.requireMock('~/market/master/sqlite')

const PID = 'p0123456789ab'
const PROFILES = JSON.stringify({
  activeId: PID,
  profiles: [
    {
      id: PID,
      restOrigin: 'https://algo.example.com',
      wsUrl: 'wss://algo.example.com/ws',
      feedMode: 'live',
      httpWarningAcked: false,
      serverVersion: null,
      broker: null,
      createdAt: 0,
      lastFeedRetryAt: null,
    },
  ],
})

// The real root and app layouts over stand-in screens.
const routes = {
  _layout: RootLayout,
  '(app)/_layout': AppLayout,
  '(app)/index': () => <Text>app home</Text>,
  '(onboarding)/_layout': () => <Slot />,
  '(onboarding)/index': () => <Text>onboarding home</Text>,
}

/** Once boot has chosen the app, its group's own profile read fails `times` times. */
function failAppProfileRead(times: number) {
  const kv = defaultDeps.kv
  const real = kv.get.bind(kv)
  let left = times
  jest.spyOn(kv, 'get').mockImplementation(async (key) => {
    if (key === 'oa.profiles.v1' && useSession.getState().status === 'ready' && left > 0) {
      left--
      throw new Error('storage unavailable')
    }
    return real(key)
  })
}

beforeEach(async () => {
  await AsyncStorage.clear()
  await AsyncStorage.multiSet([
    ['oa.profiles.v1', PROFILES],
    [`oa.${PID}.hasKey`, '1'],
  ])
  useSession.setState({ status: 'loading', profileId: null })
  // The cold start's app-info check fails like an unreachable server: no real network.
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'))
  for (const m of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation(() => {})
  }
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

test('a failed start hides the splash and shows an error; "Try again" builds the shell', async () => {
  failAppProfileRead(1)
  const user = userEvent.setup()
  await renderRouter(routes, { initialUrl: '/' })
  expect(await screen.findByText('OpenAlgo could not start')).toBeOnTheScreen()
  expect(SplashScreen.hideAsync).toHaveBeenCalled()
  expect(screen.queryByText('app home', { includeHiddenElements: true })).toBeNull()
  expect(screen.queryByTestId('lock-overlay')).toBeNull()

  await user.press(screen.getByRole('button', { name: 'Try again' }))
  // the shell is built; the content stays hidden from assistive technology while locked
  const home = await screen.findByText('app home', { includeHiddenElements: true })
  expect(isHiddenFromAccessibility(home)).toBe(true)
  expect(screen.queryByText('OpenAlgo could not start')).toBeNull()
  // the lock prompt is up: the cover is blank, with no title behind the prompt (ruling 5)
  expect(screen.getByTestId('lock-overlay')).toBeOnTheScreen()
  expect(screen.queryByText('OpenAlgo is locked')).toBeNull()
})

test('"Forget key and set up again" on the error drops the key and its marker, then onboarding', async () => {
  failAppProfileRead(1)
  const user = userEvent.setup()
  await renderRouter(routes, { initialUrl: '/' })
  await screen.findByText('OpenAlgo could not start')

  await user.press(screen.getByRole('button', { name: 'Forget key and set up again' }))
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
  expect(useSession.getState().status).toBe('onboarding')
  expect(secure.deleteItemAsync).toHaveBeenCalledWith(`oa.${PID}.apikey`, expect.anything())
  await waitFor(async () => expect(await AsyncStorage.getItem(`oa.${PID}.hasKey`)).toBeNull())
})

/** Each services container the app group built, with its trading container, in order. */
const shells: { s: Services; t: Trading }[] = []
/** The app's home, recording the containers it is given. */
function Home() {
  const s = useServices()
  const t = useTrading()
  useEffect(() => {
    shells.push({ s, t })
  }, [s, t])
  return <Text>app home</Text>
}

test('sign-out and a server change each give the app a new trading container: no depth downgrade carries over', async () => {
  shells.length = 0
  await renderRouter({ ...routes, '(app)/index': Home }, { initialUrl: '/' })
  await screen.findByText('app home', { includeHiddenElements: true })
  expect(shells).toHaveLength(1)
  const first = shells[0] as (typeof shells)[number]
  first.t.depthDowngrades.getState().add('dhan:NSE')

  // a server change restarts the app group on the new address
  const OTHER = 'https://other.example.com'
  const caps: Capabilities = {
    host: OTHER,
    version: '2.0.0.0',
    versionSource: 'app-info',
    endpoints: null,
    probed: {},
    fields: {},
    features: {},
    ws: { orderStream: null, ping: null, close1012: false, authDeadline: false },
    probedAt: 0,
  }
  // renderRouter runs on fake timers: the app group's one-tick restart needs them moved on
  await act(async () => {
    const changed = applyServerUrl(first.s, OTHER, caps)
    await jest.advanceTimersByTimeAsync(10)
    await changed
  })
  await waitFor(() => expect(shells).toHaveLength(2))
  const second = shells[1] as (typeof shells)[number]
  expect(second.s.profile.get().restOrigin).toBe(OTHER)
  expect(second.t).not.toBe(first.t)
  expect(second.t.depthDowngrades.getState().keys.size).toBe(0)
  second.t.depthDowngrades.getState().add('dhan:NSE')

  // sign out, then sign in again (onboarding saves the key, then the session is ready)
  await act(() => signOut(second.s, second.t, { deleteUserContent: false }))
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
  await AsyncStorage.setItem(`oa.${PID}.hasKey`, '1')
  await act(async () => useSession.getState().set({ status: 'ready', profileId: PID }))
  await waitFor(() => expect(shells).toHaveLength(3))
  const third = shells[2] as (typeof shells)[number]
  expect(third.t).not.toBe(second.t)
  expect(third.t.depthDowngrades.getState().keys.size).toBe(0)
})

test('the shell reads the server mode with no tabs under it: a deep link still gets its badge (G16)', async () => {
  // a deep link to /tools/maxpain, the chain or the chart mounts no tabs layout
  const auth: { authenticateAsync: jest.Mock } = jest.requireMock('expo-local-authentication')
  auth.authenticateAsync.mockResolvedValueOnce({ success: true })
  ;(globalThis.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) =>
    String(input).endsWith('/api/v1/analyzer')
      ? new Response(
          JSON.stringify({ status: 'success', data: { mode: 'analyze', analyze_mode: true } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      : Promise.reject(new TypeError('Network request failed')),
  )
  useConnection.getState().reset()
  await renderRouter(routes, { initialUrl: '/' })
  await screen.findByText('app home', { includeHiddenElements: true })
  await waitFor(() => expect(useConnection.getState().analyzer).toBe('analyze'))
})

test("the shell opens the symbol master's database once and never waits for it", async () => {
  shells.length = 0
  // SQLite still opening: the app is up all the same
  sqlite.openMasterDb.mockImplementationOnce(() => new Promise(() => {}))
  await renderRouter({ ...routes, '(app)/index': Home }, { initialUrl: '/' })
  await screen.findByText('app home', { includeHiddenElements: true })
  expect(shells).toHaveLength(1)
  expect(sqlite.openMasterDb).toHaveBeenCalledTimes(1)
})
