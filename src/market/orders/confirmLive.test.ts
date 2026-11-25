import { usePrefs } from '~/core/config/prefs'
import { confirmLiveOrder, LIVE_ORDER_PROMPT } from './confirmLive'

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}))

const auth: {
  SecurityLevel: Record<'NONE' | 'SECRET' | 'BIOMETRIC_WEAK' | 'BIOMETRIC_STRONG', number>
  authenticateAsync: jest.Mock
  getEnrolledLevelAsync: jest.Mock
} = jest.requireMock('expo-local-authentication')

afterEach(() => {
  jest.clearAllMocks()
  usePrefs.getState().setPrefs({ confirmLiveWrites: false })
})

describe('confirmLiveOrder', () => {
  test('with the setting off it goes ahead without a prompt', async () => {
    expect(await confirmLiveOrder()).toBe('ok')
    expect(auth.authenticateAsync).not.toHaveBeenCalled()
  })

  test('with it on, the prompt reads "Confirm live order"', async () => {
    usePrefs.getState().setPrefs({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(auth.SecurityLevel.BIOMETRIC_STRONG)
    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    expect(await confirmLiveOrder()).toBe('ok')
    expect(LIVE_ORDER_PROMPT).toBe('Confirm live order')
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Confirm live order',
      disableDeviceFallback: false,
    })
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    expect(await confirmLiveOrder()).toBe('cancelled')
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
    expect(await confirmLiveOrder()).toBe('failed')
  })

  test('on a phone with nothing to confirm with, it goes ahead without a prompt', async () => {
    usePrefs.getState().setPrefs({ confirmLiveWrites: true })
    auth.getEnrolledLevelAsync.mockResolvedValue(auth.SecurityLevel.NONE)
    expect(await confirmLiveOrder()).toBe('ok')
    expect(auth.authenticateAsync).not.toHaveBeenCalled()
  })
})
