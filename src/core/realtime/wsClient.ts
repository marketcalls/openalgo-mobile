// The live feed (design 7.6): one socket per server, authenticated with the api key, kept alive
// with application pings, reconnected with backoff, and handed to polling when it cannot be had.
import type { CapabilityStore } from '~/core/capabilities/store'
import type { SetTimer } from '~/core/http/scheduler'
import { log } from '~/core/log/logger'
import type { BrokerSession } from '~/core/services/connection'
import {
  defaultTimer,
  detach,
  type SocketLike,
  testLiveFeed,
  type WebSocketCtor,
} from './handshake'
import {
  authMsg,
  type Inbound,
  type OrderUpdate,
  parseInbound,
  pingMsg,
  quoteKey,
  subscribeOrdersMsg,
  tickToPatch,
} from './protocol'
import { createSubscriptionManager, type SubRequest } from './subscriptions'
import type { TickStore } from './tickStore'
import type { FeedState } from './types'

export type { SocketLike, WebSocketCtor }

export type FeedStatus = {
  state: FeedState
  /** The code of the last close the server sent; null before any. */
  lastCloseCode: number | null
  /** Consecutive failed connections; auth_ok and a 1012 close reset it. */
  failures: number
  /** The feed has been live at least once since this client was made. */
  everLive: boolean
  /** From the last auth_ok. */
  broker: string | null
}

export type RealtimeConfig = {
  /** From the socket's creation to auth_ok. */
  authTimeoutMs: number
  pingEveryMs: number
  /** After a ping, the wait for any frame. */
  pongTimeoutMs: number
  backgroundDropMs: number
  silenceMs: number
  watchdogEveryMs: number
  maxReconnectsBeforePolling: number
  pollingRetryMs: number
}

export const REALTIME_DEFAULTS: Readonly<RealtimeConfig> = Object.freeze({
  authTimeoutMs: 15_000,
  pingEveryMs: 25_000,
  pongTimeoutMs: 10_000,
  backgroundDropMs: 30_000,
  silenceMs: 60_000,
  watchdogEveryMs: 15_000, // ruling 12
  maxReconnectsBeforePolling: 10,
  pollingRetryMs: 600_000,
})

export type RealtimeDeps = {
  /** The profile's live-feed URL; none means polling. */
  url: () => string | null | undefined
  feedMode: () => 'live' | 'polling'
  /** Throws while the vault is locked. */
  getKey: () => string
  WebSocketImpl: WebSocketCtor
  /** The profile's last live-feed retry (ms), which seeds the 10-minute window. */
  lastFeedRetryAt: () => number | null
  store: Pick<TickStore, 'put' | 'setStale' | 'lastWsTickAt' | 'dropDepth'>
  caps: Pick<CapabilityStore, 'ws' | 'setWs'>
  isExchangeOpen: (exchange: string, now: number) => boolean
  /** S11: a BROKER_* code is not proof of logout, so the session is checked. */
  onBrokerError: (code: string) => Promise<BrokerSession>
  onKeyInvalid: () => void
  on1012: () => void
  onSilence: () => void
  onOrderUpdate: (u: OrderUpdate) => void
  /** The socket was down while the app was away: the books may be behind. */
  onResync: () => void
  /** A retry from polling ended, or (ruling 7) the reconnects ran out: store it on the profile. */
  onPollingRetry: (ok: boolean) => void
  /**
   * The phone's network (NetInfo, through TanStack's onlineManager). A socket that fails while
   * offline says nothing about the feed, so it is not counted. Defaults to online.
   */
  isOnline?: () => boolean
  /**
   * Whether REST reached the server lately. False (its requests got no reply) means the server is
   * out of reach, not just its feed, so the reconnects never hand off to polling. True, or null
   * with nothing to go on, lets them (RF 4).
   */
  serverReachable?: () => boolean | null
  /** Must agree with the clock the tick store stamps ticks with (Date.now). */
  now?: () => number
  setTimer?: SetTimer
  config?: Partial<RealtimeConfig>
}

export type Realtime = {
  /** Connects, unless the feed is already running or the profile is in polling mode. */
  start(): void
  /** Closes the socket and cancels everything; start() connects afresh. */
  stop(): void
  setAppState(s: 'active' | 'background'): void
  /** The network is back: a reconnect waiting out its backoff goes now; polling may retry (B8). */
  networkBack(): void
  acquire(r: SubRequest): () => void
  /** The feed is live and carries this symbol. */
  isLive(exchange: string, symbol: string): boolean
  confirmedDepth(exchange: string, symbol: string): number | undefined
  status(): FeedStatus
  onStatus(fn: (s: FeedStatus) => void): () => void
}

