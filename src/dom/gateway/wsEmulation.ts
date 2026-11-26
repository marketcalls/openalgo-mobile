// The WebSocket a DOM page opens (design 7.7), emulated over the app's own socket. The page never
// holds the key or a socket: it opens DOM_WS_URL by sid, and native answers as the server's proxy
// would (websocket_proxy/server.py at c8b2896). Authentication succeeds locally; each subscription
// is a hold on the app's subscription manager, and the tick store's flushes come back as
// market_data frames. Holds live until the page unsubscribes or closes, or closeAll(): a lock, a
// 1012 or a reconnect of the app's feed never closes a DOM socket (RF 4).
import { hasExchangeHours, isExchangeOpen } from '~/core/realtime/marketHours'
import type { OrderEventBus } from '~/core/realtime/orderEvents'
import type { PollingEngine } from '~/core/realtime/polling'
import {
  type DepthLevel,
  type DepthLevels,
  type Mode,
  type OrderUpdate,
  type Quote,
  quoteKey,
} from '~/core/realtime/protocol'
import type { TickStore } from '~/core/realtime/tickStore'
import type { Realtime } from '~/core/realtime/wsClient'
import { DOM_WS_URL, type DomSocketMsg, type NativeToDom } from '~/dom/bridge/protocol'
import { ALL_EXCHANGES } from '~/market/instruments/exchanges'

/** The symbols one DOM socket may hold, whatever their modes. */
export const MAX_DOM_SYMBOLS = 50
/** The sockets one page may hold open at once; one more is closed as it opens. */
export const MAX_DOM_SOCKETS_PER_PAGE = 4
/**
 * The distinct symbols one page may hold across its sockets: what it can take of the app's own
 * subscription budget (a symbol costs one slot there whatever its modes and sockets). While it
 * equals MAX_DOM_SOCKETS_PER_PAGE × MAX_DOM_SYMBOLS it refuses only the symbol past a full page;
 * it bounds the page alone once either is raised. Raise any of the three only by constant.
 */
export const MAX_DOM_PAGE_SYMBOLS = 200

export type EmulationDeps = {
  realtime: Pick<Realtime, 'acquire' | 'status' | 'onStatus'>
  store: Pick<TickStore, 'get' | 'subscribe'>
  polling: Pick<PollingEngine, 'register'>
  orderEvents: Pick<OrderEventBus, 'subscribe'>
  feedMode: () => 'live' | 'polling'
  /** 'relay' feeds the page from polling; 'fail' closes its sockets while the app polls. */
  whenPolling: 'relay' | 'fail'
  /** The screen is shown; passed to polling.register. */
  active: () => boolean
  post: (m: NativeToDom) => void
  /** Must agree with the clock TickStore.put stamps quotes with. Defaults to Date.now. */
  now?: () => number
  /**
   * Whether an exchange is in session at `now`: under 'relay' a polled quote is framed only
   * then. Null when there is no known session window for it, and its quotes are not filtered.
   * Defaults to the app's fixed hours (isExchangeOpen); the chart screen passes its calendar.
   */
  isOpen?: (exchange: string, now: number) => boolean | null
}

export type WsEmulation = {
  handle(m: DomSocketMsg): void
  /** The page is gone or reloads: every socket's holds go, and nothing is posted. */
  closeAll(): void
  openSockets(): number
}

const MAX_SYMBOL = 64
/** The server's own name for a broker it cannot tell. */
const NO_BROKER = 'unknown'
const LABELS: Record<Mode, string> = { 1: 'LTP', 2: 'Quote', 3: 'Depth' }
const BY_LABEL: Record<string, Mode> = { LTP: 1, QUOTE: 2, DEPTH: 3 }
const EXCHANGES: ReadonlySet<string> = new Set(ALL_EXCHANGES)

type Json = Record<string, unknown>
/**
 * The store's last ltp and ltt this subscription saw. The store merges patches, so a ws price
 * that came without a trade time keeps an earlier trade's: `stale` from then until a new ltt.
 * An ltt from before the subscribe is stale from the start: it is never framed.
 */
type Seen = { ltp?: number; ltt?: number; stale: boolean }
/** What one subscription frames: its symbol at its mode, from the time it was made. */
type Sub = {
  key: string
  exchange: string
  symbol: string
  mode: Mode
  since: number
  seen: Seen
}
type Hold = Sub & { stop: () => void }
type Socket = {
  authed: boolean
  /** Keyed `${key}|${mode}`: the chart holds LTP and Depth on one symbol. */
  holds: Map<string, Hold>
  orders: (() => void) | null
}

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x)
/** A symbol and an exchange, both non-empty strings: the server skips a pair without them. */
const isPair = (x: unknown): x is Json & { symbol: string; exchange: string } =>
  isObj(x) &&
  typeof x.symbol === 'string' &&
  typeof x.exchange === 'string' &&
  x.symbol !== '' &&
  x.exchange !== ''
