import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, render, waitFor } from '@testing-library/react-native'
import AppLayout from '~/app/(app)/_layout'
import { useSession } from '~/core/services/services'

// The real app layout, whose stack records the screens it declares (preflight conflict 32): only
// the options each route is given are under test here.
const mockScreens: { name: string; options?: Record<string, unknown> }[] = []
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react')
  const Stack = ({ children }: { children?: unknown }) => createElement(Fragment, null, children)
  Stack.Screen = (p: { name: string; options?: Record<string, unknown> }) => {
    mockScreens.push(p)
    return null
  }
  return { ...jest.requireActual('expo-router'), Stack }
})

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

beforeEach(async () => {
  mockScreens.length = 0
  await AsyncStorage.clear()
  await AsyncStorage.multiSet([
    ['oa.profiles.v1', PROFILES],
    [`oa.${PID}.hasKey`, '1'],
  ])
  useSession.setState({ status: 'ready', profileId: PID })
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

test('chart/[key] has no header and no back swipe', async () => {
  const view = await render(<AppLayout />)
  await waitFor(() => expect(mockScreens.some((s) => s.name === 'chart/[key]')).toBe(true))
  const chart = mockScreens.filter((s) => s.name === 'chart/[key]').at(-1)
  // the chart owns every pan: an edge swipe would leave it mid-drag
  expect(chart?.options).toEqual({
    headerShown: false,
    gestureEnabled: false,
    fullScreenGestureEnabled: false,
    animation: 'slide_from_right',
  })
  await act(async () => view.unmount())
})
