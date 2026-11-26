// The widget's storage, kept by native in the app's profile storage (design 7.9.5): an
// AsyncStorageLike whose every call crosses the bridge. A refused or malformed reply rejects, so
// the widget keeps the change and tries again. The journal, the page's localStorage when it works,
// holds writes still pending when the page goes away.
import type { AsyncStorageLike, StorageLike } from 'openalgo-charts/widget'
import type { DomStorageMsg, JSONValue } from '~/dom/bridge/protocol'
import type { DomClient } from './client'

const PROBE_KEY = 'oa-dom:probe'

const isEntries = (x: JSONValue): x is [string, string][] =>
  Array.isArray(x) &&
  x.every(
    (e) =>
      Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string',
  )

export function createBridgedStorage(
  client: DomClient,
  journal: StorageLike | null = null,
): AsyncStorageLike {
  async function ask(m: DomStorageMsg): Promise<JSONValue> {
    const r = await client.call(m)
    if (r.status < 200 || r.status > 299) {
      throw new Error(`openalgo-mobile: storage ${m.op} refused (${r.status})`)
    }
    return r.body
  }
  const malformed = (op: DomStorageMsg['op']) =>
    new Error(`openalgo-mobile: storage ${op} gave a malformed reply`)

  return {
    journal,
    async entries(prefix) {
      const body = await ask({ v: 1, kind: 'storage', op: 'entries', prefix })
      if (!isEntries(body)) throw malformed('entries')
      return body
    },
    async getItem(key) {
      const body = await ask({ v: 1, kind: 'storage', op: 'get', key })
      if (body !== null && typeof body !== 'string') throw malformed('get')
      return body
    },
    async setItem(key, value) {
      await ask({ v: 1, kind: 'storage', op: 'set', key, value })
    },
    async removeItem(key) {
      await ask({ v: 1, kind: 'storage', op: 'remove', key })
    },
  }
}

/** The page's localStorage if it exists and takes a write, else null. A page may have none (an
 *  opaque file:// origin), or one that throws on access or on write. */
export function safeLocalStorage(): StorageLike | null {
  try {
    const ls: StorageLike | undefined = globalThis.localStorage
    if (ls == null || typeof ls.getItem !== 'function') return null
    ls.setItem(PROBE_KEY, '1')
    ls.removeItem(PROBE_KEY)
    return ls
  } catch {
    return null
  }
}