/** The app's fixed hours, for the exchanges it has them for. */
const fixedHours = (exchange: string, now: number) =>
  hasExchangeHours(exchange) ? isExchangeOpen(exchange, now) : null
const error = (code: string, message: string) => ({ status: 'error', code, message })
const NOT_AUTHENTICATED = error('NOT_AUTHENTICATED', 'You must authenticate first')

/** The server's normalize_mode (websocket_proxy/mode_utils.py): 1-3, or a label in any case. */
function modeOf(v: unknown): Mode | null {
  if (v === 1 || v === 2 || v === 3) return v
  return typeof v === 'string' ? (BY_LABEL[v.trim().toUpperCase()] ?? null) : null
}
const INVALID_MODE = error(
  'INVALID_MODE',
  'Invalid mode; expected 1 (LTP), 2 (Quote), or 3 (Depth)',
)

/** `depth`, else `depth_level` (the library sends both); a level the app's feed has, else 5. */
function depthOf(data: Json): DepthLevels {
  const v = data.depth ?? data.depth_level
  return v === 20 || v === 30 ? v : 5
}

/** The pairs a request names: its `symbols` list, else its own symbol and exchange. */
function pairsOf(data: Json): unknown[] {
  if (Array.isArray(data.symbols) && data.symbols.length > 0) return data.symbols
  return data.symbol && data.exchange ? [{ symbol: data.symbol, exchange: data.exchange }] : []
}

const levels = (a: DepthLevel[]) =>
  a.map((l) => ({ price: l.price, quantity: l.quantity, orders: l.orders }))

