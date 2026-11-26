// The request scheduler (design 7.5), one per server. It keeps the app near 5 req/s so the
// user's shared rate limits stay with their strategies. It never retries anything itself.
import { noReplyError } from './client'
import type { EndpointId, Lane } from './endpoints'
import { ApiError } from './errors'

/** Runs `fn` after `ms`; the returned function cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void

export type SchedulerOptions = {
  /** The read bucket: tokens per second, and its capacity. Reads and history share it. */
  ratePerSec?: number
  historyMaxInFlight?: number
  historyRatePerSec?: number
  smartGapMs?: number
  backoffStartMs?: number
  backoffMaxMs?: number
  now?: () => number
  setTimer?: SetTimer
}

export type ScheduledRequest<T> = {
  endpoint: EndpointId
  lane: Lane
  /** Reads with the same key share one exec. Ignored on the order, smart and control lanes. */
  dedupeKey?: string
  /**
   * This caller's abort. It rejects this caller alone, at once; the shared exec is dropped
   * (queued) or aborted (sent) only when every caller sharing it has aborted.
   */
  signal?: AbortSignal
  /** Sends the request. `signal` aborts once every caller has. */
  exec: (signal: AbortSignal) => Promise<T>
}

export type SchedulerStats = {
  queued: Record<Lane, number>
  inFlight: number
  started: number
  deduped: number
  rateLimited: number
  /** Endpoints a 429 is holding back right now. */
  gated: EndpointId[]
  paused: boolean
  halted: boolean
}

export type Scheduler = {
  /**
   * Queues `r`. An order or smart order whose endpoint a 429 is holding back rejects at once,
   * unsent, with RateLimited (`retryInSec` says when the gate opens); other lanes wait.
   */
  run<T>(r: ScheduledRequest<T>): Promise<T>
  /** Holds the read and history lanes; orders and controls still go. */
  pause(): void
  resume(): void
  /** Rejects every queued and new request with `e` until `unhalt()`. Sent ones finish. */
  halt(e: Error): void
  unhalt(): void
  stats(): SchedulerStats
}

/** One `run` waiting on a job. `off` removes its abort listener. */
type Caller = { resolve: (v: unknown) => void; reject: (e: unknown) => void; off?: () => void }

type Job = {
  endpoint: EndpointId
  lane: Lane
  key?: string
  exec: (signal: AbortSignal) => Promise<unknown>
  /** Everyone still waiting for this job's result; deduped reads add to it. */
  callers: Set<Caller>
  /** Aborted when the last caller aborts. */
  ctrl: AbortController
}

/** A 429 back-off. `afterStart` is the start count when it closed. */
type Gate = { strikes: number; until: number; afterStart: number }

// Order, smart and control skip the bucket and go ahead of queued reads.
const PRIORITY: ReadonlySet<Lane> = new Set(['order', 'smart', 'control'])
// An order that waited out a 429 gate would go out later than the user's tap, so these
// fail fast instead (controller ruling 3a).
const NEVER_WAIT_FOR_GATE: ReadonlySet<Lane> = new Set(['order', 'smart'])

const defaultTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

/** Whole tokens: `capacity` at rest, refilled one every `1000 / ratePerSec` ms. */
function createBucket(ratePerSec: number, capacity: number) {
  const interval = 1000 / ratePerSec
  let tokens = capacity
  let nextAt = 0
  return {
    /** The ms until a token is free; 0 means `take` may run now. */
    wait(t: number): number {
      if (tokens < capacity && t >= nextAt) {
        const n = Math.floor((t - nextAt) / interval) + 1
        tokens = Math.min(capacity, tokens + n)
        nextAt += n * interval
      }
      return tokens > 0 ? 0 : Math.ceil(nextAt - t)
    },
    take(t: number): void {
      if (tokens === capacity) nextAt = t + interval
      tokens -= 1
    },
  }
}

