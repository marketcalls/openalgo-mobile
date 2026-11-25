// Instrument metadata, fetched once per symbol per IST day (design 12). A contract the server
// does not list is remembered as 'unknown' for `UNKNOWN_TTL_MS`, so expired contracts add no
// steady requests (RF 1), yet a 404 during the server's daily symbol-table reload (at the first
// broker login) does not stick for the day: it is asked again once its time is up, and every mark
// is dropped when the broker session turns active (`forgetUnknown`). Stored under `instruments`;
// a new day starts empty.
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
/** How long a 404 stands before the contract is asked for again. */
export const UNKNOWN_TTL_MS = 15 * 60_000

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
  /** Each mark with when it was made; a bare key (an older store) has no time and is dropped. */
  unknown: z.array(z.union([z.string(), z.object({ k: z.string(), at: z.number() })])),
})

export type InstrumentCache = {
  get(exchange: string, symbol: string): Promise<InstrumentMeta | 'unknown'>
  /** What is cached today; undefined when nothing is known (or the store is still loading). */
  peek(exchange: string, symbol: string): InstrumentMeta | 'unknown' | undefined
  /** Rows from a search, so the sheet needs no `/symbol` call. */
  putMany(rows: readonly Instrument[]): Promise<void>
  /**
   * Drops every unknown mark, in memory and stored, and any `/symbol` read still out: one sent
   * before (during the server's symbol-table reload) cannot mark its contract unknown again.
   */
  forgetUnknown(): void
}

/** 404 `Symbol X not found in exchange Y` (C1): the contract is not listed. */
export const isSymbolNotFound = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404 && /not found in exchange/i.test(e.serverMessage ?? '')

// validate_symbol_exchange's texts (services/quotes_service.py:14-38, :62).
const REFUSAL =
  /^(?:Symbol '.*' not found for exchange '.*'|Invalid exchange '.*'\. Must be one of:|Missing symbol or exchange in request$)/

/**
 * The server's own refusal of a quote: the symbol is not in its master contract, or the exchange
 * is not one it accepts. multiquotes puts these entries ahead of the broker results
 * (quotes_service.py:272-281). Any other `error` is a broker failure (a timeout, a lapsed token),
 * which says nothing about the contract.
 */
export const isValidationRefusal = (message: string | undefined): boolean =>
  message !== undefined && REFUSAL.test(message)

const keyOf = (ex: string, sym: string) => `${ex}:${sym}`

export function createInstrumentCache(deps: {
  api: Api
  storage: ProfileStorage
  now: () => number
}): InstrumentCache {
  const { api, storage, now } = deps
  // Map order is insertion order, so the first entry is the oldest.
  const items = new Map<string, InstrumentMeta>()
  /** Each unknown contract, with when its 404 came. */
  const unknown = new Map<string, number>()
  const inflight = new Map<string, Promise<InstrumentMeta | 'unknown'>>()
  let day = istDate(now())
  /** Moves on at `forgetUnknown`: a 404 for a read sent before it marks nothing. */
  let epoch = 0
  let writes: Promise<unknown> = Promise.resolve()

  /** Whether a mark stands; one whose time is up is dropped. */
  const isUnknown = (k: string) => {
    const at = unknown.get(k)
    if (at === undefined) return false
    if (now() - at < UNKNOWN_TTL_MS) return true
    unknown.delete(k)
    return false
  }

  const loaded = (async () => {
    try {
      const saved = await storage.getJSON(NAME, StoredSchema)
      if (saved && saved.day === day) {
        // Anything fetched while loading is newer than the store.
        for (const m of saved.items) {
          const k = keyOf(m.exchange, m.symbol)
          if (!items.has(k) && !unknown.has(k)) items.set(k, m)
        }
        for (const u of saved.unknown) {
          if (typeof u === 'string' || items.has(u.k) || unknown.has(u.k)) continue
          unknown.set(u.k, u.at)
        }
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
    const snapshot = {
      day,
      items: [...items.values()],
      unknown: [...unknown].map(([k, at]) => ({ k, at })),
    }
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
    const sentIn = epoch
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
      // sent before the marks were dropped: what it says may be the reload's, so it marks nothing
      if (sentIn !== epoch) return 'unknown'
      items.delete(keyOf(ex, sym))
      unknown.set(keyOf(ex, sym), now())
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
      if (isUnknown(k)) return 'unknown'
      const pending = inflight.get(k)
      if (pending) return pending
      const p = fetch(ex, sym).finally(() => inflight.delete(k))
      inflight.set(k, p)
      return p
    },
    peek(ex, sym) {
      rollover()
      const k = keyOf(ex, sym)
      return items.get(k) ?? (isUnknown(k) ? 'unknown' : undefined)
    },
    async putMany(rows) {
      await loaded
      rollover()
      for (const r of rows) put(toMeta(r))
      await persist()
    },
    forgetUnknown() {
      epoch++
      inflight.clear()
      if (unknown.size === 0) return
      unknown.clear()
      void persist()
    },
  }
}
