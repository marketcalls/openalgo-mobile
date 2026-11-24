import * as LocalAuthentication from 'expo-local-authentication'
import * as SecureStore from 'expo-secure-store'
import type { SecureKV } from './keyStore'

/** Native bindings for credentials: the only file here that touches expo modules. */

const THIS_DEVICE: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

/** Keychain this-device-only on iOS (kept out of backups); Keystore-backed on Android. */
export const expoSecureKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, THIS_DEVICE),
  set: (key, value) => SecureStore.setItemAsync(key, value, THIS_DEVICE),
  del: (key) => SecureStore.deleteItemAsync(key, THIS_DEVICE),
}

/** Biometrics, falling back to the device passcode. */
export async function expoAuthenticate(): Promise<boolean> {
  const r = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock OpenAlgo',
    disableDeviceFallback: false,
  })
  return r.success
}

/** False when the device has no passcode or biometrics, so there is nothing to lock with. */
export async function canUseAppLock(): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync()
  return level !== LocalAuthentication.SecurityLevel.NONE
}
