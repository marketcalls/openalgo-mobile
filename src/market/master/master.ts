// The symbol master (design 7.8): each F&O exchange's instruments CSV, downloaded lazily at most
// once per IST day (design 7.2: a keyed GET) and kept in SQLite, so the tools' pickers list what the
// server lists. At the first broker login of the day the server deletes its symbol table and fills
// it again (e.g. broker/zerodha/database/master_contract_db.py), and meanwhile the CSV is empty,
// short or an error: such a download is never stored, the earlier master (or the web's defaults)
// answers, and the next try waits 15 minutes (RF 2).
import { z } from 'zod'
import type { KeyedApi } from '~/core/http/api'
import { log } from '~/core/log/logger'
import { istDate } from '~/core/realtime/marketHours'
import { expiryInstantMs } from '~/market/options/expiry'
import { DEFAULT_UNDERLYINGS } from '~/market/tools/registry'
import { parseInstrumentsCsv } from './csv'
import { isOptionRow, type MasterDb, type MasterRow } from './db'
import { createMemoryMasterDb } from './memoryDb'

/** The exchanges the master covers: the tools' F&O exchanges (useSupportedExchanges.ts:11-17). */
export const MASTER_EXCHANGES = ['NFO', 'BFO', 'MCX', 'CDS', 'CRYPTO'] as const
/** Fewer option rows than this is a symbol table still being filled, not a master. */
export const MIN_OPTION_ROWS = 50
/** How long a download that was not stored holds back the next one. */
export const RETRY_AFTER_MS = 900_000

export type MasterState = 'today' | 'earlier' | 'none'

export type SymbolMaster = {
  /**
   * Downloads the exchange's master unless today's is stored, one download at a time per
   * exchange: 'today' once it is stored, else what is stored ('earlier' or 'none'). Never rejects.
   */
  ensure(exchange: string): Promise<MasterState>
  /**
   * The options underlyings now, never waiting for a download: today's master, else an earlier
   * one, else the web's defaults; a download starts in the background when it is not today's.
   */
  underlyingsNow(
    exchange: string,
  ): Promise<{ list: string[]; source: 'today' | 'earlier' | 'defaults' }>
  /** Whether the master lists options on `underlying`; null while no master is stored. */
  hasOptions(exchange: string, underlying: string): Promise<boolean | null>
  /**
   * The strikes the master lists for `underlying`'s `type` options at `ddmmmyy`, distinct and
   * ascending (option_symbol_service.py get_available_strikes); null while no master is stored.
   */
  strikes(
    exchange: string,
    underlying: string,
    ddmmmyy: string,
    type: 'CE' | 'PE',
  ): Promise<number[] | null>
  /**
   * The futures (symbol ends FUT) in the CSV's order, without those past their expiry instant
   * (an earlier day's master still lists them); null while no master is stored.
   */
  futures(exchange: string): Promise<MasterRow[] | null>
  /**
   * custom_straddle.py get_lotsize: the lot size of the first row whose symbol is LIKE `prefix%`,
   * above 0; null when none is; undefined while no master is stored.
   */
  lotSizeLike(exchange: string, prefix: string): Promise<number | null | undefined>
  /** Forgets this profile's masters (sign-out); a download in flight is dropped. */
  clear(): Promise<void>
}

const TAG = 'master'
/** A keyed GET's CSV body: the client hands the text over unparsed. */
const CsvText = z.string()

const isMasterExchange = (ex: string) => (MASTER_EXCHANGES as readonly string[]).includes(ex)

