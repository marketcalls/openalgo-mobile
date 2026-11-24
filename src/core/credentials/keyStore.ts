import type { KV } from '~/core/config/storage'

/** The secure store's surface; the expo-secure-store binding lives in bindings.ts. */
export interface SecureKV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
}

/**
 * The API key in the secure store under `oa.<pid>.apikey`, plus a non-secret `oa.<pid>.hasKey`
 * marker in `kv`, so boot can tell whether a key exists without reading it before unlock.
 */
export function createKeyStore(secureKV: SecureKV, kv: KV, pid: string) {
  const keyName = `oa.${pid}.apikey`
  const markerName = `oa.${pid}.hasKey`
  return {
    load: (): Promise<string | null> => secureKV.get(keyName),
    async save(key: string): Promise<void> {
      await secureKV.set(keyName, key)
      await kv.set(markerName, '1')
    },
    /** Deletes the key first, so a failure never leaves a key without its marker. */
    async clear(): Promise<void> {
      await secureKV.del(keyName)
      await kv.del(markerName)
    },
    /** Reads only the marker; never touches the secure store. */
    async hasKey(): Promise<boolean> {
      return (await kv.get(markerName)) !== null
    },
  }
}

export type KeyStore = ReturnType<typeof createKeyStore>
