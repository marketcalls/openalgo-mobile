import type { KeyStore } from './keyStore'

/** Thrown by `vault.get()` while the app is locked: the key is not in memory. */
export class LockedError extends Error {
  constructor() {
    super('The app is locked')
    this.name = 'LockedError'
  }
}

/** Holds the API key in memory only between unlock and lock. */
export function createKeyVault(store: KeyStore) {
  let key: string | null = null
  return {
    /**
     * Reads the key into memory. With no stored key it drops the marker and returns false, and
     * the session goes to onboarding. A failed read rejects and leaves the vault locked.
     */
    async unlock(): Promise<boolean> {
      const stored = await store.load()
      if (stored === null) {
        await store.clear()
        return false
      }
      key = stored
      return true
    },
    lock(): void {
      key = null
    },
    get(): string {
      if (key === null) throw new LockedError()
      return key
    },
    has(): boolean {
      return key !== null
    },
    /** Saves through the store (marker included), then holds the new key. */
    async replace(next: string): Promise<void> {
      await store.save(next)
      key = next
    },
    /** Sign-out: drops the key from memory and deletes it and its marker. */
    async wipe(): Promise<void> {
      key = null
      await store.clear()
    },
  }
}

export type KeyVault = ReturnType<typeof createKeyVault>
