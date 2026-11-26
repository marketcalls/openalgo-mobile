// A DOM page's storage (design 7.9.5), kept on the phone: the page's `AsyncStorageLike` calls
// arrive as DomStorageMsg and are answered from ProfileStorage. Each stored name holds one
// record, the widget's full key and its value, so the app can list a key's records by prefix
// and the backup can carry them. Writes to one name are serialized; a value is bounded.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import type { DomReply, DomStorageMsg } from '~/dom/bridge/protocol'

export type DomStoreRecord = { k: string; v: string }

export const MAX_DOM_VALUE = 1_000_000
/** The longest widget key the phone stores. */
export const MAX_DOM_KEY = 256

const RecordSchema = z.object({ k: z.string(), v: z.string() })

const NO_CONTENT: DomReply = { status: 204, body: null }
const FORBIDDEN: DomReply = { status: 403, body: null }
const TOO_LARGE: DomReply = { status: 413, body: null }

/** Every record stored under the names that start with `area`, in name order. */
export async function readDomRecords(
  storage: ProfileStorage,
  area: string,
): Promise<DomStoreRecord[]> {
  const out: DomStoreRecord[] = []
  for (const name of (await storage.names(area)).sort()) {
    const r = await storage.getJSON(name, RecordSchema)
    if (r) out.push(r)
  }
  return out
}

export function createDomStorageHandler(o: {
  storage: ProfileStorage
  /** The areas (name prefixes) the page's records live under. */
  areas: readonly string[]
  /** The stored name for a widget key, or null for a key the page may not use. */
  nameOf: (key: string) => string | null
}): (m: DomStorageMsg) => Promise<DomReply> {
  const { storage, areas, nameOf } = o
  const tails = new Map<string, Promise<unknown>>()

  /** Runs `fn` after everything queued for `name`; a failure does not stop the queue. */
  const queued = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    tails.set(name, tail)
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name)
    })
    return run
  }

  const keyName = (key: string) => (key.length > MAX_DOM_KEY ? null : nameOf(key))

  return async (m) => {
    switch (m.op) {
      case 'entries': {
        const rows: [string, string][] = []
        for (const area of areas) {
          for (const r of await readDomRecords(storage, area)) {
            if (r.k.startsWith(m.prefix)) rows.push([r.k, r.v])
          }
        }
        return { status: 200, body: rows }
      }
      case 'get': {
        const name = keyName(m.key)
        if (name === null) return FORBIDDEN
        const r = await queued(name, () => storage.getJSON(name, RecordSchema))
        return { status: 200, body: r && r.k === m.key ? r.v : null }
      }
      case 'set': {
        const name = keyName(m.key)
        if (name === null) return FORBIDDEN
        if (m.value.length > MAX_DOM_VALUE) return TOO_LARGE
        await queued(name, () => storage.setJSON(name, { k: m.key, v: m.value }))
        return NO_CONTENT
      }
      case 'remove': {
        const name = keyName(m.key)
        if (name === null) return FORBIDDEN
        await queued(name, () => storage.del(name))
        return NO_CONTENT
      }
    }
  }
}

/** Stores `records` under the names `nameOf` gives, replacing those with the same key; the count stored. */
export async function writeDomRecords(
  storage: ProfileStorage,
  records: readonly DomStoreRecord[],
  nameOf: (key: string) => string | null,
): Promise<number> {
  let n = 0
  for (const r of records) {
    const name = r.k.length > MAX_DOM_KEY || r.v.length > MAX_DOM_VALUE ? null : nameOf(r.k)
    if (name === null) continue
    await storage.setJSON(name, r)
    n++
  }
  return n
}
