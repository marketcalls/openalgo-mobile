// What a tool page may ask of native (design 7.7, 7.8): the startup calls answered on the phone,
// its allowlist (the session routes ported to the phone, its /api/v1 calls), its order writes
// held for review, its WebSocket emulated over the app's feed, and its file saves. Its events go
// to the screen.
// - A hidden tool sends nothing: its requests wait for the next focus (one shared wait per hidden
//   period). Identical ones that waited go as one call when the tool is back in front (RF 5); an
//   order write is never merged. Background, the lock or the share sheet only make new requests
//   wait: what is in flight goes on.
// - Each request has its own abort, linked to the page's: `reset` aborts them all, closes the
//   page's sockets, drops what the page was not yet sent, and answers an unconfirmed held order
//   "cancelled" (RF 5). A held order whose send has begun keeps its real outcome.
// - Under polling the page's sockets close (whenPolling 'fail'): no tool in this build reads them.
// - `status` is what the tool's header line tells: its last update, a long pass under way, a
//   route's progress.
// - The device routes get the screen's focus, its progress line, one /intervals read (plan D's
//   query) and a lifetime: `reset` (the screen goes, or the page loads again) aborts it, so work a
//   route keeps on after its reply stops there, and the next load gets a new one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { gate } from '~/core/capabilities/gates'
import { stableJson } from '~/core/http/api'
import { log } from '~/core/log/logger'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { type DomHandlers, REFUSED_REPLY } from '~/dom/bridge/DomHost'
import type { Outbox } from '~/dom/bridge/outbox'
import type { DomEvent, DomReply, DomRequest, ToolPageId } from '~/dom/bridge/protocol'
import {
  createHeldWriteRoutes,
  createHeldWrites,
  type HeldWrites,
  ORDER_WRITE_PATHS,
} from '~/dom/gateway/heldWrites'
import { createRequestRouter, type Route, untilActive } from '~/dom/gateway/requests'
import { createStartupRoutes } from '~/dom/gateway/startupRoutes'
import { TOOL_ALLOWLIST } from '~/dom/gateway/toolAllowlist'
import { createToolRoutes, type SavedFile } from '~/dom/gateway/toolRoutes'
import { createWsEmulation } from '~/dom/gateway/wsEmulation'
import { brokerCaps } from '~/market/brokers/seed'
import { chartIntervalsQuery } from '~/market/chart/queries'
import { currentBroker } from '~/market/session'
import { useTrading } from '~/market/trading'
import { toast } from '~/ui/Toast'
import { writeAndShare } from '../files'
import { PRIMARY_ROUTE, SHARE_FAILED } from '../model'

/** Of the page's figures: the last reply of its primary route, ok or not, with the time. */
export type LastUpdate = { ok: true; at: number } | { ok: false; at: number; message: string }

/** What the header line reads, kept outside React so a reply re-renders only the line. */
export type ToolStatus = {
  /** Primary-route requests the page is waiting for. */
  updating: number
  last: LastUpdate | null
  /** When the oldest pass-through or download still out started (device ms), or null. */
  longSince: number | null
  /** A long load's progress, from a route that reports one (RouteDeps.progress). */
  progress: { label: string; done: number; total: number } | null
}

const IDLE: ToolStatus = { updating: 0, last: null, longSince: null, progress: null }
const ERROR_LOG_EVERY_MS = 10_000

/** The message an error reply carries, else none. */
function messageOf(r: DomReply): string {
  const b = r.body
  if (typeof b === 'object' && b !== null && !Array.isArray(b) && typeof b.message === 'string') {
    return b.message
  }
  return ''
}

/** Resolves the requests that wait for the screen to be shown again. */
type Waiting = { promise: Promise<void>; resolve: () => void }

function waiting(): Waiting {
  let resolve = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Identical requests that waited through one hidden period, sent as one. */
type Group = { ctl: AbortController; members: number; reply: Promise<DomReply> }

const abortError = () =>
  Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })

/** The routes the page's long passes go to: their kind is pass or download. */
function longPaths(page: ToolPageId): ReadonlySet<string> {
  return new Set(
    TOOL_ALLOWLIST[page]
      .filter((r) => r.kind === 'pass' || r.kind === 'download')
      .map((r) => r.path),
  )
}