const TAG = 'ws'
const OPEN = 1
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const ORDER_UPDATES_KEPT = 500
/** A socket is open or a reconnect is on the way. */
const RUNNING: ReadonlySet<FeedState> = new Set([
  'connecting',
  'authenticating',
  'live',
  'reconnecting',
])

type TimerName = 'auth' | 'ping' | 'pong' | 'watchdog' | 'reconnect' | 'drop' | 'retry'
const SOCKET_TIMERS = ['auth', 'ping', 'pong', 'watchdog'] as const

export function createRealtime(d: RealtimeDeps): Realtime {
  const cfg: RealtimeConfig = { ...REALTIME_DEFAULTS, ...d.config }
  const now = d.now ?? Date.now
  const setTimer = d.setTimer ?? defaultTimer
  const subs = createSubscriptionManager({
    send: (frame) => send(frame),
    onDowngrade: (key) => d.store.dropDepth(key),
    setTimer,
  })

  let status: FeedStatus = {
    state: 'idle',
    lastCloseCode: null,
    failures: 0,
    everLive: false,
    broker: null,
  }
  const listeners = new Set<(s: FeedStatus) => void>()
  const timers = new Map<TimerName, () => void>()
  let sock: SocketLike | null = null
  /** Bumped whenever the socket goes: an async result from before it is stale. */
  let epoch = 0
  let appState: 'active' | 'background' = 'active'
  /** The background drop closed the feed; the next `active` reopens it. */
  let suspended = false
  /** The reconnects ran out (B7): only a polling retry brings the feed back. */
  let handedOff = false
  let retrying = false
  let lastRetryAt: number | null = null
  let liveAt = 0
  let silenceFires = 0
  const ordersSeen = new Set<string>()
  const ordersOrder: string[] = []

  function update(patch: Partial<FeedStatus>) {
    const next = { ...status, ...patch }
    const keys = Object.keys(next) as (keyof FeedStatus)[]
    if (keys.every((k) => next[k] === status[k])) return
    const stateChanged = next.state !== status.state
    status = next
    if (stateChanged) {
      log.info(TAG, `state ${next.state}`)
      // B11, ruling 8: polling prices are fresh too.
      d.store.setStale(next.state !== 'live' && next.state !== 'polling')
    }
    for (const fn of Array.from(listeners)) fn(next)
  }

  function arm(name: TimerName, fn: () => void, ms: number) {
    timers.get(name)?.()
    timers.set(
      name,
      setTimer(() => {
        timers.delete(name)
        fn()
      }, ms),
    )
  }

  function cancel(name: TimerName) {
    timers.get(name)?.()
    timers.delete(name)
  }

  function send(frame: string) {
    if (sock?.readyState !== OPEN) return
    try {
      sock.send(frame)
    } catch {} // the close event follows
  }

  /** Lets go of the socket: its timers stop and its subscriptions are gone. */
  function release(close: boolean) {
    epoch++
    for (const t of SOCKET_TIMERS) cancel(t)
    subs.connectionLost()
    const s = sock
    sock = null
    if (s) detach(s, close)
  }

  function open() {
    cancel('reconnect')
    cancel('retry')
    release(true)
    const url = d.url()
    if (!url) {
      update({ state: 'polling' })
      return
    }
    let s: SocketLike
    try {
      s = new d.WebSocketImpl(url)
    } catch {
      log.warn(TAG, 'the socket could not be made')
      fail()
      return
    }
    sock = s
    update({ state: 'connecting' })
    arm(
      'auth',
      () => {
        log.warn(TAG, 'no auth_ok in time')
        release(true)
        fail()
      },
      cfg.authTimeoutMs,
    )
    s.onerror = () => {} // the close event follows
    s.onopen = () => {
      if (s === sock) onOpen()
    }
    s.onmessage = (ev) => {
      if (s === sock && typeof ev.data === 'string') onFrame(ev.data)
    }
    s.onclose = (ev) => {
      if (s === sock) onClose(ev.code)
    }
    if (appState === 'background' && !timers.has('drop')) {
      arm('drop', suspend, cfg.backgroundDropMs)
    }
  }

  /**
   * Counts a failed connection, then reconnects with backoff (B7) or hands off to polling. RF 4's
   * handoff is for a feed that does not work: one that was live this session, a phone that is
   * offline and a server REST cannot reach either are waited out at the 30 s cap instead.
   */
  function fail() {
    if (d.isOnline?.() === false) {
      update({ state: 'reconnecting' })
      arm('reconnect', open, BACKOFF_MAX_MS)
      return
    }
    const failures = status.failures + 1
    if (
      failures >= cfg.maxReconnectsBeforePolling &&
      !status.everLive &&
      d.serverReachable?.() !== false
    ) {
      handedOff = true
      lastRetryAt = now()
      update({ state: 'polling', failures })
      log.warn(TAG, `no live feed after ${failures} attempts; polling`)
      d.onPollingRetry(false) // ruling 7: the handoff is stored like a failed retry
      armRetry()
      return
    }
    update({ state: 'reconnecting', failures })
    arm('reconnect', open, Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS))
  }

  function onOpen() {
    update({ state: 'authenticating' })
    let key: string
    try {
      key = d.getKey()
    } catch {
      log.warn(TAG, 'the key is locked away; the feed stops')
      release(true)
      update({ state: 'stopped' })
      return
    }
    send(authMsg(key))
    log.debug(TAG, '→ authenticate')
  }

  function onFrame(raw: string) {
    cancel('pong') // B4: any frame answers a ping
    const m = parseInbound(raw)
    if (!m) return
    if (m.t !== 'tick' && m.t !== 'pong') {
      log.debug(TAG, m.t === 'error' ? `← error ${m.code}` : `← ${m.t}`)
    }
    switch (m.t) {
      case 'auth_ok':
        return onAuthOk(m.broker)
      case 'error':
        return onError(m.code, m.message)
      case 'sub_ack':
        return subs.onAck(m)
      case 'unsub_ack':
        return subs.onUnsubAck()
      case 'tick':
        return onTick(m)
      case 'orders_ack':
        return d.caps.setWs({ orderStream: true })
      case 'order_update':
        return onOrderUpdate(m)
      case 'pong':
        return d.caps.setWs({ ping: true })
    }
  }

  function onAuthOk(broker: string | undefined) {
    if (status.state === 'live') return
    cancel('auth')
    liveAt = now()
    update({ state: 'live', failures: 0, everLive: true, ...(broker ? { broker } : {}) })
    subs.resendAll()
    if (d.caps.ws().orderStream !== false) send(subscribeOrdersMsg())
    schedulePing()
    scheduleWatchdog()
  }

  function onError(code: string, message: string) {
    if (code === 'AUTHENTICATION_ERROR') {
      release(true)
      update({ state: 'key_invalid' })
      d.onKeyInvalid()
    } else if (code.startsWith('BROKER_')) {
      void onBrokerError(code)
    } else if (code === 'NOT_AUTHENTICATED') {
      release(true)
      fail()
    } else if (code === 'INVALID_ACTION') {
      // The message names the refused action (S11).
      if (message.includes('subscribe_orders')) d.caps.setWs({ orderStream: false })
      else if (/\bping\b/.test(message)) d.caps.setWs({ ping: false })
    } else if (subs.onRequestError()) {
      // No ack came, so those symbols are not on the wire: polling covers them from here on.
      log.warn(TAG, `a subscribe was answered with ${code}; its symbols are polled`)
    }
  }

  async function onBrokerError(code: string) {
    release(true)
    update({ state: 'reconnecting' })
    const at = epoch
    let session: BrokerSession
    try {
      session = await d.onBrokerError(code)
    } catch {
      session = 'unknown'
    }
    if (at !== epoch) return
    if (session === 'logged_out') update({ state: 'broker_logged_out' })
    else fail()
  }

  function onTick(m: Extract<Inbound, { t: 'tick' }>) {
    const patch = tickToPatch(m.data)
    if (patch.depth) subs.noteDepthLevels(m.exchange, m.symbol, patch.depth.levels)
    d.store.put(quoteKey(m.exchange, m.symbol), patch, 'ws')
    silenceFires = 0
  }

  function onOrderUpdate(u: OrderUpdate) {
    const id = `${u.orderid}|${u.order_status ?? ''}|${u.filled_quantity ?? ''}`
    if (ordersSeen.has(id)) return
    ordersSeen.add(id)
    ordersOrder.push(id)
    if (ordersOrder.length > ORDER_UPDATES_KEPT) {
      const oldest = ordersOrder.shift()
      if (oldest !== undefined) ordersSeen.delete(oldest)
    }
    d.onOrderUpdate(u)
  }

  function onClose(code: number) {
    release(false)
    log.info(TAG, `closed ${code}`)
    if (code !== 1012) {
      update({ lastCloseCode: code })
      fail()
      return
    }
    update({ lastCloseCode: code, failures: 0 })
    d.on1012()
    open()
  }

  function schedulePing() {
    arm(
      'ping',
      () => {
        if (d.caps.ws().ping !== false) {
          send(pingMsg())
          arm(
            'pong',
            () => {
              log.warn(TAG, 'no frame after a ping')
              release(true)
              fail()
            },
            cfg.pongTimeoutMs,
          )
        }
        schedulePing()
      },
      cfg.pingEveryMs,
    )
  }

  function scheduleWatchdog() {
    arm(
      'watchdog',
      () => {
        checkSilence()
        if (status.state === 'live') scheduleWatchdog()
      },
      cfg.watchdogEveryMs,
    )
  }

  /**
   * B9: servers before 2.0.3.5 go silent on a broker re-login instead of closing 1012. Silence
   * counts from the later of the last tick and this connection's auth.
   */
  function checkSilence() {
    if (d.caps.ws().close1012 || status.state !== 'live') return
    const t = now()
    if (t - Math.max(d.store.lastWsTickAt(), liveAt) <= cfg.silenceMs) return
    const watched = subs
      .effective()
      .some((s) => subs.isWired(s.exchange, s.symbol) && d.isExchangeOpen(s.exchange, t))
    if (!watched) return
    silenceFires++
    if (silenceFires === 1) {
      log.warn(TAG, 'no ticks while the market is open; reconnecting')
      open()
    } else if (silenceFires === 2) {
      log.warn(TAG, 'still no ticks; checking the broker session')
      d.onSilence()
    }
  }

  function suspend() {
    if (!RUNNING.has(status.state)) return
    cancel('reconnect')
    release(true)
    suspended = true
    update({ state: 'idle' })
  }

  /** Since the last live-feed retry, this session's or the profile's; a clock set back is due. */
  function retryAge(): number {
    const last = Math.max(lastRetryAt ?? -Infinity, d.lastFeedRetryAt() ?? -Infinity)
    const age = now() - last
    return age >= 0 ? age : Infinity
  }

  /** B8 in the foreground: polling's next retry comes due on its own, at RF 4's rate. */
  function armRetry() {
    cancel('retry')
    if (appState !== 'active' || status.state !== 'polling' || !d.url()) return
    arm('retry', maybeRetry, Math.max(0, cfg.pollingRetryMs - retryAge()))
  }

  /** B8: from polling, one handshake at most every `pollingRetryMs`, counted from the profile. */
  function maybeRetry() {
    const url = d.url()
    if (retrying || !url || status.state !== 'polling') return
    if (retryAge() < cfg.pollingRetryMs) {
      armRetry()
      return
    }
    let key: string
    try {
      key = d.getKey()
    } catch {
      return
    }
    retrying = true
    lastRetryAt = now()
    const at = epoch
    log.info(TAG, 'retrying the live feed')
    void testLiveFeed(url, key, {
      WebSocketImpl: d.WebSocketImpl,
      attempts: 1,
      authTimeoutMs: cfg.authTimeoutMs,
      pongTimeoutMs: cfg.pongTimeoutMs,
      setTimer,
    }).then((r) => {
      retrying = false
      // Ruling 188: a BROKER_* answer proves the socket reaches OpenAlgo and takes the key, so
      // the feed is live with the broker logged out; the broker login then starts it at once.
      const reached = r.ok || r.reason === 'broker_error'
      d.onPollingRetry(reached)
      if (at !== epoch || status.state !== 'polling') return
      if (!reached) {
        armRetry()
        return
      }
      handedOff = false
      update({ failures: 0 })
      open()
    })
  }

  return {
    start() {
      if (RUNNING.has(status.state) || suspended) return
      silenceFires = 0
      if (!d.url() || handedOff || d.feedMode() === 'polling') {
        update({ state: 'polling' })
        armRetry()
        return
      }
      update({ failures: 0 })
      open()
    },

    stop() {
      cancel('reconnect')
      cancel('drop')
      cancel('retry')
      release(true)
      suspended = false
      handedOff = false
      silenceFires = 0
      update({ state: 'stopped', failures: 0 })
    },

    setAppState(s) {
      appState = s
      if (s === 'background') {
        cancel('retry')
        if (!suspended && !timers.has('drop')) arm('drop', suspend, cfg.backgroundDropMs)
        return
      }
      cancel('drop')
      if (suspended) {
        suspended = false
        open()
        d.onResync()
      } else if (status.state === 'polling') {
        maybeRetry()
      }
    },

    networkBack() {
      if (status.state === 'reconnecting' && timers.has('reconnect')) open()
      else if (status.state === 'polling') maybeRetry()
    },

    acquire: (r) => subs.acquire(r),
    isLive: (exchange, symbol) => status.state === 'live' && subs.isWired(exchange, symbol),
    confirmedDepth: (exchange, symbol) => subs.confirmedDepth(exchange, symbol),
    status: () => status,
    onStatus(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
