import type { KV } from '~/core/config/storage'

/** In-memory KV for tests; `data` is exposed so tests can seed and inspect it. */
export function memoryKV(seed: Record<string, string> = {}): KV & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async del(key) {
      data.delete(key)
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}
