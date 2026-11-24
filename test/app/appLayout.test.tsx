import AsyncStorage from '@react-native-async-storage/async-storage'
import { userEvent } from '@testing-library/react-native'
import { Slot } from 'expo-router'
import {
  isHiddenFromAccessibility,
  renderRouter,
  screen,
  waitFor,
} from 'expo-router/testing-library'
import * as SplashScreen from 'expo-splash-screen'
import { Text } from 'react-native'
import RootLayout from '~/app/_layout'
import AppLayout from '~/app/(app)/_layout'
import { defaultDeps } from '~/core/services/deps'
import { useSession } from '~/core/services/services'

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

const secure: { deleteItemAsync: jest.Mock } = jest.requireMock('expo-secure-store')

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
