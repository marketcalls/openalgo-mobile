// The app's native bindings. Only the app shell imports this file, so the services container
// stays free of native modules (ruling 3): the compat suite passes Node's own instead.
import * as Crypto from 'expo-crypto'
import { asyncStorageKV } from '~/core/config/bindings'
import { usePrefs } from '~/core/config/prefs'
import {
  canUseAppLock,
  expoAuthenticate,
  expoConfirm,
  expoSecureKV,
} from '~/core/credentials/bindings'
import type { AppDeps } from './services'

export const defaultDeps: AppDeps = {
  // A wrapper, so fetch is never called unbound.
  fetch: (input, init) => fetch(input, init),
  WebSocketImpl: WebSocket,
  secureKV: expoSecureKV,
  kv: asyncStorageKV,
  now: () => Date.now(),
  uuid: () => Crypto.randomUUID(),
  allowDevHosts: __DEV__,
  lock: {
    // Read at every decision, so a changed pref applies from the next unlock or return.
    settings: () => {
      const { appLock, lockAfterMs } = usePrefs.getState()
      return { enabled: appLock, lockAfterMs }
    },
    authenticate: expoAuthenticate,
    available: canUseAppLock,
    confirm: expoConfirm,
    // Not moved by a date change, so a clock set back cannot skip the lock.
    monotonicNow: () => performance.now(),
  },
}
