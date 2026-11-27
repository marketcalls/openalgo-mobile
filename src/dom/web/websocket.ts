// The tool pages' WebSocket (design 7.7): a class over plan D's socket channel, so a page's own
// socket code (the web's MarketDataManager) talks to native's emulation of the server protocol.
// Only DOM_WS_URL is a socket. Any other URL fails at once, with error and close(1006) and no
// bridge message; DOM_WS_URL fails the same way when native refuses it (polling mode), and the
// page takes its own REST fallback. Every close goes through CLOSING and is dispatched after the
// call that caused it returns, as a browser's is.
import { DOM_WS_URL } from '~/dom/bridge/protocol'
import type { DomClient } from './client'
import { createSocketChannel } from './socket'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

const EVENTS = ['open', 'message', 'error', 'close'] as const
/** The page's close() named no code (RFC 6455 7.1.5). */
const NO_STATUS = 1005
/** No close frame: the connection failed, or native ended it. */
const ABNORMAL = 1006

type Handler = ((this: unknown, e: Event) => unknown) | null
type Conn = { send(data: string): void; close(): void }
/** How a socket ends: closed by the page; failed (never connected); dropped by native. */
type End = 'closed' | 'failed' | 'dropped'

export function createBridgedWebSocket(client: DomClient): typeof WebSocket {
  const channel = createSocketChannel(client)

  class BridgedWebSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING
    static readonly OPEN = OPEN
    static readonly CLOSING = CLOSING
    static readonly CLOSED = CLOSED
    readonly CONNECTING = CONNECTING
    readonly OPEN = OPEN
    readonly CLOSING = CLOSING
    readonly CLOSED = CLOSED

    onopen: Handler = null
    onmessage: Handler = null
    onerror: Handler = null
    onclose: Handler = null
    readonly url: string
    readonly protocol = ''
    readonly extensions = ''
    readonly bufferedAmount = 0
    binaryType: BinaryType = 'blob'
    readyState = CONNECTING

    private conn: Conn | null = null
    private ended = false

    constructor(url: string | URL, _protocols?: string | string[]) {
      super()
      // The on<event> handlers work as a browser's event handler attributes: as listeners.
      for (const type of EVENTS) {
        this.addEventListener(type, (e) => {
          const h = this[`on${type}`]
          if (typeof h === 'function') h.call(this, e)
        })
      }
      this.url = String(url)
      if (this.url !== DOM_WS_URL) {
        this.end('failed')
        return
      }
      this.conn = channel.open(this.url, {
        onOpen: () => {
          this.readyState = OPEN
          this.dispatchEvent(new Event('open'))
        },
        onMessage: (data) => this.dispatchEvent(new MessageEvent('message', { data })),
        // native's close, or its refusal of the open; a close() by the page has ended it already
        onClose: () => this.end(this.readyState === OPEN ? 'dropped' : 'failed'),
      })
    }

    send(data: string): void {
      if (this.readyState === CONNECTING) {
        throw new DOMException('openalgo-mobile: the socket is not open yet', 'InvalidStateError')
      }
      if (typeof data !== 'string') throw new TypeError('openalgo-mobile: a socket sends text only')
      // a closing or closed socket drops what it is given, as a browser's does
      if (this.readyState === OPEN) this.conn?.send(data)
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(`openalgo-mobile: ${code} is not a close code`, 'InvalidAccessError')
      }
      if (this.readyState >= CLOSING) return
      // Closed before it opened, the connection fails; an open one closes cleanly.
      if (this.readyState === CONNECTING) this.end('failed')
      else this.end('closed', code ?? NO_STATUS, reason ?? '')
      this.conn?.close()
    }

    private end(how: End, code = ABNORMAL, reason = ''): void {
      if (this.ended) return
      this.ended = true
      this.readyState = CLOSING
      queueMicrotask(() => {
        this.readyState = CLOSED
        if (how === 'failed') this.dispatchEvent(new Event('error'))
        this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: how === 'closed' }))
      })
    }
  }
  return BridgedWebSocket as unknown as typeof WebSocket
}
