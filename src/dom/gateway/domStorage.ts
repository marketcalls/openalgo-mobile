// A DOM page's storage (design 7.9.5), kept on the phone: the page's `AsyncStorageLike` calls
// arrive as DomStorageMsg and are answered from ProfileStorage. Each stored name holds one
// record, the widget's full key and its value, so the app can list a key's records by prefix
// and the backup can carry them. Writes to one name are serialized; a value is bounded.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import type { DomReply, DomStorageMsg } from '~/dom/bridge/protocol'
import { MAX_KEY, MAX_VALUE } from '~/dom/bridge/schemas'

export type DomStoreRecord = { k: string; v: string }

export const MAX_DOM_VALUE = MAX_VALUE
/** All the records of one handler together, in UTF-8 bytes of key and value: what a backup can carry. */
export const MAX_DOM_TOTAL = 1_500_000
/** Records per area; the backup reads no more per section. */
export const MAX_DOM_RECORDS = 2000
/** The longest widget key the phone stores. */
export const MAX_DOM_KEY = MAX_KEY

/** The UTF-8 size of `s`, without a TextEncoder (the JS engine may not have one). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

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

  // Sets are checked against the budget one at a time, so two cannot both fit by racing.
  let budgetTail: Promise<unknown> = Promise.resolve()
  const inBudget = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = budgetTail.then(fn, fn)
    budgetTail = run.catch(() => {})
    return run
  }

  /** True when storing `k`/`v` (replacing any record of that name) stays within the budget. */
  const fits = async (name: string, k: string, v: string): Promise<boolean> => {
    let total = utf8Length(k) + utf8Length(v)
    let inArea = 1
    const area = areas.find((a) => name.startsWith(a))
    for (const a of areas) {
      for (const n of await storage.names(a)) {
        if (n === name) continue
        const r = await storage.getJSON(n, RecordSchema)
        if (!r) continue
        total += utf8Length(r.k) + utf8Length(r.v)
        if (area !== undefined && n.startsWith(area)) inArea++
      }
    }
    return total <= MAX_DOM_TOTAL && inArea <= MAX_DOM_RECORDS
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
        return inBudget(async () => {
          if (!(await fits(name, m.key, m.value))) return TOO_LARGE
          await queued(name, () => storage.setJSON(name, { k: m.key, v: m.value }))
          return NO_CONTENT
        })
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
