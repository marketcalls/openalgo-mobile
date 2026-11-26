// The page's sockets, emulated by native over the app's own socket (design 7.7). The page never
// holds a real socket: it opens DOM_WS_URL by sid, and native answers each sid's open, frames and
// close through the outbox. The channel is the base for every socket shape a page needs: the
// chart's SocketLike here, and plan E's WebSocket class.
import type { SocketLike } from 'openalgo-charts'
import { type DomClient, isOk } from './client'

export type SocketHandlers = { onOpen(): void; onMessage(d: string): void; onClose(): void }
export type SocketChannel = {
  open(url: string, h: SocketHandlers): { send(d: string): void; close(): void }
}

const ignore = () => {}

export function createSocketChannel(client: DomClient): SocketChannel {
  return {
    open(url, h) {
      const sid = client.nextSid()
      let state: 'connecting' | 'open' | 'closed' = 'connecting'
      // A socket ends once, whoever ends it: native's close, a refused open or the page's close().
      const end = () => {
        if (state === 'closed') return
        state = 'closed'
        stop()
        h.onClose()
      }
      const stop = client.onSocket(sid, (e) => {
        if (e.event === 'open') {
          if (state !== 'connecting') return
          state = 'open'
          h.onOpen()
        } else if (e.event === 'message') {
          if (state === 'open') h.onMessage(e.data)
        } else {
          end()
        }
      })
      client.call({ v: 1, kind: 'socket', sid, op: 'open', url }).then((r) => {
        if (!isOk(r)) end()
      }, end)
      return {
        // Like a socket that is not open yet, nothing is sent before native's open.
        send(data) {
          if (state !== 'open') return
          client.call({ v: 1, kind: 'socket', sid, op: 'send', data }).catch(ignore)
        },
        close() {
          if (state === 'closed') return
          client.call({ v: 1, kind: 'socket', sid, op: 'close' }).catch(ignore)
          end()
        },
      }
    },
  }
}

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/** openalgo-charts' `socketFactory`: each call opens one socket on a shared channel. */
export function createBridgedSocketFactory(client: DomClient): (url: string) => SocketLike {
  const channel = createSocketChannel(client)
  return (url) => {
    const socket: SocketLike = {
      readyState: CONNECTING,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: (d) => conn.send(d),
      close: () => conn.close(),
    }
    const conn = channel.open(url, {
      onOpen: () => {
        socket.readyState = OPEN
        socket.onopen?.()
      },
      onMessage: (data) => socket.onmessage?.({ data }),
      onClose: () => {
        socket.readyState = CLOSED
        socket.onclose?.()
      },
    })
    return socket
  }
}
