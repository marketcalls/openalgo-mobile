import { act, renderHook } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { Linking } from 'react-native'
import { clearLogs, getLogLines } from '~/core/log/logger'
import type { FeedStatus } from '~/core/realtime/wsClient'
import { useConnection } from '~/core/services/connection'
import { type Services, ServicesProvider } from '~/core/services/services'
import { openServerPage, useBroker, useBrokerBlocked } from './session'

beforeEach(() => {
  useConnection.getState().reset()
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
})
afterEach(() => jest.restoreAllMocks())

/** Services with a feed whose status the test drives, and a profile that saved `broker`. */
function fakeServices(profileBroker: string | null) {
  let status = { state: 'idle', broker: null } as unknown as FeedStatus
  const listeners = new Set<(s: FeedStatus) => void>()
  const realtime = {
    status: () => status,
    onStatus(fn: (s: FeedStatus) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  const services = {
    realtime,
    profile: { get: () => ({ id: 'p1', broker: profileBroker }) },
  } as unknown as Services
  const setFeed = (patch: Partial<FeedStatus>) => {
    status = { ...status, ...patch }
    for (const fn of listeners) fn(status)
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ServicesProvider value={services}>{children}</ServicesProvider>
  )
  return { setFeed, wrapper }
}

describe('useBrokerBlocked', () => {
  test.each([
    [{}, false],
    [{ brokerSession: 'active' as const, keyState: 'ok' as const }, false],
    [{ brokerSession: 'logged_out' as const }, true],
    [{ keyState: 'invalid' as const }, true],
    [{ banned: 'text' as const }, true],
    [{ banned: 'json' as const }, true],
  ])('%p → %p', async (patch, blocked) => {
    useConnection.getState().set(patch)
    const { result } = await renderHook(() => useBrokerBlocked())
    expect(result.current).toBe(blocked)
  })

  test('follows the connection state', async () => {
    const { result } = await renderHook(() => useBrokerBlocked())
    expect(result.current).toBe(false)
    await act(async () => useConnection.getState().set({ brokerSession: 'logged_out' }))
    expect(result.current).toBe(true)
    await act(async () => useConnection.getState().set({ brokerSession: 'active' }))
    expect(result.current).toBe(false)
  })
})

describe('useBroker', () => {
  test("the feed's auth broker first, then the connection's, then the profile's (ruling 20)", async () => {
    const h = fakeServices('zerodha')
    const { result } = await renderHook(() => useBroker(), { wrapper: h.wrapper })
    expect(result.current).toBe('zerodha')
    await act(async () => useConnection.getState().set({ broker: 'angel' }))
    expect(result.current).toBe('angel')
    await act(async () => h.setFeed({ broker: 'dhan' }))
    expect(result.current).toBe('dhan')
  })

  test('null when nothing has named the broker', async () => {
    const h = fakeServices(null)
    const { result } = await renderHook(() => useBroker(), { wrapper: h.wrapper })
    expect(result.current).toBeNull()
  })
})

describe('openServerPage', () => {
  test.each([
    ['https://algo.example.com', '/login', 'https://algo.example.com/login'],
    ['https://algo.example.com/', '/action-center', 'https://algo.example.com/action-center'],
    ['http://192.168.1.5:5000//', '/apikey', 'http://192.168.1.5:5000/apikey'],
  ] as const)('%s + %s → %s', async (origin, path, url) => {
    openServerPage(origin, path)
    expect(Linking.openURL).toHaveBeenCalledWith(url)
  })

  test('a browser that will not open is logged, not thrown', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no browser'))
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    clearLogs()
    expect(() => openServerPage('https://algo.example.com', '/login')).not.toThrow()
    await act(async () => {})
    expect(getLogLines().join('\n')).toMatch(/WARN .*could not open/)
  })
})