export function createWsEmulation(d: EmulationDeps): WsEmulation {
  const now = d.now ?? Date.now
  const isOpen = d.isOpen ?? fixedHours
  const sockets = new Map<number, Socket>()
  let unwatch: (() => void) | null = null

  const broker = () => d.realtime.status().broker ?? NO_BROKER
  const isPolling = () => d.feedMode() === 'polling' || d.realtime.status().state === 'polling'
  const send = (sid: number, frame: object) =>
    d.post({ kind: 'socket', sid, event: 'message', data: JSON.stringify(frame) })

  /**
   * One hold's frame data, or null when there is nothing to send. JSON.stringify drops the
   * undefined fields, so what the quote lacks is absent from the frame.
   */
  function dataOf(q: Quote, mode: Mode, stale: boolean): Json | null {
    // RF 5's sibling (preflight conflict 5): the store merges patches, so a book from an earlier
    // ws Depth stream survives under polled quotes. Only a live ws quote's book is the market's.
    const book = mode === 3 && q.source === 'ws' && d.feedMode() === 'live' ? q.depth : undefined
    if (q.ltp === undefined && !book) return null
    // A polled quote's ltt, or one a newer ws price came without, is a trade time the merge
    // kept: the library would put the new price on that trade's bar.
    const out: Json = { ltp: q.ltp, ltt: q.source === 'ws' && !stale ? q.ltt : undefined }
    if (mode === 2) {
      Object.assign(out, {
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
        oi: q.oi,
        average_price: q.avgPrice,
        bid: q.bid,
        ask: q.ask,
      })
    } else if (mode === 3) {
      // An empty book is still a depth event to the library, so the panel gets the LTP.
      out.depth = book ? { buy: levels(book.buy), sell: levels(book.sell) } : { buy: [], sell: [] }
      if (book) {
        out.total_buy_quantity = q.totalBuyQty
        out.total_sell_quantity = q.totalSellQty
      }
    }
    return out
  }

  /** Notes what the store holds now; true while its ltt is a trade before its ltp. */
  function staleLtt(seen: Seen, q: Quote | undefined): boolean {
    if (q?.ltt !== seen.ltt) seen.stale = false
    else if (q?.ltp !== seen.ltp) seen.stale = true
    seen.ltp = q?.ltp
    seen.ltt = q?.ltt
    return seen.stale
  }

  /** The store flushed the subscription's key: one frame, if the quote is one it may see. */
  function onFlush(sid: number, h: Sub) {
    const q = d.store.get(h.key)
    const stale = staleLtt(h.seen, q)
    // RF 5: no stored or seed quote, only ticks from the subscribe on.
    if (!q || q.source === 'seed' || q.ts < h.since) return
    // Polling goes on outside the session, only slower: no candle after the close. An exchange
    // with no known session window is not filtered.
    if (q.source === 'poll' && d.whenPolling === 'relay' && isOpen(h.exchange, now()) === false) {
      return
    }
    const data = dataOf(q, h.mode, stale)
    if (!data) return
    send(sid, {
      type: 'market_data',
      symbol: h.symbol,
      exchange: h.exchange,
      mode: h.mode,
      broker: broker(),
      data,
    })
  }

  function hold(
    sid: number,
    s: Socket,
    exchange: string,
    symbol: string,
    mode: Mode,
    depth: DepthLevels,
  ) {
    const key = quoteKey(exchange, symbol)
    const q = d.store.get(key)
    // An ltt already in the store may sit under a newer ltp (another stream's ltp-only patch),
    // and the hold cannot tell: it is stale until a new one. So is a repeated subscribe's.
    const seen: Seen = { ltp: q?.ltp, ltt: q?.ltt, stale: q?.ltt !== undefined }
    const sub: Sub = { key, exchange, symbol, mode, since: now(), seen }
    const release = d.realtime.acquire(
      mode === 3 ? { exchange, symbol, mode, depth } : { exchange, symbol, mode },
    )
    const unpoll =
      d.whenPolling === 'relay'
        ? d.polling.register({ kind: 'quotes', keys: () => [key] }, d.active)
        : null
    const unlisten = d.store.subscribe(key, () => onFlush(sid, sub))
    // A repeated subscribe replaces the hold, after the new one is in place.
    const hk = `${key}|${mode}`
    const prev = s.holds.get(hk)
    s.holds.set(hk, {
      ...sub,
      stop: () => {
        unlisten()
        unpoll?.()
        release()
      },
    })
    prev?.stop()
  }

  function subscribe(sid: number, s: Socket, data: Json) {
    const mode = modeOf('mode' in data ? data.mode : 'Quote')
    if (mode === null) return send(sid, INVALID_MODE)
    const pairs = pairsOf(data)
    if (pairs.length === 0) {
      return send(sid, error('INVALID_PARAMETERS', 'At least one symbol must be specified'))
    }
    const depth = depthOf(data)
    const b = broker()
    const entries: Json[] = []
    const keysOf = (x: Socket) => Array.from(x.holds.values(), (h) => h.key)
    const symbols = new Set(keysOf(s))
    const page = new Set(Array.from(sockets.values()).flatMap(keysOf))
    for (const p of pairs) {
      if (!isPair(p)) continue
      const { symbol, exchange } = p
      const refuse = (message: string) =>
        entries.push({ symbol, exchange, status: 'error', message, broker: b })
      const key = quoteKey(exchange, symbol)
      if (!EXCHANGES.has(exchange)) refuse('Invalid exchange')
      else if (symbol.length > MAX_SYMBOL) refuse('Invalid symbol')
      else if (!page.has(key) && page.size >= MAX_DOM_PAGE_SYMBOLS) {
        refuse(`At most ${MAX_DOM_PAGE_SYMBOLS} symbols per page`)
      } else if (!symbols.has(key) && symbols.size >= MAX_DOM_SYMBOLS) {
        refuse(`At most ${MAX_DOM_SYMBOLS} symbols per connection`)
      } else {
        hold(sid, s, exchange, symbol, mode, depth)
        symbols.add(key)
        page.add(key)
        entries.push({
          symbol,
          exchange,
          status: 'success',
          mode: LABELS[mode],
          ...(mode === 3 ? { depth } : {}),
          broker: b,
        })
      }
    }
    send(sid, {
      type: 'subscribe',
      status: entries.every((e) => e.status === 'success') ? 'success' : 'partial',
      subscriptions: entries,
      message: 'Subscription processing complete',
      broker: b,
    })
  }

  function unsubscribe(sid: number, s: Socket, data: Json, all: boolean) {
    const b = broker()
    const successful: Json[] = []
    const failed: Json[] = []
    const done = (h: Pick<Hold, 'symbol' | 'exchange' | 'mode'>) =>
      successful.push({
        symbol: h.symbol,
        exchange: h.exchange,
        mode: LABELS[h.mode],
        status: 'success',
        broker: b,
      })
    if (all) {
      for (const h of s.holds.values()) {
        h.stop()
        done(h)
      }
      s.holds.clear()
    } else {
      let items: unknown[] = Array.isArray(data.symbols) ? data.symbols : []
      if (items.length === 0 && data.symbol && data.exchange) {
        // The single form, with no mode, means Quote (the server's default of 2).
        const mode = modeOf('mode' in data ? data.mode : 2)
        if (mode === null) return send(sid, INVALID_MODE)
        items = [{ symbol: data.symbol, exchange: data.exchange, mode }]
      }
      if (items.length === 0) {
        return send(
          sid,
          error('INVALID_PARAMETERS', 'Either symbols or unsubscribe_all is required'),
        )
      }
      for (const item of items) {
        if (!isObj(item)) continue
        // A symbol's own mode, else the request's, else Quote.
        const mode = modeOf('mode' in item ? item.mode : 'mode' in data ? data.mode : 2)
        if (mode === null) {
          failed.push({
            symbol: item.symbol,
            exchange: item.exchange,
            mode: null,
            status: 'error',
            message: INVALID_MODE.message,
            broker: b,
          })
          continue
        }
        if (!isPair(item)) continue
        const { symbol, exchange } = item
        // The server answers success for a subscription the client does not hold.
        const hk = `${quoteKey(exchange, symbol)}|${mode}`
        s.holds.get(hk)?.stop()
        s.holds.delete(hk)
        done({ symbol, exchange, mode })
      }
    }
    send(sid, {
      type: 'unsubscribe',
      status: failed.length === 0 ? 'success' : successful.length > 0 ? 'partial' : 'error',
      message: 'Unsubscription processing complete',
      successful,
      failed,
      broker: b,
    })
  }

  function orderFrame(u: OrderUpdate) {
    // The server's field names; the parser's tag and the user stay in the app (conflict 15).
    const { t: _t, user_id: _user, ...fields } = u
    return { type: 'order_update', ...fields }
  }

  function receive(sid: number, s: Socket, raw: string) {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      data = undefined
    }
    if (!isObj(data)) return send(sid, error('INVALID_JSON', 'Invalid JSON message'))
    const action = data.action || data.type
    switch (action) {
      case 'authenticate':
      case 'auth':
        s.authed = true
        return send(sid, {
          type: 'auth',
          status: 'success',
          message: 'Authentication successful',
          broker: broker(),
          user_id: null,
        })
      case 'ping':
        // Answered here, before any auth check like the server's; never sent upstream.
        return send(sid, { type: 'pong', status: 'success', server_timestamp: now() })
      case 'subscribe':
      case 'unsubscribe':
      case 'unsubscribe_all':
      case 'subscribe_orders':
      case 'unsubscribe_orders':
        if (!s.authed) return send(sid, NOT_AUTHENTICATED)
        if (action === 'subscribe') return subscribe(sid, s, data)
        if (action === 'subscribe_orders') {
          s.orders ??= d.orderEvents.subscribe((u) => send(sid, orderFrame(u)))
          return send(sid, {
            type: 'subscribe_orders',
            status: 'success',
            message: 'Subscribed to order updates',
          })
        }
        if (action === 'unsubscribe_orders') {
          s.orders?.()
          s.orders = null
          return send(sid, {
            type: 'unsubscribe_orders',
            status: 'success',
            message: 'Unsubscribed from order updates',
          })
        }
        return unsubscribe(sid, s, data, action === 'unsubscribe_all')
      default:
        return send(sid, error('INVALID_ACTION', `Invalid action: ${String(action)}`))
    }
  }

  /** Lets go of a socket's holds and order stream. `notify` tells the page it closed. */
  function end(sid: number, notify: boolean) {
    const s = sockets.get(sid)
    if (!s) return
    sockets.delete(sid)
    for (const h of s.holds.values()) h.stop()
    s.holds.clear()
    s.orders?.()
    s.orders = null
    if (notify) d.post({ kind: 'socket', sid, event: 'close' })
    if (sockets.size === 0) {
      unwatch?.()
      unwatch = null
    }
  }

  /** Under 'fail', a feed that turns to polling closes every socket, while any is open. */
  function watch() {
    if (d.whenPolling !== 'fail' || unwatch) return
    unwatch = d.realtime.onStatus(() => {
      if (!isPolling()) return
      for (const sid of Array.from(sockets.keys())) end(sid, true)
    })
  }

  function open(sid: number, url: string) {
    // A reloaded page numbers its sockets afresh: the old socket on this sid goes silently, so
    // no close reaches the new page's socket.
    end(sid, false)
    if (
      url !== DOM_WS_URL ||
      (d.whenPolling === 'fail' && isPolling()) ||
      sockets.size >= MAX_DOM_SOCKETS_PER_PAGE
    ) {
      d.post({ kind: 'socket', sid, event: 'close' })
      return
    }
    sockets.set(sid, { authed: false, holds: new Map(), orders: null })
    watch()
    d.post({ kind: 'socket', sid, event: 'open' })
  }

  return {
    handle(m) {
      if (m.op === 'open') return open(m.sid, m.url)
      const s = sockets.get(m.sid)
      if (!s) return // closed, or never opened: nothing answers
      if (m.op === 'send') receive(m.sid, s, m.data)
      else end(m.sid, false)
    },
    closeAll() {
      for (const sid of Array.from(sockets.keys())) end(sid, false)
    },
    openSockets: () => sockets.size,
  }
}