export function createSymbolMaster(d: {
  api: Pick<KeyedApi, 'get'>
  db: Promise<MasterDb>
  pid: string
  now: () => number
}): SymbolMaster {
  const { api, pid, now } = d
  const db = d.db.catch((e: unknown) => {
    log.warn(TAG, 'the symbol master database did not open; it is kept in memory this session', e)
    return createMemoryMasterDb()
  })
  const running = new Map<string, Promise<MasterState>>()
  /** Aborts each download in flight, for `clear`. */
  const aborts = new Set<AbortController>()
  const retryAt = new Map<string, number>()
  /** Moves on at each `clear`: a download started before it stores nothing. */
  let generation = 0
  /** The last `clear`; an ensure begun meanwhile waits for it, so it never writes under it. */
  let clearing: Promise<void> = Promise.resolve()

  /** The database when a master of `exchange` is stored, else null. Asking never downloads one. */
  async function withMaster(exchange: string): Promise<MasterDb | null> {
    const store = await db
    return (await store.loaded(pid, exchange)) ? store : null
  }

  async function stored(exchange: string): Promise<MasterState> {
    const l = await (await db).loaded(pid, exchange)
    if (!l) return 'none'
    return l.day === istDate(now()) ? 'today' : 'earlier'
  }

  /** `started`: the generation the ensure began in. */
  async function download(exchange: string, started: number): Promise<MasterState> {
    const store = await db
    const day = istDate(now())
    const ctrl = new AbortController()
    aborts.add(ctrl)
    try {
      const text = await api.get('instruments', { exchange, format: 'csv' }, CsvText, {
        withKey: true,
        signal: ctrl.signal,
      })
      await store.write(pid, exchange, day, async (add) => {
        let options = 0
        const rows = await parseInstrumentsCsv(text, async (batch) => {
          if (generation !== started) throw new Error('cleared')
          for (const r of batch) if (isOptionRow(r)) options++
          await add(batch)
        })
        // the server's symbol table is still filling: not a whole master
        if (options < MIN_OPTION_ROWS) throw new Error(`${options} option rows`)
        return rows
      })
      retryAt.delete(exchange)
      return 'today'
    } catch (e) {
      if (generation !== started) return 'none'
      retryAt.set(exchange, now() + RETRY_AFTER_MS)
      const why = e instanceof Error ? e.message : String(e)
      log.warn(TAG, `${exchange}: the instruments CSV was not stored (${why}); next try in 15 min`)
      return stored(exchange)
    } finally {
      aborts.delete(ctrl)
    }
  }

  async function check(exchange: string, started: number): Promise<MasterState> {
    if (!isMasterExchange(exchange)) return 'none'
    await clearing
    const state = await stored(exchange)
    if (generation !== started) return 'none'
    if (state === 'today' || (retryAt.get(exchange) ?? 0) > now()) return state
    return download(exchange, started)
  }

  function ensure(exchange: string): Promise<MasterState> {
    const out = running.get(exchange)
    if (out) return out
    const p = check(exchange, generation)
      .catch((e: unknown) => {
        log.warn(TAG, `${exchange}: the symbol master could not be read`, e)
        return 'none' as const
      })
      .finally(() => running.delete(exchange))
    running.set(exchange, p)
    return p
  }

  return {
    ensure,

    async underlyingsNow(exchange) {
      const store = await db
      const l = isMasterExchange(exchange) ? await store.loaded(pid, exchange) : null
      const today = l?.day === istDate(now())
      if (isMasterExchange(exchange) && !today) void ensure(exchange)
      if (l) {
        return {
          list: await store.optionUnderlyings(pid, exchange),
          source: today ? 'today' : 'earlier',
        }
      }
      return { list: [...(DEFAULT_UNDERLYINGS[exchange] ?? [])], source: 'defaults' }
    },

    async hasOptions(exchange, underlying) {
      const store = await withMaster(exchange)
      return store ? store.hasOptions(pid, exchange, underlying) : null
    },

    async strikes(exchange, underlying, ddmmmyy, type) {
      const store = await withMaster(exchange)
      return store ? store.strikes(pid, exchange, underlying, ddmmmyy, type) : null
    },

    async futures(exchange) {
      const store = await withMaster(exchange)
      if (!store) return null
      const t = now()
      // a row whose expiry does not parse (a perpetual's) has no instant to pass
      return (await store.futures(pid, exchange)).filter(
        (r) => (expiryInstantMs(r.expiry, exchange) ?? t) >= t,
      )
    },

    async lotSizeLike(exchange, prefix) {
      const store = await withMaster(exchange)
      return store ? store.lotSizeLike(pid, exchange, prefix) : undefined
    },

    clear() {
      generation++
      for (const c of aborts) c.abort()
      const before = [...running.values()]
      const done = (async () => {
        await Promise.all(before)
        retryAt.clear()
        await (await db).clear(pid)
      })()
      clearing = done.catch(() => {})
      return done
    },
  }
}
