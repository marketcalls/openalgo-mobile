// The tool pages' XMLHttpRequest (design 7.7). The web's API modules call through axios, which
// sends with XHR: each request crosses the bridge as toDomRequest makes it, and native's reply is
// its whole response at once. A JSON reply reads as the server's JSON text; a string reply is
// HTML (the gateway's answer to a download) and reads as text/html. responseType '', 'text',
// 'json' and 'blob' are supported, and asynchronous requests only. The bridge carries no headers
// (the gateway answers by method and path), so request headers are taken and dropped.
import { DOM_ORIGIN, type DomReply, type JSONValue } from '~/dom/bridge/protocol'
import type { DomClient } from './client'
import { toDomRequest } from './request'

const UNSENT = 0
const OPENED = 1
const HEADERS_RECEIVED = 2
const LOADING = 3
const DONE = 4

const EVENTS = [
  'readystatechange',
  'loadstart',
  'progress',
  'load',
  'loadend',
  'error',
  'abort',
  'timeout',
] as const
type EventName = (typeof EVENTS)[number]
const RESPONSE_TYPES: ReadonlySet<string> = new Set(['', 'text', 'json', 'blob'])
/** What a reply dispatches, state by state (the XHR standard's order). */
const REPLY_STEPS: ReadonlyArray<readonly [number, ...EventName[]]> = [
  [HEADERS_RECEIVED, 'readystatechange'],
  [LOADING, 'readystatechange', 'progress'],
  [DONE, 'readystatechange', 'load', 'loadend'],
]

type Handler = ((this: unknown, e: Event) => unknown) | null
/** One send(): its rid, null when the request was refused on the page, and its timeout. */
type Flight = { rid: number | null; timer?: ReturnType<typeof setTimeout> }
type Body = { text: string; type: string; value: JSONValue; blob?: Blob }

const ignore = () => {}
const invalidState = (what: string) =>
  new DOMException(`openalgo-mobile: ${what}`, 'InvalidStateError')

function bodyOf({ body }: DomReply): Body {
  return typeof body === 'string'
    ? { text: body, type: 'text/html', value: body }
    : { text: JSON.stringify(body), type: 'application/json', value: body }
}

