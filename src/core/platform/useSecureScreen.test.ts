import { renderHook } from '@testing-library/react-native'
import { usePreventScreenCapture } from 'expo-screen-capture'
import { useSecureScreen } from './useSecureScreen'

jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }))

test("useSecureScreen blocks capture under the 'oa-key' tag", async () => {
  await renderHook(() => useSecureScreen())
  expect(usePreventScreenCapture).toHaveBeenCalledWith('oa-key')
})
