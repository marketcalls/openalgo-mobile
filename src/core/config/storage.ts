import type { z } from 'zod'

/** Minimal async key-value store; the AsyncStorage binding lives in bindings.ts. */
export interface KV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
  /** One round trip for many keys (null where absent); optional, callers fall back to `get`. */
  getMany?(keys: string[]): Promise<(string | null)[]>
}

/** Names that hold the user's own content and survive a "clear data" that keeps them. */
export const USER_CONTENT = [
  'watchlists',
  'strategyPortfolio',
  'chartDrawings',
  'chartPrefs',
] as const

export interface ProfileStorage {
  getJSON<S extends z.ZodType>(name: string, schema: S): Promise<z.output<S> | null>
  /** Every name's value in one round trip when the store can; absent or unparsable gives null. */
  getManyJSON?<S extends z.ZodType>(names: string[], schema: S): Promise<(z.output<S> | null)[]>
  setJSON(name: string, value: unknown): Promise<void>
  del(name: string): Promise<void>
  /** The stored names that start with `prefix` (the profile's own, without the `oa.<pid>.`). */
  names(prefix: string): Promise<string[]>
  clearAll(o: { keepUserContent: boolean }): Promise<void>
}

export function profileStorage(kv: KV, pid: string): ProfileStorage {
  const prefix = `oa.${pid}.`
  return {
    async getJSON(name, schema) {
      const raw = await kv.get(prefix + name)
      if (raw === null) return null
      try {
        const r = schema.safeParse(JSON.parse(raw))
        return r.success ? r.data : null
      } catch {
        return null
      }
    },
    ...(kv.getMany
      ? {
          async getManyJSON<S extends z.ZodType>(names: string[], schema: S) {
            const raws = await (kv.getMany as NonNullable<KV['getMany']>)(
              names.map((n) => prefix + n),
            )
            return raws.map((raw) => {
              if (raw === null) return null
              try {
                const r = schema.safeParse(JSON.parse(raw))
                return r.success ? (r.data as z.output<S>) : null
              } catch {
                return null
              }
            })
          },
        }
      : {}),
    async setJSON(name, value) {
      await kv.set(prefix + name, JSON.stringify(value))
    },
    async del(name) {
      await kv.del(prefix + name)
    },
    async names(p) {
      return (await kv.keys(prefix + p)).map((key) => key.slice(prefix.length))
    },
    async clearAll({ keepUserContent }) {
      // A user-content name also owns its `<name>:*` records (chart drawings per instrument).
      const kept = (name: string) =>
        keepUserContent && USER_CONTENT.some((n) => name === n || name.startsWith(`${n}:`))
      for (const key of await kv.keys(prefix)) {
        if (!kept(key.slice(prefix.length))) await kv.del(key)
      }
    },
  }
}
