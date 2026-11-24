import * as ScreenCapture from 'expo-screen-capture'
import { Platform } from 'react-native'
import { clearLogs, getLogLines } from '~/core/log/logger'
import { applyPrivacy } from './privacy'

jest.mock('expo-screen-capture', () => ({
  enableAppSwitcherProtectionAsync: jest.fn(async () => {}),
  preventScreenCaptureAsync: jest.fn(async () => {}),
  allowScreenCaptureAsync: jest.fn(async () => {}),
}))

const sc = jest.mocked(ScreenCapture)
const onPlatform = (os: 'ios' | 'android') => jest.replaceProperty(Platform, 'OS', os)

afterEach(() => {
  jest.clearAllMocks()
  jest.restoreAllMocks()
})

test('iOS blurs the app switcher at 0.9 and leaves screen capture alone', async () => {
  onPlatform('ios')
  await applyPrivacy({ hideContentAndroid: false })
  expect(sc.enableAppSwitcherProtectionAsync).toHaveBeenCalledWith(0.9)
  expect(sc.preventScreenCaptureAsync).not.toHaveBeenCalled()
  expect(sc.allowScreenCaptureAsync).not.toHaveBeenCalled()
})

test("Android with hideContentAndroid prevents capture under 'oa-privacy'", async () => {
  onPlatform('android')
  await applyPrivacy({ hideContentAndroid: true })
  expect(sc.preventScreenCaptureAsync).toHaveBeenCalledWith('oa-privacy')
  expect(sc.allowScreenCaptureAsync).not.toHaveBeenCalled()
  expect(sc.enableAppSwitcherProtectionAsync).not.toHaveBeenCalled()
})

test("Android without it allows capture under 'oa-privacy' (the default)", async () => {
  onPlatform('android')
  await applyPrivacy({ hideContentAndroid: false })
  expect(sc.allowScreenCaptureAsync).toHaveBeenCalledWith('oa-privacy')
  expect(sc.preventScreenCaptureAsync).not.toHaveBeenCalled()
})

test('a native failure is logged, not thrown', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  clearLogs()
  onPlatform('ios')
  sc.enableAppSwitcherProtectionAsync.mockRejectedValueOnce(new Error('unavailable'))
  await expect(applyPrivacy({ hideContentAndroid: false })).resolves.toBeUndefined()
  expect(getLogLines().filter((l) => l.includes('could not apply privacy'))).toHaveLength(1)
})
