import { log } from '~/core/log/logger'
import type { KeyVault } from './vault'

const TAG = 'lock'

/** React Native's AppStateStatus, restated so this file stays free of react-native. */
export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension'

/** `no-key` is final: the stored key is gone and the session goes to onboarding. */
export type LockState = 'locked' | 'unlocked' | 'no-key'

export interface LockSettings {
  /** The appLock pref. When false, unlock() never prompts and the app never locks. */
  enabled: boolean
  lockAfterMs: number
}

export interface LockDeps {
  /** The wall clock, which the user can set (Settings > Date & Time asks for no passcode). */
  now: () => number
  /**
   * A clock the user cannot set (bind it to `performance.now`). It may stand still while the
   * phone sleeps, so it only adds a reason to lock, never removes one.
   */
  monotonicNow?: () => number
  /** Read at every decision, so a changed pref applies from the next unlock or return. */
  settings: () => LockSettings
  authenticate: () => Promise<boolean>
  /**
   * Whether the phone has a passcode or biometrics to lock with (bind it to `canUseAppLock`).
   * Asked at every unlock while the lock is on, so a passcode removed or set mid-session counts.
   */
  available: () => Promise<boolean>
  vault: KeyVault
}

/**
 * Starts locked. `unlock()` prompts, then reads the key into the vault. It skips the prompt when
 * the lock is off, or on but unusable (no passcode or biometrics, where every prompt would fail).
 * `LockOverlay` calls it on mount, so in both cases the vault opens at start with no prompt.
 * Coming back to `active` after at least `lockAfterMs` in the background locks and drops the key;
 * `inactive` (Face ID, Control Center, a call) never locks. A wall clock that went back while away
 * locks too (it fails closed), and so does `lockAfterMs` on the monotonic clock.
 */
export function createLockController(d: LockDeps) {
  let state: LockState = 'locked'
  let backgroundSince: number | null = null
  let monotonicSince: number | null = null
  let pending: Promise<boolean> | null = null
  /** Secure reads that failed in a row; a cancelled prompt neither counts nor resets it. */
  let readFailures = 0
  const listeners = new Set<(s: LockState) => void>()

  function setState(next: LockState) {
    if (next === state) return
    state = next
    // One failing listener must not keep the others (the overlay among them) from hearing.
    for (const fn of [...listeners]) {
      try {
        fn(next)
      } catch (e) {
        log.error(TAG, 'a lock listener failed', e)
      }
    }
  }

  /** Fails closed: if the device check itself fails, the prompt still runs. */
  async function lockUsable(): Promise<boolean> {
    try {
      return await d.available()
    } catch (e) {
      log.warn(TAG, 'app lock check failed', e)
      return true
    }
  }

  async function attempt(): Promise<boolean> {
    try {
      const prompt = d.settings().enabled && (await lockUsable())
      if (prompt && !(await d.authenticate())) return false
    } catch (e) {
      log.warn(TAG, 'unlock failed', e)
      return false
    }
    let found: boolean
    try {
      found = await d.vault.unlock()
    } catch (e) {
      readFailures++
      log.warn(TAG, 'unlock failed: the stored key could not be read', e)
      return false
    }
    readFailures = 0
    setState(found ? 'unlocked' : 'no-key')
    return found
  }

  return {
    isLocked: (): boolean => state !== 'unlocked',
    /** The stored key failed to read twice in a row: the overlay offers to forget it. */
    keyUnreadable: (): boolean => readFailures >= 2,
    subscribe(fn: (s: LockState) => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    handleAppState(next: AppStateName): void {
      if (next === 'background') {
        if (backgroundSince === null) {
          backgroundSince = d.now()
          monotonicSince = d.monotonicNow?.() ?? null
        }
        return
      }
      if (next !== 'active') return
      const since = backgroundSince
      const monoSince = monotonicSince
      backgroundSince = null
      monotonicSince = null
      if (since === null || state !== 'unlocked') return
      const { enabled, lockAfterMs } = d.settings()
      const away = d.now() - since
      const monoAway = monoSince !== null && d.monotonicNow ? d.monotonicNow() - monoSince : 0
      if (enabled && (away < 0 || away >= lockAfterMs || monoAway >= lockAfterMs)) {
        d.vault.lock()
        setState('locked')
      }
    },
    /** Concurrent calls share one prompt. Resolves true once the vault holds the key. */
    unlock(): Promise<boolean> {
      if (state === 'unlocked') return Promise.resolve(true)
      if (state === 'no-key') return Promise.resolve(false)
      pending ??= attempt().finally(() => {
        pending = null
      })
      return pending
    },
  }
}

export type LockController = ReturnType<typeof createLockController>

/** The optional biometric check before a live write; a prompt that throws refuses the write. */
export async function confirmLiveWrite(d: {
  enabled: boolean
  authenticate: () => Promise<boolean>
}): Promise<boolean> {
  if (!d.enabled) return true
  try {
    return await d.authenticate()
  } catch (e) {
    log.warn(TAG, 'live-write confirmation failed', e)
    return false
  }
}