function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function createBridgedXhr(client: DomClient): typeof XMLHttpRequest {
  class BridgedXhr extends EventTarget {
    static readonly UNSENT = UNSENT
    static readonly OPENED = OPENED
    static readonly HEADERS_RECEIVED = HEADERS_RECEIVED
    static readonly LOADING = LOADING
    static readonly DONE = DONE
    readonly UNSENT = UNSENT
    readonly OPENED = OPENED
    readonly HEADERS_RECEIVED = HEADERS_RECEIVED
    readonly LOADING = LOADING
    readonly DONE = DONE

    onreadystatechange: Handler = null
    onloadstart: Handler = null
    onprogress: Handler = null
    onload: Handler = null
    onloadend: Handler = null
    onerror: Handler = null
    onabort: Handler = null
    ontimeout: Handler = null
    /** The body goes in one message, so no upload progress is reported. */
    readonly upload: EventTarget = new EventTarget()
    readyState = UNSENT
    status = 0
    /** Empty, as a browser's is for every HTTP/2 response: the bridge has no status line. */
    readonly statusText = ''
    responseURL = ''
    timeout = 0
    withCredentials = false

    private type: XMLHttpRequestResponseType = ''
    private method = ''
    private url = ''
    private flight: Flight | null = null
    private body: Body | null = null

    constructor() {
      super()
      // The on<event> handlers work as a browser's event handler attributes: as listeners.
      for (const type of EVENTS) {
        this.addEventListener(type, (e) => {
          const h = this[`on${type}`]
          if (typeof h === 'function') h.call(this, e)
        })
      }
    }

    get responseType(): XMLHttpRequestResponseType {
      return this.type
    }
    set responseType(type: XMLHttpRequestResponseType) {
      if (!RESPONSE_TYPES.has(type)) {
        throw new DOMException(`openalgo-mobile: no ${type} responses`, 'NotSupportedError')
      }
      if (this.readyState >= LOADING) {
        throw invalidState('the response type is set before the response')
      }
      this.type = type
    }

    get responseText(): string {
      if (this.type !== '' && this.type !== 'text') throw invalidState('responseText is text only')
      return this.readyState >= LOADING && this.body ? this.body.text : ''
    }

    get response(): unknown {
      if (this.type === '' || this.type === 'text') return this.responseText
      const body = this.readyState === DONE ? this.body : null
      if (body === null) return null
      if (this.type === 'json') {
        return typeof body.value === 'string' ? parsedOrNull(body.text) : body.value
      }
      body.blob ??= new Blob([body.text], { type: body.type })
      return body.blob
    }

    open(method: string, url: string | URL, async = true): void {
      if (!async) {
        throw new DOMException('openalgo-mobile: no synchronous requests', 'InvalidAccessError')
      }
      // A request still in flight is let go, with no event (the XHR standard's open()).
      const flight = this.flight
      if (flight) {
        this.settle(flight)
        this.tellNative(flight)
      }
      this.method = method
      this.url = String(url)
      this.status = 0
      this.body = null
      this.responseURL = ''
      const was = this.readyState
      this.readyState = OPENED
      if (was !== OPENED) this.fire('readystatechange')
    }

    setRequestHeader(_name: string, _value: string): void {
      if (this.readyState !== OPENED || this.flight) {
        throw invalidState('a header is set between open() and send()')
      }
    }

    getResponseHeader(name: string): string | null {
      return this.body && name.toLowerCase() === 'content-type' ? this.body.type : null
    }

    getAllResponseHeaders(): string {
      return this.body ? `content-type: ${this.body.type}\r\n` : ''
    }

    overrideMimeType(_mime: string): void {}

    send(body?: unknown): void {
      if (this.readyState !== OPENED || this.flight) {
        throw invalidState('send() follows open(), once')
      }
      const req = toDomRequest(
        this.method,
        this.url,
        this.method.toUpperCase() === 'GET' ? null : body,
      )
      const flight: Flight = { rid: req instanceof Error ? null : req.rid }
      this.flight = flight
      this.fire('loadstart')
      if (this.flight !== flight) return
      if (req instanceof Error) {
        // A refused request fails as a browser's network error does: after send() returns.
        queueMicrotask(() => this.fail(flight, 'error'))
        return
      }
      if (this.timeout > 0) {
        flight.timer = setTimeout(() => this.cancel(flight, 'timeout'), this.timeout)
      }
      client.call(req).then(
        (reply) => this.respond(flight, reply),
        () => this.fail(flight, 'error'),
      )
    }

    abort(): void {
      const flight = this.flight
      if (flight) this.cancel(flight, 'abort')
      // A finished request goes back to unsent, with no event.
      if (this.readyState === DONE) {
        this.readyState = UNSENT
        this.status = 0
        this.body = null
      }
    }

    private respond(flight: Flight, reply: DomReply): void {
      if (this.flight !== flight) return
      this.settle(flight)
      const body = bodyOf(reply)
      this.body = body
      this.status = reply.status
      const url = new URL(this.url, DOM_ORIGIN)
      url.hash = ''
      this.responseURL = url.href
      for (const [state, ...events] of REPLY_STEPS) {
        this.readyState = state
        for (const type of events) {
          this.fire(type)
          // a handler started over with open(): what is left of this reply is not dispatched
          if (this.body !== body) return
        }
      }
    }

    /** Native drops the call, then the page sees `why`. */
    private cancel(flight: Flight, why: 'abort' | 'timeout'): void {
      if (this.flight !== flight) return
      this.tellNative(flight)
      this.fail(flight, why)
    }

    /** The XHR standard's request error steps: done with no response, then `why` and loadend. */
    private fail(flight: Flight, why: 'error' | 'abort' | 'timeout'): void {
      if (this.flight !== flight) return
      this.settle(flight)
      this.status = 0
      this.body = null
      this.readyState = DONE
      this.fire('readystatechange')
      this.fire(why)
      this.fire('loadend')
    }

    private settle(flight: Flight): void {
      clearTimeout(flight.timer)
      this.flight = null
    }

    private tellNative(flight: Flight): void {
      if (flight.rid !== null) client.call({ v: 1, kind: 'abort', rid: flight.rid }).catch(ignore)
    }

    private fire(type: EventName): void {
      this.dispatchEvent(type === 'readystatechange' ? new Event(type) : new ProgressEvent(type))
    }
  }
  return BridgedXhr as unknown as typeof XMLHttpRequest
}
