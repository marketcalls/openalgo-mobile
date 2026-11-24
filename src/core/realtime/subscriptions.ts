// The subscription manager (design 7.6). Screens hold (symbol, mode) requests; the socket carries
// one subscription per symbol, at the highest mode any screen needs, because Depth carries LTP.
import type { SetTimer } from '~/core/http/scheduler'
import {
  type DepthLevels,
  type Inbound,
  type Mode,
  quoteKey,
  type SymbolPair,
  subscribeMsg,
  unsubscribeMsg,
} from './protocol'

/** What a screen asks for. `depth` counts only with mode 3, where it defaults to 5 (S12). */
export type SubRequest = { exchange: string; symbol: string; mode: Mode; depth?: DepthLevels }
export type SubAck = Extract<Inbound, { t: 'sub_ack' }>

export type SubscriptionManagerOptions = {
  /** Writes one frame to the authenticated socket. */
  send: (frame: string) => void
  /** The symbol no longer needs Depth (lower mode, or released): its book is stale from here on. */
  onDowngrade?: (key: string) => void
  debounceMs?: number
  /** The app's share of the server's 1,000-symbol pool (design 7.6). */
  budget?: number
  setTimer?: SetTimer
}

type Hold = { mode: Mode; depth?: DepthLevels; n: number }
type Wanted = { exchange: string; symbol: string; holds: Map<string, Hold> }
/** What was sent on this connection. The ack and tick facts live and die with the entry. */
type Wired = SubRequest & { failed: boolean; ackDepth?: number; levels?: number }

const defaultTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

/** The highest mode held, and for mode 3 the highest depth; undefined once nothing is held. */
const topOf = (w: Wanted): SubRequest | undefined => {
  let top: Hold | undefined
  for (const h of w.holds.values()) {
    if (!top || h.mode > top.mode || (h.mode === top.mode && (h.depth ?? 0) > (top.depth ?? 0))) {
      top = h
    }
  }
  if (!top) return undefined
  return {
    exchange: w.exchange,
    symbol: w.symbol,
    mode: top.mode,
    ...(top.depth !== undefined ? { depth: top.depth } : {}),
  }
}

const same = (a: SubRequest, b: SubRequest) => a.mode === b.mode && a.depth === b.depth

type Batch = { mode: Mode; depth?: DepthLevels; pairs: SymbolPair[] }

/** Adds `s` to the batch for its mode (and its depth, if `byDepth`), keeping first-seen order. */
const addTo = (batches: Map<string, Batch>, s: SubRequest, byDepth: boolean) => {
  const depth = byDepth ? s.depth : undefined
  const k = `${s.mode}/${depth ?? 0}`
  const b = batches.get(k)
  if (b) b.pairs.push(s)
  else batches.set(k, { mode: s.mode, depth, pairs: [s] })
}

