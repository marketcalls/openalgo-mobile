import type { z } from 'zod'

/** Minimal async key-value store; the AsyncStorage binding lives in bindings.ts. */
export interface KV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  keys(prefix: string): Promise<string[]>
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
  setJSON(name: string, value: unknown): Promise<void>
  del(name: string): Promise<void>
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
    async setJSON(name, value) {
      await kv.set(prefix + name, JSON.stringify(value))
    },
    async del(name) {
      await kv.del(prefix + name)
    },
    async clearAll({ keepUserContent }) {
      const keep = new Set<string>(keepUserContent ? USER_CONTENT : [])
      for (const key of await kv.keys(prefix)) {
        if (!keep.has(key.slice(prefix.length))) await kv.del(key)
      }
    },
  }
}
