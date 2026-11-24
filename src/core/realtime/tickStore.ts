import type { Quote, QuotePatch } from './protocol'

export type { Quote }

type Schedule = (flush: () => void) => void
type Source = Quote['source']

const defaultSchedule: Schedule = (fn) => {
  requestAnimationFrame(fn)
}

/**
 * External quote store. Ticks land in a Map outside React and subscribers are told at most once
 * per key per flush, so a burst of ticks is one render per visible row, not one per tick.
 */
export const createTickStore = (
  schedule: Schedule = defaultSchedule,
  { evictAfterMs = 60_000 }: { evictAfterMs?: number } = {},
) => {
  const quotes = new Map<string, Quote>()
  const listeners = new Map<string, Set<() => void>>()
  const evictTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const dirty = new Set<string>()
  const staleListeners = new Set<() => void>()
  let scheduled = false
  let stale = false
  let wsAt = 0
  let ticksIn = 0
  let flushes = 0
  let keysPublished = 0

  const flush = () => {
    scheduled = false
    if (dirty.size === 0) return
    flushes++
    const keys = Array.from(dirty)
    dirty.clear()
    keysPublished += keys.length
    for (const k of keys) for (const fn of Array.from(listeners.get(k) ?? [])) fn()
  }

  const mark = (key: string) => {
    dirty.add(key)
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  const withChange = (q: Quote): Quote => {
    if (q.ltp !== undefined && q.close !== undefined && q.close > 0) {
      const change = q.ltp - q.close
      return { ...q, change, changePct: (change / q.close) * 100 }
    }
    const { change: _c, changePct: _p, ...rest } = q
    return rest
  }

  const merge = (key: string, patch: QuotePatch, source: Source, ts: number) => {
    const prev = quotes.get(key)
    let dir: Quote['dir'] = prev?.dir ?? 0
    if (prev?.ltp !== undefined && patch.ltp !== undefined) {
      dir = patch.ltp > prev.ltp ? 1 : patch.ltp < prev.ltp ? -1 : dir
    }
    quotes.set(key, withChange({ ...prev, ...patch, ts, dir, source }))
    mark(key)
  }

  return {
    /** Merges a patch into the quote. `depth` is replaced whole. Always overwrites a seed. */
    put(key: string, patch: QuotePatch, source: 'ws' | 'poll') {
      ticksIn++
      const ts = Date.now()
      if (source === 'ws') wsAt = ts
      merge(key, patch, source, ts)
    },
    /** Fills a quote from a snapshot taken at `ts`; skipped if the store already holds newer data. */
    seed(key: string, patch: QuotePatch, ts: number) {
      const prev = quotes.get(key)
      if (prev && prev.ts >= ts) return
      merge(key, patch, 'seed', ts)
    },
    get: (key: string): Quote | undefined => quotes.get(key),
    /** The last subscriber leaving starts the eviction clock; the first one back stops it. */
    subscribe(key: string, fn: () => void) {
      const set = listeners.get(key) ?? new Set<() => void>()
      listeners.set(key, set)
      set.add(fn)
      const timer = evictTimers.get(key)
      if (timer) {
        clearTimeout(timer)
        evictTimers.delete(key)
      }
      return () => {
        set.delete(fn)
        if (set.size > 0) return
        listeners.delete(key)
        const t = setTimeout(() => {
          evictTimers.delete(key)
          quotes.delete(key)
          dirty.delete(key)
        }, evictAfterMs)
        evictTimers.set(key, t)
      }
    },
    dropDepth(key: string) {
      const q = quotes.get(key)
      if (!q?.depth) return
      const { depth: _d, ...rest } = q
      quotes.set(key, rest)
      mark(key)
    },
    reset() {
      for (const t of evictTimers.values()) clearTimeout(t)
      evictTimers.clear()
      quotes.clear()
      dirty.clear()
      wsAt = 0
      stale = false
    },
    setStale(next: boolean) {
      if (stale === next) return
      stale = next
      for (const fn of Array.from(staleListeners)) fn()
    },
    isStale: () => stale,
    subscribeStale(fn: () => void) {
      staleListeners.add(fn)
      return () => {
        staleListeners.delete(fn)
      }
    },
    /** Epoch ms of the last tick received over the socket; 0 if none yet. */
    lastWsTickAt: () => wsAt,
    stats: () => ({ ticksIn, flushes, keysPublished, keys: quotes.size }),
  }
}

export type TickStore = ReturnType<typeof createTickStore>