export const createSubscriptionManager = ({
  send,
  onDowngrade,
  debounceMs = 100,
  budget = 500,
  setTimer = defaultTimer,
}: SubscriptionManagerOptions) => {
  const wanted = new Map<string, Wanted>()
  /** Symbols inside the budget, in the order they got in. */
  const granted = new Set<string>()
  /** Symbols over the budget, first come first served. */
  const queue: string[] = []
  const wire = new Map<string, Wired>()
  /** True between an authenticate (`resendAll`) and the next `connectionLost`. */
  let online = false
  let cancelFlush: (() => void) | undefined

  /** A symbol's first hold: it takes a budget slot, or queues for one. */
  const track = (key: string, r: SubRequest): Wanted => {
    const w: Wanted = { exchange: r.exchange, symbol: r.symbol, holds: new Map() }
    wanted.set(key, w)
    if (granted.size < budget) granted.add(key)
    else queue.push(key)
    return w
  }

  const free = (key: string) => {
    if (granted.delete(key)) {
      const next = queue.shift()
      if (next !== undefined) granted.add(next)
      return
    }
    const i = queue.indexOf(key)
    if (i >= 0) queue.splice(i, 1)
  }

  /** Per symbol inside the budget, what the wire should carry. */
  const effectiveSet = (): Map<string, SubRequest> => {
    const out = new Map<string, SubRequest>()
    for (const key of granted) {
      const w = wanted.get(key)
      const top = w && topOf(w)
      if (top) out.set(key, top)
    }
    return out
  }

  /** Diffs the effective set against the wire: every unsubscribe, then every subscribe. */
  const flush = () => {
    cancelFlush?.()
    cancelFlush = undefined
    const want = effectiveSet()
    const unsubs = new Map<string, Batch>()
    for (const [key, w] of wire) {
      const top = want.get(key)
      if (top && same(top, w)) continue
      // An unsubscribe carries no depth: the server keys on symbol, exchange and mode.
      addTo(unsubs, w, false)
      wire.delete(key)
    }
    const subs = new Map<string, Batch>()
    for (const [key, top] of want) {
      if (wire.has(key)) continue
      addTo(subs, top, true)
      wire.set(key, { ...top, failed: false })
    }
    for (const b of unsubs.values()) send(unsubscribeMsg(b.pairs, b.mode))
    for (const b of subs.values()) send(subscribeMsg(b.pairs, b.mode, b.depth))
  }

  /**
   * Restarts the debounce: the flush runs `debounceMs` after the last change. Offline, a change
   * only moves the counts, and `resendAll` sends the result.
   */
  const changed = () => {
    if (!online) return
    cancelFlush?.()
    cancelFlush = setTimer(flush, debounceMs)
  }

  return {
    /** Holds a request until the returned release is called (once; later calls do nothing). */
    acquire(r: SubRequest): () => void {
      const key = quoteKey(r.exchange, r.symbol)
      const depth = r.mode === 3 ? (r.depth ?? 5) : undefined
      const hk = `${r.mode}/${depth ?? 0}`
      const w = wanted.get(key) ?? track(key, r)
      const h = w.holds.get(hk) ?? { mode: r.mode, depth, n: 0 }
      h.n++
      w.holds.set(hk, h)
      changed()

      let live = true
      return () => {
        if (!live) return
        live = false
        const wasDepth = topOf(w)?.mode === 3
        h.n--
        if (h.n === 0) w.holds.delete(hk)
        if (w.holds.size === 0) {
          wanted.delete(key)
          free(key)
        }
        if (wasDepth && topOf(w)?.mode !== 3) onDowngrade?.(key)
        changed()
      }
    },

    /** A subscribe ack: records each entry's depth and whether the server refused it. */
    onAck(a: SubAck) {
      for (const e of a.entries) {
        const w = wire.get(quoteKey(e.exchange, e.symbol))
        if (!w) continue
        w.failed = !e.ok
        if (e.depth !== undefined) w.ackDepth = e.depth
      }
    },

    /** One depth tick held `n` priced levels (S12: brokers pad with price 0). */
    noteDepthLevels(exchange: string, symbol: string, n: number) {
      const w = wire.get(quoteKey(exchange, symbol))
      if (w) w.levels = Math.max(w.levels ?? 0, n)
    },

    /** Call on every auth_ok: the new connection holds nothing, so everything is sent at once. */
    resendAll() {
      wire.clear()
      online = true
      flush()
    },

    /** Call when the socket closes: nothing is on the wire, and nothing is sent until resendAll. */
    connectionLost() {
      online = false
      wire.clear()
      cancelFlush?.()
      cancelFlush = undefined
    },

    /** The subscriptions the wire should carry: one per symbol inside the budget. */
    effective: (): SubRequest[] => Array.from(effectiveSet().values()),

    /** Sent on this connection and not refused by the server's ack. */
    isWired(exchange: string, symbol: string): boolean {
      const w = wire.get(quoteKey(exchange, symbol))
      return w !== undefined && !w.failed
    },

    /**
     * S12: min(ack depth, the most priced levels seen in one depth tick); the requested depth
     * stands in until the ack. Undefined until the first depth tick.
     */
    confirmedDepth(exchange: string, symbol: string): number | undefined {
      const w = wire.get(quoteKey(exchange, symbol))
      if (w?.mode !== 3 || w.levels === undefined) return undefined
      return Math.min(w.ackDepth ?? w.depth ?? 5, w.levels)
    },

    /** Quote keys over the budget, in the order they will get in. */
    waiting: (): string[] => [...queue],
  }
}

export type SubscriptionManager = ReturnType<typeof createSubscriptionManager>
