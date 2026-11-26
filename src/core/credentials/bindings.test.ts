import { canUseAppLock, expoAuthenticate, expoConfirm, expoSecureKV } from './bindings'

// The expo modules are reached only through jest's mock registry, so this test, like the rest
// of the pure core outside bindings.ts, imports no expo-* module (core-logic-pure).
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async () => 'stored'),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}))

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
}))

const secure: {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: number
  getItemAsync: jest.Mock
  setItemAsync: jest.Mock
  deleteItemAsync: jest.Mock
} = jest.requireMock('expo-secure-store')
const auth: {
  SecurityLevel: Record<'NONE' | 'SECRET' | 'BIOMETRIC_WEAK' | 'BIOMETRIC_STRONG', number>
  authenticateAsync: jest.Mock
  getEnrolledLevelAsync: jest.Mock
} = jest.requireMock('expo-local-authentication')

const THIS_DEVICE = { keychainAccessible: secure.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

afterEach(() => jest.clearAllMocks())

describe('expoSecureKV', () => {
  test('every call uses WHEN_UNLOCKED_THIS_DEVICE_ONLY', async () => {
    expect(await expoSecureKV.get('oa.p1.apikey')).toBe('stored')
    await expoSecureKV.set('oa.p1.apikey', 'v')
    await expoSecureKV.del('oa.p1.apikey')
    expect(secure.getItemAsync).toHaveBeenCalledWith('oa.p1.apikey', THIS_DEVICE)
    expect(secure.setItemAsync).toHaveBeenCalledWith('oa.p1.apikey', 'v', THIS_DEVICE)
    expect(secure.deleteItemAsync).toHaveBeenCalledWith('oa.p1.apikey', THIS_DEVICE)
  })
})

describe('expoAuthenticate', () => {
  test('prompts with "Unlock OpenAlgo" and allows the device passcode', async () => {
    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    expect(await expoAuthenticate()).toBe(true)
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Unlock OpenAlgo',
      disableDeviceFallback: false,
    })
  })

  test('a cancelled or failed prompt is false', async () => {
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    expect(await expoAuthenticate()).toBe(false)
  })
})

describe('expoConfirm', () => {
  test('prompts with the given message (ruling 5) and allows the device passcode', async () => {
    auth.authenticateAsync.mockResolvedValueOnce({ success: true })
    expect(await expoConfirm('Switch to LIVE trading')).toBe('ok')
    expect(auth.authenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Switch to LIVE trading',
      disableDeviceFallback: false,
    })
  })

  test('a user cancel is cancelled; any other failure is failed', async () => {
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'user_cancel' })
    expect(await expoConfirm('x')).toBe('cancelled')
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'lockout' })
    expect(await expoConfirm('x')).toBe('failed')
    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: 'passcode_not_set' })
    expect(await expoConfirm('x')).toBe('failed')
  })
})

describe('canUseAppLock', () => {
  test('false only when nothing is enrolled', async () => {
    const { SecurityLevel } = auth
    auth.getEnrolledLevelAsync.mockResolvedValueOnce(SecurityLevel.NONE)
    expect(await canUseAppLock()).toBe(false)
    auth.getEnrolledLevelAsync.mockResolvedValueOnce(SecurityLevel.SECRET)
    expect(await canUseAppLock()).toBe(true)
    auth.getEnrolledLevelAsync.mockResolvedValueOnce(SecurityLevel.BIOMETRIC_STRONG)
    expect(await canUseAppLock()).toBe(true)
  })
})
