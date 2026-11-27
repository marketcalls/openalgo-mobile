// OI Profile's previous-day OI cache (design 7.8, "a day cache makes refreshes 2 calls"): each
// option leg's previous-day OI (its daily candles' `data[-2]` OI, oi_profile_service.py:175-177)
// with the IST date of that candle, so a refresh reads only the legs whose own `data[-2]` date
// has moved on. It shares the profile's AsyncStorage, so it is bounded: one stored list an
// exchange (`prevOi:<EXCHANGE>`), at most 3,000 symbols, only the two newest days (the key is the
// day before yesterday before the open, yesterday after it). Every cache over one ProfileStorage
// shares one copy and one write queue: a tool screen closed while its last write is out and the
// one opened next never lose each other's legs.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import { istDate } from '~/core/realtime/marketHours'

const NAME = 'prevOi'
const MAX_SYMBOLS = 3_000
const KEPT_DAYS = 2

/** [symbol, IST date of its data[-2], its OI], the oldest put first. */
const Stored = z.array(z.tuple([z.string(), z.string(), z.number()]))

type Entry = { day: string; prevOi: number }

export type PrevOiRow = { symbol: string; day: string; prevOi: number }

export type PrevOiCache = {
  /** The leg's previous-day OI when it was stored for `day` (its data[-2] date), else null. */
  get(exchange: string, symbol: string, day: string): Promise<number | null>
  /** Stores each row as its symbol's, replacing what the symbol held. */
  put(exchange: string, rows: readonly PrevOiRow[]): Promise<void>
}

/**
 * The day an OI Profile load's legs are cached under: the second-newest IST date of the
 * future's intraday candles (epoch seconds), which is the date of the legs' daily `data[-2]`:
 * before the open the newest is the last session, after it today. null with fewer than 2 dates.
 */
export function oiDayKey(rawFutCandles: readonly { time: number }[]): string | null {
  const days = [...new Set(rawFutCandles.map((c) => istDate(c.time * 1000)))].sort()
  return days.length >= 2 ? (days[days.length - 2] as string) : null
}

type Shared = {
  /** Each exchange's entries, read once, in put order. */
  lists: Map<string, Promise<Map<string, Entry>>>
  /** The rows put and not yet written, by exchange. */
  queued: Map<string, Map<string, Entry>>
  tail: Promise<unknown>
}

const shared = new WeakMap<ProfileStorage, Shared>()

const nameOf = (exchange: string) => `${NAME}:${exchange}`

/** Drops what is older than the two newest days, then the oldest put past MAX_SYMBOLS. */
function bounded(list: Map<string, Entry>): Map<string, Entry> {
  const newest = new Set(
    [...new Set([...list.values()].map((e) => e.day))].sort().reverse().slice(0, KEPT_DAYS),
  )
  const kept = [...list].filter(([, e]) => newest.has(e.day))
  return new Map(kept.slice(Math.max(0, kept.length - MAX_SYMBOLS)))
}

export function createPrevOiCache(storage: ProfileStorage): PrevOiCache {
  let s = shared.get(storage)
  if (!s) {
    s = { lists: new Map(), queued: new Map(), tail: Promise.resolve() }
    shared.set(storage, s)
  }
  const state = s

  function list(exchange: string): Promise<Map<string, Entry>> {
    const known = state.lists.get(exchange)
    if (known) return known
    const read = storage
      .getJSON(nameOf(exchange), Stored)
      .then(
        (rows) => new Map((rows ?? []).map(([symbol, day, prevOi]) => [symbol, { day, prevOi }])),
      )
    // a failed read is tried again by the next use
    read.catch(() => {
      if (state.lists.get(exchange) === read) state.lists.delete(exchange)
    })
    state.lists.set(exchange, read)
    return read
  }

  /** Writes every exchange's queued rows: those put while a write was out go in one. */
  async function drain(): Promise<void> {
    for (const [exchange, rows] of [...state.queued]) {
      state.queued.delete(exchange)
      const current = await list(exchange)
      const next = new Map(current)
      for (const [symbol, e] of rows) {
        next.delete(symbol)
        next.set(symbol, e)
      }
      const kept = bounded(next)
      state.lists.set(exchange, Promise.resolve(kept))
      await storage.setJSON(
        nameOf(exchange),
        [...kept].map(([symbol, e]) => [symbol, e.day, e.prevOi]),
      )
    }
  }

  return {
    async get(exchange, symbol, day) {
      const e = (await list(exchange.toUpperCase())).get(symbol)
      return e && e.day === day ? e.prevOi : null
    },

    put(exchange, rows) {
      const ex = exchange.toUpperCase()
      const q = state.queued.get(ex) ?? new Map<string, Entry>()
      for (const r of rows) {
        q.delete(r.symbol)
        q.set(r.symbol, { day: r.day, prevOi: r.prevOi })
      }
      state.queued.set(ex, q)
      // one write at a time; a drain that finds nothing queued writes nothing
      const run = state.tail.then(drain)
      state.tail = run.catch(() => {})
      return run
    },
  }
}
