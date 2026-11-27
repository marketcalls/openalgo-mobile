// The device-local Strategy Portfolio (design 7.8): the server keeps it in a SQLite table, the
// phone in one ProfileStorage value, so it is kept per profile and travels in the backup. A
// write is read, changed and written back in one turn of a queue, so two saves at once both land.
// Ids count up and are never reused. A leg is stored as given, less any key named like the API
// key (any depth): the backup refuses a file that carries one.
import { z } from 'zod'
import type { ProfileStorage } from '~/core/config/storage'
import { MAX_DOM_TOTAL, utf8Length } from '~/dom/gateway/domStorage'
import {
  MAX_STRATEGIES,
  type PortfolioEntry,
  PortfolioEntrySchema,
  type PortfolioSavePayload,
  stripKeys,
  type Watchlist,
} from './schemas'

export { MAX_STRATEGIES, WATCHLISTS } from './schemas'

const NAME = 'strategyPortfolio'
export const FULL_COPY = "The phone's strategy list is full."
export const LIMIT_COPY = `The phone keeps at most ${MAX_STRATEGIES} strategies.`

/** A save the phone refuses: the list is at its count or its byte bound. */
export class StrategyLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrategyLimitError'
  }
}

export type StrategyStore = {
  /** Newest `updated_at` first. */
  list(watchlist?: Watchlist): Promise<PortfolioEntry[]>
  get(id: number): Promise<PortfolioEntry | null>
  /** A new entry, or `id` replaced; null when `id` is not found. Throws StrategyLimitError. */
  save(p: PortfolioSavePayload, id?: number): Promise<PortfolioEntry | null>
  remove(id: number): Promise<boolean>
  all(): Promise<PortfolioEntry[]>
  /** Adds the entries not present (same name, watchlist and created_at), under new ids; the count added. */
  merge(entries: readonly PortfolioEntry[]): Promise<number>
  clear(): Promise<void>
}

type Doc = { next: number; items: PortfolioEntry[] }

/** An entry that no longer parses is dropped; the rest stay. */
const DocSchema = z
  .object({ next: z.int().min(1), items: z.array(z.unknown()) })
  .transform((d): Doc => {
    const items: PortfolioEntry[] = []
    for (const raw of d.items) {
      const r = PortfolioEntrySchema.safeParse(raw)
      if (r.success) items.push(r.data)
    }
    return { next: d.next, items }
  })

const byUpdated = (a: PortfolioEntry, b: PortfolioEntry) =>
  (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || b.id - a.id

const sameStrategy = (a: PortfolioEntry, b: PortfolioEntry) =>
  a.name === b.name && a.watchlist === b.watchlist && a.created_at === b.created_at

export function createStrategyStore(storage: ProfileStorage, now: () => number): StrategyStore {
  /** The writes, one after another; a failed one does not stop the next. */
  let tail: Promise<unknown> = Promise.resolve()
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }

  const read = async (): Promise<Doc> =>
    (await storage.getJSON(NAME, DocSchema)) ?? { next: 1, items: [] }

  const write = async (doc: Doc): Promise<void> => {
    if (doc.items.length > MAX_STRATEGIES) throw new StrategyLimitError(LIMIT_COPY)
    // One value, one bound: past it a backup could not carry the list (preflight ruling 24).
    if (utf8Length(JSON.stringify(doc)) > MAX_DOM_TOTAL) throw new StrategyLimitError(FULL_COPY)
    await storage.setJSON(NAME, doc)
  }

  const stamp = () => new Date(now()).toISOString()

  return {
    async list(watchlist) {
      const { items } = await read()
      return items.filter((e) => !watchlist || e.watchlist === watchlist).sort(byUpdated)
    },
    async get(id) {
      return (await read()).items.find((e) => e.id === id) ?? null
    },
    save(p, id) {
      return queued(async () => {
        const doc = await read()
        const fields = {
          name: p.name.trim(),
          watchlist: p.watchlist,
          underlying: p.underlying,
          exchange: p.exchange,
          expiry: p.expiry ?? null,
          legs: stripKeys(p.legs),
          notes: p.notes ?? null,
        }
        const t = stamp()
        if (id === undefined) {
          const entry: PortfolioEntry = {
            id: doc.next,
            ...fields,
            created_at: t,
            updated_at: t,
          }
          await write({ next: doc.next + 1, items: [...doc.items, entry] })
          return entry
        }
        const old = doc.items.find((e) => e.id === id)
        if (!old) return null
        const entry: PortfolioEntry = { ...old, ...fields, updated_at: t }
        await write({ ...doc, items: doc.items.map((e) => (e.id === id ? entry : e)) })
        return entry
      })
    },
    remove(id) {
      return queued(async () => {
        const doc = await read()
        if (!doc.items.some((e) => e.id === id)) return false
        await write({ ...doc, items: doc.items.filter((e) => e.id !== id) })
        return true
      })
    },
    async all() {
      return (await read()).items.sort(byUpdated)
    },
    merge(entries) {
      return queued(async () => {
        const doc = await read()
        const items = [...doc.items]
        let next = doc.next
        let added = 0
        for (const e of entries) {
          if (items.some((x) => sameStrategy(x, e))) continue
          if (items.length >= MAX_STRATEGIES) break
          items.push({ ...e, legs: stripKeys(e.legs), id: next++ })
          added++
        }
        if (added > 0) await write({ next, items })
        return added
      })
    },
    clear() {
      return queued(async () => {
        const doc = await read()
        await write({ next: doc.next, items: [] })
      })
    },
  }
}
