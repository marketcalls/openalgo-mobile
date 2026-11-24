import type { SocketLike } from '~/core/realtime/handshake'

/**
 * A WebSocket the test plays the server for. Nothing happens on its own: the test opens it,
 * sends it frames and closes it. A client-side `close()` only records the code; the close event
 * arrives when the test calls `serverClose`, as it would later on a real socket.
 */
export class FakeSocket implements SocketLike {
  readonly url: string
  readyState = 0
  /** Every frame the client sent, as written. */
  readonly sent: string[] = []
  /** The code the client closed with; undefined while the client has not closed it. */
  closeCode: number | undefined
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onerror: SocketLike['onerror'] = null
  onclose: SocketLike['onclose'] = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error('INVALID_STATE_ERR')
    this.sent.push(data)
  }

  close(code?: number) {
    this.closeCode = code ?? 1005
    this.readyState = 3
  }

  /** The frames sent, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((f) => JSON.parse(f))
  }

  /** The `action` of each frame sent, in order. */
  actions(): unknown[] {
    return this.frames().map((f) => f.action)
  }

  serverOpen() {
    this.readyState = 1
    this.onopen?.({})
  }

  /** Delivers a frame; anything but a string is sent as JSON. */
  serverSend(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  serverClose(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

/** A WebSocket constructor whose sockets are recorded in `sockets`, in the order opened. */
export function fakeSockets() {
  const sockets: FakeSocket[] = []
  class Socket extends FakeSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  return {
    WebSocketImpl: Socket,
    sockets,
    last(): FakeSocket {
      const s = sockets.at(-1)
      if (!s) throw new Error('no socket was opened')
      return s
    },
  }
}

export const AUTH_OK = {
  type: 'auth',
  status: 'success',
  message: 'Authentication successful',
  broker: 'zerodha',
  user_id: 'u1',
  supported_features: { ltp: true, quote: true, depth: true },
}
export const PONG = { type: 'pong', status: 'success', server_timestamp: 1732421234000 }

export const wsError = (code: string, message = '') => ({ status: 'error', code, message })
