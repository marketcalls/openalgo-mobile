// The polling fallback (design 7.6): when the socket is not carrying a symbol, REST fills the
// tick store. Consumers register what they need; the engine merges and paces the calls.
import type { Api } from '~/core/http/api'
import type { SetTimer } from '~/core/http/scheduler'
import { DepthSchema, MultiQuotesSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { depthRestToPatch, multiquoteToPatch, quoteKey } from './protocol'
import type { TickStore } from './tickStore'

type Rate = { home: number; tunnel: number }

/** Poll intervals in ms, by where the server is reached from (design 7.6). */
export const POLL_RATES = {
  quotes: { home: 2000, tunnel: 5000 },
  depth: { home: 2000, tunnel: 5000 },
  chartLtp: { home: 2000, tunnel: 5000 },
  optionchain: { home: 5000, tunnel: 10_000 },
  arbitrage: { home: 5000, tunnel: 5000 },
  positions: 5000,
  funds: 60_000,
  orderbookWorking: 5000,
  orderbookIdle: 30_000,
  /** Quotes and depth slow down by this factor while every polled symbol's market is closed. */
  offHoursFactor: 5,
} as const satisfies Record<string, Rate | number>

/**
 * How the price polls are doing: `ok` when the last call of every running quotes and depth loop
 * got a reply, `failing` when one failed or is still out after three intervals, `none` with no
 * price loop running or nothing to poll.
 */
export type PollHealth = 'ok' | 'failing' | 'none'

export type PollConsumer =
  | { kind: 'quotes'; keys: () => string[] }
  | { kind: 'depth'; key: () => string }
  | { kind: 'custom'; intervalMs: () => number; run: () => Promise<void> | void }

export type PollingDeps = {
  api: Pick<Api, 'call'>
  store: Pick<TickStore, 'put'>
  /** The socket carries this symbol: polling it would only duplicate. */
  isLive: (exchange: string, symbol: string) => boolean
  /**
   * The socket delivers this symbol's depth; a quote-only subscription does not, so depth
   * polling goes on. Defaults to `isLive`.
   */
  isDepthLive?: (exchange: string, symbol: string) => boolean
  network: () => 'home' | 'tunnel'
  now: () => number
  setTimer?: SetTimer
  /** The rate follows the polled symbols' exchanges (CRYPTO never closes, NSE does). */
  isExchangeOpen: (exchange: string, now: number) => boolean
}

const TAG = 'poll'
const BATCH = 100
/** A price call still out after this many intervals counts as failed. */
const OVERDUE_INTERVALS = 3
/** How often a function-form `active` is re-read to start or stop loops. */
const WATCH_MS = 1000

const defaultTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

type Entry = { c: PollConsumer; active: boolean | (() => boolean) }

const split = (key: string): { exchange: string; symbol: string } => {
  const i = key.indexOf(':')
  return { exchange: key.slice(0, i), symbol: key.slice(i + 1) }
}

export function createPollingEngine(d: PollingDeps) {
  const setTimer = d.setTimer ?? defaultTimer
  const entries = new Set<Entry>()
  /** Running loops: 'quotes' for the merged call, an Entry for each depth or custom consumer. */
  const loops = new Map<string | Entry, { cancel: () => void; token: object }>()
  let appActive = true
  const calls = { quotes: 0, depth: 0, custom: 0 }
  let errors = 0
  /** Per price loop: whether its last call got a reply. */
  const results = new Map<string | Entry, boolean>()
  const healthListeners = new Set<() => void>()
  let health: PollHealth = 'none'

  /** Records a price loop's last call (undefined: it made none, or it stopped). */
  const note = (id: string | Entry, ok: boolean | undefined) => {
    if (ok === undefined) results.delete(id)
    else results.set(id, ok)
    let next: PollHealth = results.size === 0 ? 'none' : 'ok'
    for (const v of results.values()) if (!v) next = 'failing'
    if (next === health) return
    health = next
    for (const fn of Array.from(healthListeners)) fn()
  }

  const isActive = (e: Entry) =>
    appActive && (typeof e.active === 'function' ? e.active() : e.active)

  /** The next call's wait: slower while no market of the `keys` it polls is open. */
  const interval = (kind: 'quotes' | 'depth', keys: string[]): number => {
    const base = POLL_RATES[kind][d.network()]
    const t = d.now()
    const open = keys.some((k) => d.isExchangeOpen(split(k).exchange, t))
    return open ? base : base * POLL_RATES.offHoursFactor
  }

  /** The merged keys of the active quote consumers. */
  const activeQuoteKeys = (): string[] => {
    const keys = new Set<string>()
    for (const e of entries) {
      if (e.c.kind === 'quotes' && isActive(e)) for (const k of e.c.keys()) keys.add(k)
    }
    return Array.from(keys)
  }

  /** The keys to poll: the active ones the socket does not carry. */
  const quoteKeys = (): string[] =>
    activeQuoteKeys().filter((k) => {
      const { exchange, symbol } = split(k)
      return !d.isLive(exchange, symbol)
    })

  /** While the socket carries every key, the rate follows them all, so a drop is covered soon. */
  const quotesInterval = (): number => {
    const todo = quoteKeys()
    return interval('quotes', todo.length > 0 ? todo : activeQuoteKeys())
  }

  /** True when it made a call. */
  const pollQuotes = async (): Promise<boolean> => {
    const todo = quoteKeys()
    for (let i = 0; i < todo.length; i += BATCH) {
      const symbols = todo
        .slice(i, i + BATCH)
        .map(split)
        .map((s) => ({
          symbol: s.symbol,
          exchange: s.exchange,
        }))
      calls.quotes++
      const results = await d.api.call('multiquotes', { symbols }, MultiQuotesSchema)
      for (const r of results) {
        if (r.data) d.store.put(quoteKey(r.exchange, r.symbol), multiquoteToPatch(r.data), 'poll')
      }
    }
    return todo.length > 0
  }

  /** True when it made a call. */
  const pollDepth = async (key: string): Promise<boolean> => {
    const { exchange, symbol } = split(key)
    if ((d.isDepthLive ?? d.isLive)(exchange, symbol)) return false
    calls.depth++
    const data = await d.api.call('depth', { symbol, exchange }, DepthSchema)
    d.store.put(key, depthRestToPatch(data), 'poll')
    return true
  }

  const wantsQuotes = () => Array.from(entries).some((e) => e.c.kind === 'quotes' && isActive(e))

  /**
   * Runs `step` every `ms()` after the previous one finished, until cancelled. Each loop owns a
   * token; a step that outlives its loop (stopped, or stopped and restarted meanwhile) finds
   * another token in the map and does not re-arm. `alive` is read at every tick: a loop whose
   * consumer went inactive ends itself instead of polling. A price loop (`price`) reports each
   * call's outcome to the health.
   */
  const loop = (
    id: string | Entry,
    ms: () => number,
    alive: () => boolean,
    /** A price step resolves true when it made a call. */
    step: () => Promise<unknown>,
    price = false,
  ) => {
    const token = {}
    const mine = () => loops.get(id)?.token === token
    const arm = () => {
      const wait = ms()
      const cancel = setTimer(async () => {
        if (!mine()) return
        if (!alive()) {
          stop(id)
          return
        }
        const overdue = price
          ? setTimer(() => mine() && note(id, false), OVERDUE_INTERVALS * wait)
          : undefined
        try {
          const called = await step()
          if (price && mine()) note(id, called === true ? true : undefined)
        } catch (e) {
          errors++
          if (price && mine()) note(id, false)
          log.warn(TAG, `poll failed: ${e instanceof Error ? e.name : 'error'}`)
        } finally {
          overdue?.()
        }
        if (mine()) arm()
      }, wait)
      loops.set(id, { cancel, token })
    }
    arm()
  }

  const stop = (id: string | Entry) => {
    loops.get(id)?.cancel()
    loops.delete(id)
    note(id, undefined)
  }

  /** Starts the loops that should run and stops the rest. */
  const sync = () => {
    const wantQuotes = wantsQuotes()
    if (wantQuotes && !loops.has('quotes'))
      loop('quotes', quotesInterval, wantsQuotes, pollQuotes, true)
    if (!wantQuotes) stop('quotes')
    for (const e of entries) {
      const c = e.c
      if (c.kind === 'quotes') continue
      if (!isActive(e)) stop(e)
      else if (!loops.has(e)) {
        if (c.kind === 'depth')
          loop(
            e,
            () => interval('depth', [c.key()]),
            () => isActive(e),
            () => pollDepth(c.key()),
            true,
          )
        else {
          loop(
            e,
            c.intervalMs,
            () => isActive(e),
            async () => {
              calls.custom++
              await c.run()
            },
          )
        }
      }
    }
    updateWatch()
  }

  /** A function-form `active` can flip at any time: re-sync periodically while any exists. */
  let cancelWatch: (() => void) | undefined
  const updateWatch = () => {
    const need = appActive && Array.from(entries).some((e) => typeof e.active === 'function')
    if (!need) {
      cancelWatch?.()
      cancelWatch = undefined
    } else if (!cancelWatch) {
      const tick = () => {
        cancelWatch = undefined
        sync() // re-arms the watch through updateWatch
      }
      cancelWatch = setTimer(tick, WATCH_MS)
    }
  }

  return {
    /** Adds a consumer; `active` may be a function read at every tick. Returns its removal. */
    register(c: PollConsumer, active: boolean | (() => boolean)): () => void {
      const e: Entry = { c, active }
      entries.add(e)
      sync()
      return () => {
        if (!entries.delete(e)) return
        stop(e)
        sync()
      }
    },
    /** Nothing polls while the app is in the background. */
    setAppActive(b: boolean) {
      if (appActive === b) return
      appActive = b
      if (!b) for (const id of Array.from(loops.keys())) stop(id)
      sync()
    },
    stats: () => ({ calls: { ...calls }, errors, consumers: entries.size, loops: loops.size }),
    health: (): PollHealth => health,
    /** Told when `health()` changes. */
    onHealth(fn: () => void): () => void {
      healthListeners.add(fn)
      return () => {
        healthListeners.delete(fn)
      }
    },
  }
}

export type PollingEngine = ReturnType<typeof createPollingEngine>
