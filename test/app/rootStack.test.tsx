import AsyncStorage from '@react-native-async-storage/async-storage'
import { Slot } from 'expo-router'
import { act, renderRouter, screen } from 'expo-router/testing-library'
import { Text } from 'react-native'
import type { TestInstance } from 'test-renderer'
import RootLayout from '~/app/_layout'
import { useSession } from '~/core/services/services'

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

// The real root layout over stand-in groups: only the guards are under test here.
const routes = {
  _layout: RootLayout,
  '(app)/_layout': () => <Slot />,
  '(app)/index': () => <Text>app home</Text>,
  '(app)/watch': () => <Text>app only</Text>,
  '(onboarding)/_layout': () => <Slot />,
  '(onboarding)/index': () => <Text>onboarding home</Text>,
  '(onboarding)/server': () => <Text>onboarding only</Text>,
}

beforeEach(async () => {
  await AsyncStorage.clear()
  useSession.setState({ status: 'loading', profileId: null })
})

test('no profile goes to onboarding, and the app cannot be reached', async () => {
  await renderRouter(routes, { initialUrl: '/watch' })
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
  expect(screen.queryByText('app only')).toBeNull()
  expect(screen.queryByText('app home')).toBeNull()
})

test('a profile with the key marker goes to the app, and onboarding cannot be reached', async () => {
  await AsyncStorage.multiSet([
    ['oa.profiles.v1', PROFILES],
    [`oa.${PID}.hasKey`, '1'],
  ])
  await renderRouter(routes, { initialUrl: '/server' })
  expect(await screen.findByText('app home')).toBeOnTheScreen()
  expect(screen.queryByText('onboarding only')).toBeNull()
  expect(screen.queryByText('onboarding home')).toBeNull()
})

test('a profile without the marker goes to onboarding', async () => {
  await AsyncStorage.setItem('oa.profiles.v1', PROFILES)
  await renderRouter(routes, { initialUrl: '/' })
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
})

test('changing the session back to onboarding leaves the app', async () => {
  await AsyncStorage.multiSet([
    ['oa.profiles.v1', PROFILES],
    [`oa.${PID}.hasKey`, '1'],
  ])
  await renderRouter(routes, { initialUrl: '/' })
  expect(await screen.findByText('app home')).toBeOnTheScreen()
  await act(async () => {
    useSession.getState().set({ status: 'onboarding' })
  })
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
  expect(screen.queryByText('app home')).toBeNull()
})

test('the whole app sits in one full-size gesture-handler root view', async () => {
  await renderRouter(routes, { initialUrl: '/' })
  expect(await screen.findByText('onboarding home')).toBeOnTheScreen()
  // expo-router's own safe-area provider is the host root; the layout's tree is its first child.
  const rootView = screen.root?.children[0] as TestInstance | undefined
  expect(rootView?.type).toBe('View')
  expect(rootView).toHaveStyle({ flex: 1 })
  const first = rootView?.children[0] as TestInstance | undefined
  expect(first?.type).toBe('RNCSafeAreaProvider')
})