export function createScheduler(o: SchedulerOptions = {}): Scheduler {
  const {
    ratePerSec = 5,
    historyMaxInFlight = 3,
    historyRatePerSec = 3,
    smartGapMs = 500,
    backoffStartMs = 2000,
    backoffMaxMs = 30_000,
    now = () => Date.now(),
    setTimer = defaultTimer,
  } = o
  const historyGapMs = Math.ceil(1000 / historyRatePerSec)
  const bucket = createBucket(ratePerSec, ratePerSec)
  const priority: Job[] = []
  const paced: Job[] = []
  const shares = new Map<string, Job>()
  const gates = new Map<EndpointId, Gate>()
  let lastSmartAt = Number.NEGATIVE_INFINITY
  let lastHistoryAt = Number.NEGATIVE_INFINITY
  let historyInFlight = 0
  let inFlight = 0
  let started = 0
  let deduped = 0
  let rateLimited = 0
  let paused = false
  let haltedBy: Error | undefined
  let cancelWake: (() => void) | undefined

  const queueOf = (job: Job) => (PRIORITY.has(job.lane) ? priority : paced)

  /** Takes `job` out of its queue; false when it was not queued (it has been sent). */
  function dequeue(job: Job): boolean {
    const q = queueOf(job)
    const i = q.indexOf(job)
    if (i < 0) return false
    q.splice(i, 1)
    return true
  }

  /** Stops new runs joining `job`. */
  function unshare(job: Job) {
    if (job.key !== undefined && shares.get(job.key) === job) shares.delete(job.key)
  }

  /** Settles every caller still waiting on `job`. */
  function settle(job: Job, fn: (c: Caller) => void) {
    for (const c of job.callers) {
      c.off?.()
      fn(c)
    }
    job.callers.clear()
  }

  /** `caller` aborted: it rejects alone; the last one out drops or aborts the job. */
  function leave(job: Job, caller: Caller) {
    if (!job.callers.delete(caller)) return
    caller.off?.()
    caller.reject(noReplyError(job.endpoint, job.lane))
    if (job.callers.size > 0) return
    unshare(job)
    if (!dequeue(job)) job.ctrl.abort()
  }

  /** Notes how a request ended. A reply to one sent before the gate closed is stale. */
  function noteGate(endpoint: EndpointId, startNo: number, outcome: 'ok' | 'limited' | 'other') {
    if (outcome === 'limited') rateLimited += 1
    const g = gates.get(endpoint)
    if (g && startNo <= g.afterStart) return
    if (outcome === 'ok') gates.delete(endpoint)
    if (outcome !== 'limited') return
    const strikes = (g?.strikes ?? 0) + 1
    const ms = Math.min(backoffMaxMs, backoffStartMs * 2 ** (strikes - 1))
    gates.set(endpoint, { strikes, until: now() + ms, afterStart: started })
  }

  function start(job: Job) {
    dequeue(job)
    const startNo = ++started
    inFlight += 1
    if (job.lane === 'history') historyInFlight += 1
    const finish = (outcome: 'ok' | 'limited' | 'other') => {
      inFlight -= 1
      if (job.lane === 'history') historyInFlight -= 1
      unshare(job)
      noteGate(job.endpoint, startNo, outcome)
      pump()
    }
    const { signal } = job.ctrl
    // A microtask keeps exec (and anything it schedules) out of pump's loop.
    Promise.resolve()
      .then(() => {
        // every caller left before it went out
        if (signal.aborted) throw noReplyError(job.endpoint, job.lane)
        return job.exec(signal)
      })
      .then(
        (v) => {
          finish('ok')
          settle(job, (c) => c.resolve(v))
        },
        (e: unknown) => {
          finish(e instanceof ApiError && e.kind === 'RateLimited' ? 'limited' : 'other')
          settle(job, (c) => c.reject(e))
        },
      )
  }

  /** Starts every job that may go now, and wakes again when the next one can. */
  function pump() {
    cancelWake?.()
    cancelWake = undefined
    if (haltedBy) return
    const t = now()
    let wakeAt = Number.POSITIVE_INFINITY
    const wakeBy = (at: number) => {
      wakeAt = Math.min(wakeAt, at)
    }
    const gatedUntil = (job: Job) => gates.get(job.endpoint)?.until ?? 0

    for (const job of [...priority]) {
      const gate = gatedUntil(job)
      if (gate > t) {
        if (!NEVER_WAIT_FOR_GATE.has(job.lane)) {
          wakeBy(gate)
          continue
        }
        dequeue(job)
        const retryInSec = Math.max(1, Math.ceil((gate - t) / 1000))
        const e = new ApiError({
          kind: 'RateLimited',
          status: 0,
          endpoint: job.endpoint,
          retryInSec,
        })
        settle(job, (c) => c.reject(e))
        continue
      }
      if (job.lane === 'smart') {
        if (lastSmartAt + smartGapMs > t) {
          wakeBy(lastSmartAt + smartGapMs)
          continue
        }
        lastSmartAt = t
      }
      start(job)
    }

    if (!paused) {
      for (const job of [...paced]) {
        if (gatedUntil(job) > t) {
          wakeBy(gatedUntil(job))
          continue
        }
        const history = job.lane === 'history'
        // A full history lane wakes when one of its calls finishes.
        if (history && historyInFlight >= historyMaxInFlight) continue
        if (history && lastHistoryAt + historyGapMs > t) {
          wakeBy(lastHistoryAt + historyGapMs)
          continue
        }
        const wait = bucket.wait(t)
        if (wait > 0) {
          // every later job needs a token too
          wakeBy(t + wait)
          break
        }
        bucket.take(t)
        if (history) lastHistoryAt = t
        start(job)
      }
    }

    if (wakeAt < Number.POSITIVE_INFINITY) cancelWake = setTimer(pump, wakeAt - t)
  }

  return {
    run<T>(r: ScheduledRequest<T>): Promise<T> {
      if (haltedBy) return Promise.reject(haltedBy)
      const { signal } = r
      // the client's answer to an aborted signal, without queueing anything
      if (signal?.aborted) return Promise.reject(noReplyError(r.endpoint, r.lane))
      const key = PRIORITY.has(r.lane) ? undefined : r.dedupeKey
      const shared = key === undefined ? undefined : shares.get(key)
      const job: Job = shared ?? {
        endpoint: r.endpoint,
        lane: r.lane,
        key,
        exec: r.exec,
        callers: new Set(),
        ctrl: new AbortController(),
      }
      const promise = new Promise<unknown>((resolve, reject) => {
        const caller: Caller = { resolve, reject }
        if (signal) {
          const onAbort = () => leave(job, caller)
          signal.addEventListener('abort', onAbort, { once: true })
          caller.off = () => signal.removeEventListener('abort', onAbort)
        }
        job.callers.add(caller)
      })
      if (shared) {
        deduped += 1
        return promise as Promise<T>
      }
      if (key !== undefined) shares.set(key, job)
      queueOf(job).push(job)
      pump()
      return promise as Promise<T>
    },

    pause() {
      paused = true
    },

    resume() {
      paused = false
      pump()
    },

    halt(e) {
      haltedBy = e
      cancelWake?.()
      cancelWake = undefined
      for (const job of [...priority.splice(0), ...paced.splice(0)]) {
        unshare(job)
        settle(job, (c) => c.reject(e))
      }
    },

    unhalt() {
      haltedBy = undefined
      pump()
    },

    stats() {
      const queued: Record<Lane, number> = { read: 0, history: 0, order: 0, smart: 0, control: 0 }
      for (const job of [...priority, ...paced]) queued[job.lane] += 1
      const t = now()
      const gated = [...gates].filter(([, g]) => g.until > t).map(([id]) => id)
      return {
        queued,
        inFlight,
        started,
        deduped,
        rateLimited,
        gated,
        paused,
        halted: haltedBy !== undefined,
      }
    },
  }
}
