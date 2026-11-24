// Instrument metadata, fetched once per symbol per IST day (design 12). A contract the server
// does not list is remembered as 'unknown' for the day, so expired contracts add no steady
// requests (RF 1). Stored under `instruments`; a new day starts empty.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import type { Api } from '~/core/http/api'
import { ApiError } from '~/core/http/errors'
import type { Instrument } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { istDate } from '~/core/realtime/marketHours'
import { type InstrumentMeta, SymbolSchema, toMeta } from './meta'

const TAG = 'instruments'
const NAME = 'instruments'
const MAX_ITEMS = 2000

const StoredSchema = z.object({
  day: z.string(),
  items: z.array(
    z.object({
      exchange: z.string(),
      symbol: z.string(),
      name: z.string(),
      lotsize: z.number(),
      tick: z.number(),
      freezeQty: z.number(),
      instrumenttype: z.string(),
      expiry: z.string().nullable(),
      strike: z.number().nullable(),
      quoteOnly: z.boolean(),
      lots: z.boolean(),
    }),
  ),
  unknown: z.array(z.string()),
})

export type InstrumentCache = {
  get(exchange: string, symbol: string): Promise<InstrumentMeta | 'unknown'>
  /** What is cached today; undefined when nothing is known (or the store is still loading). */
  peek(exchange: string, symbol: string): InstrumentMeta | 'unknown' | undefined
  /** Rows from a search, so the sheet needs no `/symbol` call. */
  putMany(rows: readonly Instrument[]): Promise<void>
}

/** 404 `Symbol X not found in exchange Y` (C1): the contract is not listed. */
export const isSymbolNotFound = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404 && /not found in exchange/i.test(e.serverMessage ?? '')

const keyOf = (ex: string, sym: string) => `${ex}:${sym}`

export function createInstrumentCache(deps: {
  api: Api
  storage: ProfileStorage
  now: () => number
}): InstrumentCache {
  const { api, storage, now } = deps
  // Map order is insertion order, so the first entry is the oldest.
  const items = new Map<string, InstrumentMeta>()
  const unknown = new Set<string>()
  const inflight = new Map<string, Promise<InstrumentMeta | 'unknown'>>()
  let day = istDate(now())
  let writes: Promise<unknown> = Promise.resolve()

  const loaded = (async () => {
    try {
      const saved = await storage.getJSON(NAME, StoredSchema)
      if (saved && saved.day === day) {
        // Anything fetched while loading is newer than the store.
        for (const m of saved.items) {
          const k = keyOf(m.exchange, m.symbol)
          if (!items.has(k) && !unknown.has(k)) items.set(k, m)
        }
        for (const k of saved.unknown) if (!items.has(k)) unknown.add(k)
      }
    } catch (e) {
      log.warn(TAG, 'could not read the instrument cache', e)
    }
  })()

  /** A new IST day empties the cache. */
  const rollover = () => {
    const today = istDate(now())
    if (today === day) return
    day = today
    items.clear()
    unknown.clear()
  }

  const persist = () => {
    const snapshot = { day, items: [...items.values()], unknown: [...unknown] }
    writes = writes
      .then(() => storage.setJSON(NAME, snapshot))
      .catch((e) => log.warn(TAG, 'could not store the instrument cache', e))
    return writes
  }

  const put = (m: InstrumentMeta) => {
    const k = keyOf(m.exchange, m.symbol)
    unknown.delete(k)
    items.delete(k)
    items.set(k, m)
    while (items.size > MAX_ITEMS) {
      const oldest = items.keys().next().value
      if (oldest === undefined) break
      items.delete(oldest)
    }
  }

  const fetch = async (ex: string, sym: string): Promise<InstrumentMeta | 'unknown'> => {
    try {
      const row = await api.call('symbol', { symbol: sym, exchange: ex }, SymbolSchema)
      rollover()
      const m = toMeta(row)
      // Keyed by what was asked: the server may answer in another case.
      put({ ...m, exchange: ex, symbol: sym })
      await persist()
      return items.get(keyOf(ex, sym)) ?? m
    } catch (e) {
      if (!isSymbolNotFound(e)) throw e
      rollover()
      items.delete(keyOf(ex, sym))
      unknown.add(keyOf(ex, sym))
      await persist()
      return 'unknown'
    }
  }

  return {
    async get(ex, sym) {
      await loaded
      rollover()
      const k = keyOf(ex, sym)
      const hit = items.get(k)
      if (hit) return hit
      if (unknown.has(k)) return 'unknown'
      const pending = inflight.get(k)
      if (pending) return pending
      const p = fetch(ex, sym).finally(() => inflight.delete(k))
      inflight.set(k, p)
      return p
    },
    peek(ex, sym) {
      rollover()
      const k = keyOf(ex, sym)
      return items.get(k) ?? (unknown.has(k) ? 'unknown' : undefined)
    },
    async putMany(rows) {
      await loaded
      rollover()
      for (const r of rows) put(toMeta(r))
      await persist()
    },
  }
}
