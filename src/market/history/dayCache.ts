// The tools' per-trading-day history cache (design 7.8): a tool re-reading past days finds them on
// the phone. An entry is valid for the last completed daily candle it was read with
// (`lastCompletedDay`), not for today's date, so a weekend or a holiday keeps it. It shares the
// profile's AsyncStorage with the watchlists and the chart's records, so it is bounded twice: 200
// entries and 1,500,000 UTF-8 bytes (preflight 20, as MAX_DOM_TOTAL bounds a DOM page's records),
// the oldest dropped first.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import { utf8Length } from '~/dom/gateway/domStorage'
import type { HistoryRow } from '~/market/chart/schemas'

const MAX_HISTORY_DAYS = 200
const MAX_HISTORY_BYTES = 1_500_000

/** The index; each entry is stored under `historyDays:<key>`. */
const NAME = 'historyDays'

const Candle: z.ZodType<HistoryRow> = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
  oi: z.number().optional(),
})
const Entry = z.object({ day: z.string(), rows: z.array(Candle) })
/** Oldest first; `bytes` is the entry's stored name and value. */
const Index = z.array(z.object({ key: z.string(), bytes: z.number() }))
type Index = z.output<typeof Index>

export type HistoryDayCache = {
  /** The rows stored for `key` when they were stored for `day`, else null. */
  get(key: string, day: string): Promise<HistoryRow[] | null>
  /** Stores `rows` as `key`'s for `day`, replacing what `key` held; too large alone, it is not kept. */
  put(key: string, day: string, rows: HistoryRow[]): Promise<void>
}

const entryName = (key: string) => `${NAME}:${key}`

/** What the cache takes in storage: every entry, and the index itself. */
const sizeOf = (index: Index) =>
  index.reduce((n, e) => n + e.bytes, 0) + utf8Length(NAME) + utf8Length(JSON.stringify(index))

export function createHistoryDayCache(storage: ProfileStorage): HistoryDayCache {
  let index: Index | null = null
  let tail: Promise<unknown> = Promise.resolve()

  /** The index, read once; entries it does not list (a write cut short) are deleted. */
  async function load(): Promise<Index> {
    if (index) return index
    const stored = (await storage.getJSON(NAME, Index)) ?? []
    const listed = new Set(stored.map((e) => entryName(e.key)))
    for (const name of await storage.names(`${NAME}:`)) {
      if (!listed.has(name)) await storage.del(name)
    }
    index = stored
    return stored
  }

  async function store(key: string, day: string, rows: HistoryRow[]): Promise<void> {
    const value = { day, rows }
    const bytes = utf8Length(entryName(key)) + utf8Length(JSON.stringify(value))
    if (sizeOf([{ key, bytes }]) > MAX_HISTORY_BYTES) return
    const next = [...(await load()).filter((e) => e.key !== key), { key, bytes }]
    const dropped: Index = []
    while (next.length > MAX_HISTORY_DAYS || sizeOf(next) > MAX_HISTORY_BYTES) {
      const old = next.shift()
      if (old) dropped.push(old)
    }
    // The index first: an entry it lists but storage lacks is a miss, never unbudgeted bytes.
    index = next
    await storage.setJSON(NAME, next)
    await storage.setJSON(entryName(key), value)
    for (const e of dropped) await storage.del(entryName(e.key))
  }

  return {
    async get(key, day) {
      const e = await storage.getJSON(entryName(key), Entry)
      return e && e.day === day ? e.rows : null
    },

    put(key, day, rows) {
      // one put at a time, so concurrent puts never lose each other's index line
      const run = tail.then(() => store(key, day, rows))
      tail = run.catch(() => {})
      return run
    },
  }
}