export function useToolGateway(o: {
  page: ToolPageId
  outbox: Outbox
  active: boolean
  onEvent: (e: DomEvent) => void
}): { handlers: DomHandlers; held: HeldWrites; reset(): void; status: StoreApi<ToolStatus> } {
  const s = useServices()
  const trading = useTrading()
  const latest = useRef(o)
  latest.current = o
  const [held] = useState(createHeldWrites)
  const [status] = useState(() => createStore<ToolStatus>(() => IDLE))

  // The emulation and the hidden-period wait read the screen's state when they run.
  const shown = useRef<{
    active: boolean
    waiting: Waiting | null
    /** The hidden period's groups: a request that arrives hidden joins its period's. */
    groups: Map<string, Group>
  }>({ active: o.active, waiting: null, groups: new Map() })
  useEffect(() => {
    const g = shown.current
    if (g.active === o.active) return
    g.active = o.active
    if (!o.active) {
      g.groups = new Map()
      return
    }
    g.waiting?.resolve()
    g.waiting = null
  }, [o.active])

  const [emulation] = useState(() =>
    createWsEmulation({
      realtime: s.realtime,
      store: s.store,
      polling: s.polling,
      orderEvents: s.orderEvents,
      // the same feed status the polling consumers and the app's badges follow
      feedMode: () =>
        useConnection.getState().feed === 'polling' || s.realtime.status().state === 'polling'
          ? 'polling'
          : 'live',
      whenPolling: 'fail',
      active: () => shown.current.active,
      post: (m) => latest.current.outbox.post(m),
    }),
  )

  /** Every request's own abort, while it is out. */
  const [controllers] = useState(() => new Set<AbortController>())
  /** The routes' lifetime (RouteDeps.lifetime), until the next `reset`. */
  const [lifetime] = useState(() => ({ current: new AbortController() }))
  const reset = useCallback(() => {
    lifetime.current.abort()
    lifetime.current = new AbortController()
    for (const c of [...controllers]) c.abort()
    controllers.clear()
    emulation.closeAll()
    latest.current.outbox.clear()
    held.cancelAll()
    status.setState({ updating: 0, longSince: null, progress: null })
  }, [controllers, lifetime, emulation, held, status])
  // the screen goes: nothing it held stays
  useEffect(() => reset, [reset])

  const whenActive = useCallback((): Promise<void> => {
    const g = shown.current
    if (g.active) return Promise.resolve()
    g.waiting ??= waiting()
    return g.waiting.promise
  }, [])

  /** One share sheet at a time: a save while one is open is dropped. */
  const sharing = useRef(false)
  const share = useCallback(async (f: SavedFile) => {
    if (sharing.current) return
    sharing.current = true
    try {
      await writeAndShare(f)
    } catch (e) {
      log.warn('tool', 'could not share a file', e)
      toast(SHARE_FAILED)
    } finally {
      sharing.current = false
    }
  }, [])

  /** The page's error reports: counted, and the count logged at most once per 10 s. */
  const errorReports = useRef({ n: 0, logged: Number.NEGATIVE_INFINITY })

  // One set per page: its requests are counted against the per-page cap on their own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new outbox is a new page, which gets its own set
  const handlers = useMemo<DomHandlers>(() => {
    const { page } = latest.current
    /** The hidden period each request that arrived hidden joins, by request. */
    const arrivals = new WeakMap<DomRequest, Map<string, Group>>()
    /** Each hidden period's own number, for the router's shared slots. */
    const periods = new WeakMap<Map<string, Group>, number>()
    let lastPeriod = 0
    const isOrderWrite = (r: { method: string; path: string }) =>
      r.method === 'POST' && ORDER_WRITE_PATHS.has(r.path)
    const groupKey = (r: DomRequest) =>
      `${r.method} ${r.path} ${stableJson({ q: r.query ?? null, b: r.body ?? null })}`
    /** The slot a request that waits through a hidden period shares with those identical to it,
     *  which go as one (coalesce); an order write, or one that arrived in front, has its own. */
    const slotKey = (r: DomRequest): string | null => {
      const groups = arrivals.get(r)
      if (!groups || isOrderWrite(r)) return null
      let n = periods.get(groups)
      if (n === undefined) {
        lastPeriod += 1
        n = lastPeriod
        periods.set(groups, n)
      }
      return `${n} ${groupKey(r)}`
    }

    /** Identical waiting requests go as one; an order write never merges with another. */
    const coalesce = (route: Route): Route => {
      if (isOrderWrite(route)) return route
      return {
        ...route,
        handle(r, signal) {
          const groups = arrivals.get(r)
          if (!groups) return route.handle(r, signal)
          const key = groupKey(r)
          let g = groups.get(key)
          if (!g) {
            const ctl = new AbortController()
            const made: Group = { ctl, members: 0, reply: route.handle(r, ctl.signal) }
            const drop = () => {
              if (groups.get(key) === made) groups.delete(key)
            }
            made.reply.then(drop, drop)
            groups.set(key, made)
            g = made
          }
          const group = g
          group.members++
          return new Promise<DomReply>((resolve, reject) => {
            const leave = () => {
              group.members--
              if (group.members === 0) group.ctl.abort()
            }
            if (signal.aborted) {
              leave()
              reject(abortError())
              return
            }
            const onAbort = () => {
              leave()
              reject(abortError())
            }
            signal.addEventListener('abort', onAbort, { once: true })
            group.reply
              .finally(() => signal.removeEventListener('abort', onAbort))
              .then(resolve, reject)
          })
        },
      }
    }

    const greeksOnServer = () => {
      const caps = s.caps.get()
      return caps !== null && gate(caps, 'optionchainGreeks').on
    }
    const routes: Route[] = [
      ...createStartupRoutes({
        seed: () => {
          const broker = currentBroker(s)
          return { broker, capabilities: brokerCaps(broker, s.caps.get()?.version ?? null) }
        },
        analyzer: () => trading.analyzer.read(),
        onErrorReport: () => {
          // the report itself is never read: it can hold the page's state
          const r = errorReports.current
          r.n++
          const now = Date.now()
          if (now - r.logged < ERROR_LOG_EVERY_MS) return
          r.logged = now
          log.info('tool', `${page} error reports ${r.n}`)
        },
      }),
      ...createToolRoutes(page, {
        api: s.api,
        deps: {
          options: trading.options,
          master: trading.master,
          api: s.api,
          now: () => s.clock.now(),
          greeksOnServer,
          // read when a route starts its work: the current load's
          get lifetime() {
            return lifetime.current.signal
          },
          progress: (p) => status.setState({ progress: p }),
          active: () => shown.current.active,
          untilActive: (signal) => untilActive(whenActive, signal),
          intervals: () => s.queryClient.fetchQuery(chartIntervalsQuery(s.api, s.profile.get().id)),
        },
        save: share,
        greeksOnServer,
      }),
      ...createHeldWriteRoutes(held, page, { reviewable: new Set(['placeorder']) }),
    ].map(coalesce)
    const route = createRequestRouter(routes, { whenActive, slotKey })
    const primary = PRIMARY_ROUTE[page]
    const long = longPaths(page)
    /** When each long pass still out started, by its own token. */
    const passes = new Map<object, number>()
    const noteLong = () =>
      status.setState({ longSince: passes.size === 0 ? null : Math.min(...passes.values()) })
    let loaded = false

    return {
      async request(r, hostSignal) {
        const ctl = new AbortController()
        const onAbort = () => ctl.abort()
        if (hostSignal.aborted) ctl.abort()
        else hostSignal.addEventListener('abort', onAbort, { once: true })
        controllers.add(ctl)
        if (!shown.current.active) arrivals.set(r, shown.current.groups)
        const isPrimary = r.method === 'POST' && r.path === primary
        const isLong = r.method === 'POST' && long.has(r.path)
        const pass = {}
        if (isPrimary) status.setState((st) => ({ updating: st.updating + 1 }))
        if (isLong) {
          passes.set(pass, Date.now())
          noteLong()
        }
        try {
          const reply = await route(r, ctl.signal)
          if (isPrimary) {
            const at = s.clock.now()
            status.setState({
              last:
                reply.status === 200
                  ? { ok: true, at }
                  : { ok: false, at, message: messageOf(reply) },
            })
          }
          return reply
        } catch (e) {
          // `reset` let go of it: the page is gone or loads again, and waits for nothing
          if (ctl.signal.aborted && !hostSignal.aborted) return REFUSED_REPLY
          throw e
        } finally {
          controllers.delete(ctl)
          hostSignal.removeEventListener('abort', onAbort)
          if (isPrimary) status.setState((st) => ({ updating: Math.max(0, st.updating - 1) }))
          if (isLong) {
            passes.delete(pass)
            noteLong()
          }
        }
      },
      socket: (m) => emulation.handle(m),
      intent: (m) => {
        // a tool page saves files; a chart's order or menu intent is never one of its own
        const i = m.intent
        if (i.type !== 'save') {
          log.warn('tool', `refused a ${i.type} intent from ${page}`)
          return
        }
        void share({ name: i.name, mime: i.mime, base64: i.base64 })
      },
      event: (e) => {
        if (e.name === 'loaded') {
          // the page loaded again on this host: what the last load held goes first
          if (loaded) reset()
          loaded = true
        }
        latest.current.onEvent(e)
      },
    }
  }, [
    o.outbox,
    s,
    trading,
    whenActive,
    emulation,
    held,
    reset,
    share,
    status,
    controllers,
    lifetime,
  ])

  return { handlers, held, reset, status }
}
