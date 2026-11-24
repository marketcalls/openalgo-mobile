// The live-feed test (design 7.1 step 4): authenticate within 15 s, then ping. Onboarding runs
// it three times before choosing polling; the realtime client runs it once to leave polling.
import type { SetTimer } from '~/core/http/scheduler'
import { log } from '~/core/log/logger'
import { authMsg, parseInbound, pingMsg } from './protocol'

// Handlers take their event bivariantly, so React Native's, the DOM's and `ws`'s sockets all fit.
type Handler<E> = { bivarianceHack(ev: E): void }['bivarianceHack']

/** What the client needs of a WebSocket. */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: Handler<unknown> | null
  onmessage: Handler<{ data: unknown }> | null
  onerror: Handler<unknown> | null
  onclose: Handler<{ code: number; reason?: string }> | null
}
export type WebSocketCtor = new (url: string) => SocketLike

export type HandshakeResult =
  | { ok: true; broker: string | null; ping: boolean }
  | { ok: false; reason: 'timeout' | 'closed' | 'auth_error' | 'broker_error'; closeCode?: number }

export type HandshakeOptions = {
  WebSocketImpl: WebSocketCtor
  attempts?: number
  /** From the socket's creation to auth_ok. */
  authTimeoutMs?: number
  /** From the ping to its answer. */
  pongTimeoutMs?: number
  setTimer?: SetTimer
}

const TAG = 'ws'

export const defaultTimer: SetTimer = (fn, ms) => {
  const h = setTimeout(fn, ms)
  return () => clearTimeout(h)
}

// `ws` in Node throws on an 'error' event nobody listens to, so a detached socket keeps one.
const ignore = () => {}

/** Drops every handler but a silent onerror; with `close`, also closes the socket with 1000. */
export function detach(s: SocketLike, close: boolean) {
  s.onopen = null
  s.onmessage = null
  s.onclose = null
  s.onerror = ignore
  if (!close) return
  try {
    s.close(1000)
  } catch {}
}

/**
 * Tries the live feed up to `attempts` times, waiting 1 s, then 2 s (doubling) between them.
 * A key or broker error ends it at once: trying again cannot help.
 */
export async function testLiveFeed(
  url: string,
  key: string,
  {
    WebSocketImpl,
    attempts = 3,
    authTimeoutMs = 15_000,
    pongTimeoutMs = 10_000,
    setTimer = defaultTimer,
  }: HandshakeOptions,
): Promise<HandshakeResult> {
  let result: HandshakeResult = { ok: false, reason: 'timeout' }
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise<void>((r) => setTimer(r, 1000 * 2 ** (i - 1)))
    result = await attempt(url, key, WebSocketImpl, authTimeoutMs, pongTimeoutMs, setTimer)
    if (result.ok) return result
    log.info(TAG, `live-feed test ${i + 1}/${attempts}: ${result.reason}`)
    if (result.reason === 'auth_error' || result.reason === 'broker_error') return result
  }
  return result
}

function attempt(
  url: string,
  key: string,
  WebSocketImpl: WebSocketCtor,
  authTimeoutMs: number,
  pongTimeoutMs: number,
  setTimer: SetTimer,
): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    let s: SocketLike
    try {
      s = new WebSocketImpl(url)
    } catch {
      resolve({ ok: false, reason: 'closed' })
      return
    }
    let broker: string | null = null
    let authed = false
    let cancel = setTimer(() => finish({ ok: false, reason: 'timeout' }), authTimeoutMs)

    function finish(r: HandshakeResult) {
      cancel()
      detach(s, true)
      resolve(r)
    }

    s.onerror = ignore // the close event follows
    s.onclose = (ev) => finish({ ok: false, reason: 'closed', closeCode: ev.code })
    s.onopen = () => {
      try {
        s.send(authMsg(key))
      } catch {}
    }
    s.onmessage = (ev) => {
      const m = typeof ev.data === 'string' ? parseInbound(ev.data) : null
      if (m?.t === 'error') {
        if (m.code === 'AUTHENTICATION_ERROR') finish({ ok: false, reason: 'auth_error' })
        else if (m.code.startsWith('BROKER_')) finish({ ok: false, reason: 'broker_error' })
        // Only the ping can be refused once authenticated: the feed works without it.
        else if (authed && m.code === 'INVALID_ACTION') finish({ ok: true, broker, ping: false })
      } else if (m?.t === 'auth_ok' && !authed) {
        authed = true
        broker = m.broker ?? null
        cancel()
        cancel = setTimer(() => finish({ ok: false, reason: 'timeout' }), pongTimeoutMs)
        try {
          s.send(pingMsg())
        } catch {}
      } else if (m?.t === 'pong' && authed) {
        finish({ ok: true, broker, ping: true })
      }
    }
  })
}
