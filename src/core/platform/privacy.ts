import * as ScreenCapture from 'expo-screen-capture'
import { Platform } from 'react-native'
import { log } from '~/core/log/logger'

/** Separate from useSecureScreen's 'oa-key', so leaving the key screen keeps this setting. */
const PRIVACY_TAG = 'oa-privacy'

/**
 * Hides app content in the app switcher. iOS blurs it. Android can only do that with
 * FLAG_SECURE, which also blocks screenshots, so it follows `hideContentAndroid` (off by default).
 */
export async function applyPrivacy({
  hideContentAndroid,
}: {
  hideContentAndroid: boolean
}): Promise<void> {
  try {
    if (Platform.OS === 'ios') {
      await ScreenCapture.enableAppSwitcherProtectionAsync(0.9)
    } else if (Platform.OS === 'android') {
      await (hideContentAndroid
        ? ScreenCapture.preventScreenCaptureAsync(PRIVACY_TAG)
        : ScreenCapture.allowScreenCaptureAsync(PRIVACY_TAG))
    }
  } catch (e) {
    log.warn('privacy', 'could not apply privacy settings', e)
  }
}
