/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "file:///android_asset/www.bundle/x.html"}
 */
// A tool page's network (design 7.7): the web's axios on the XHR shim, the WebSocket class, blob
// downloads handed to native, and the globals a page could otherwise reach the network with. A
// release page is a file:// URL, so relative URLs must resolve against DOM_ORIGIN.
import axios, { type AxiosError, type AxiosResponse } from 'axios'
import {
  DOM_ORIGIN,
  DOM_WS_URL,
  type DomReply,
  type DomRequest,
  type DomToNative,
  type JSONValue,
  NATIVE_KEY,
  OPENED_IN_APP,
} from '~/dom/bridge/protocol'
import { createDomClient } from './client'
import { installDownloads, MAX_SAVE_BYTES } from './downloads'
import { createBridgedFetch } from './fetch'
import { installNetworkShims } from './network'
import { toDomRequest } from './request'
import { probeWebGl } from './webgl'
import { createBridgedWebSocket } from './websocket'
import { createBridgedXhr } from './xhr'

const ACCEPTED: DomReply = { status: 202, body: null }
const REFUSED: DomReply = { status: 400, body: { status: 'error', message: 'Refused by the app' } }
const SUCCESS: DomReply = { status: 200, body: { status: 'success' } }

/** A bridge that answers each message with `answer(m)`, and the client over it. */
function bridged(answer: (m: DomToNative) => DomReply | Promise<DomReply> = () => ACCEPTED) {
  const call = jest.fn(async (m: JSONValue): Promise<JSONValue> => answer(m as DomToNative))
  return { call, client: createDomClient(call) }
}
const sent = (call: jest.Mock) => call.mock.calls.map(([m]) => m as DomToNative)
const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const never = () => new Promise<DomReply>(() => {})

/** A Blob's text (jsdom's Blob has no text()). */
const textOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })

const realXhr = window.XMLHttpRequest
afterEach(() => {
  window.XMLHttpRequest = realXhr
  document.body.innerHTML = ''
})

/** The web's apiClient (frontend api/client.ts, as configured there) on the XHR shim. */
function apiOver(client: ReturnType<typeof createDomClient>) {
  window.XMLHttpRequest = createBridgedXhr(client)
  return axios.create({
    baseURL: '/api/v1',
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true,
  })
}
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: AxiosError) => e,
  )

describe('request', () => {
  test("plan D's fetch sends ?a=1 as query {a:'1'}", async () => {
    const { call, client } = bridged(() => SUCCESS)
    await createBridgedFetch(client)('/api/v1/x?a=1')
    expect(sent(call)).toEqual([
      {
        v: 1,
        kind: 'request',
        rid: expect.any(Number),
        method: 'GET',
        path: '/api/v1/x',
        query: { a: '1' },
      },
    ])
  })

  test('toDomRequest takes the app paths with their query and JSON body; anything else is an Error', () => {
    const get = toDomRequest('get', '/search/api/expiries?exchange=NFO&underlying=NIFTY', null)
    expect(get).toEqual({
      v: 1,
      kind: 'request',
      rid: expect.any(Number),
      method: 'GET',
      path: '/search/api/expiries',
      query: { exchange: 'NFO', underlying: 'NIFTY' },
    })
    const post = toDomRequest(
      'POST',
      `${DOM_ORIGIN}/oitracker/api/maxpain`,
      '{"underlying":"NIFTY"}',
    )
    expect(post).toEqual({
      v: 1,
      kind: 'request',
      rid: expect.any(Number),
      method: 'POST',
      path: '/oitracker/api/maxpain',
      body: { underlying: 'NIFTY' },
    })
    // one rid sequence for the page, as plan D's fetch
    expect((post as DomRequest).rid).toBe((get as DomRequest).rid + 1)

    const refused: Array<[string, string, unknown]> = [
      ['GET', 'https://example.com/api/v1/x', null],
      ['GET', '//example.com/api/v1/x', null],
      ['GET', 'http://native.invalid/api/v1/x', null],
      ['GET', 'file:///android_asset/www.bundle/x.html', null],
      ['GET', 'http://[', null],
      ['PUT', '/api/v1/x', '{}'],
      ['DELETE', '/api/v1/x', null],
      ['GET', '/api/v1/x', '{}'],
      ['POST', '/api/v1/x', 'not json'],
      ['POST', '/api/v1/x', new Blob(['{}'])],
      ['POST', '/api/v1/x', { a: 1 }],
    ]
    for (const [method, url, body] of refused)
      expect(toDomRequest(method, url, body)).toBeInstanceOf(Error)
  })
})

describe('xhr', () => {
  test('axios.get and axios.post go over the bridge with the query, JSON body and placeholder key', async () => {
    const { call, client } = bridged(() => SUCCESS)
    const api = apiOver(client)
    const holdings = [{ symbol: 'INFY', exchange: 'NSE', weight: 1 }]

    const got = await api.get('/portfolio/benchmarks', { params: { apikey: NATIVE_KEY } })
    const posted = await api.post('/portfolio/backtest', { apikey: NATIVE_KEY, holdings })
    expect(sent(call)).toEqual([
      {
        v: 1,
        kind: 'request',
        rid: expect.any(Number),
        method: 'GET',
        path: '/api/v1/portfolio/benchmarks',
        query: { apikey: '__native__' },
      },
      {
        v: 1,
        kind: 'request',
        rid: expect.any(Number),
        method: 'POST',
        path: '/api/v1/portfolio/backtest',
        body: { apikey: '__native__', holdings },
      },
    ])
    for (const res of [got, posted]) {
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ status: 'success' })
      expect(res.headers['content-type']).toBe('application/json')
    }

    // A refusal rejects as a server's would, with the gateway's JSON as the response data.
    const denied = bridged(() => ({ status: 403, body: { status: 'error', message: 'Denied' } }))
    const err = await failure(apiOver(denied.client).get('/auth/analyzer-toggle'))
    expect(axios.isAxiosError(err)).toBe(true)
    expect(err?.response?.status).toBe(403)
    expect(err?.response?.data).toEqual({ status: 'error', message: 'Denied' })
  })

  test('a blob request resolves to a Blob of the HTML text', async () => {
    const html = '<!doctype html><title>Tearsheet</title>'
    const { client } = bridged(() => ({ status: 200, body: html }))
    const api = apiOver(client)

    const res: AxiosResponse<Blob> = await api.post(
      '/portfolio/tearsheet',
      { apikey: NATIVE_KEY },
      { responseType: 'blob' },
    )
    expect(res.data).toBeInstanceOf(Blob)
    expect(res.data.type).toBe('text/html')
    expect(res.headers['content-type']).toBe('text/html')
    await expect(textOf(res.data)).resolves.toBe(html)
    // the same reply read as text is the HTML itself
    const text = await api.post('/portfolio/tearsheet', {}, { responseType: 'text' })
    expect(text.data).toBe(html)

    // A JSON refusal of a blob request arrives as a JSON Blob, which the web's
    // blobRefusalSentence (lib/serverSentence.ts) reads for the server's sentence.
    const busy = { status: 'error', message: 'Busy. Try again in a few seconds.' }
    const refused = bridged(() => ({ status: 429, body: busy }))
    const err = await failure(
      apiOver(refused.client).post('/portfolio/tearsheet', {}, { responseType: 'blob' }),
    )
    const data = err?.response?.data as Blob
    expect(err?.response?.status).toBe(429)
    expect(data).toBeInstanceOf(Blob)
    expect(data.type).toBe('application/json')
    expect(JSON.parse(await textOf(data))).toEqual(busy)
  })

  test('an absolute URL rejects with a network error and nothing is bridged', async () => {
    const { call, client } = bridged(() => SUCCESS)
    const api = apiOver(client)
    for (const url of [
      'https://example.com/api/v1/history',
      '//example.com/api/v1/history',
      'http://native.invalid/api/v1/history',
      'file:///android_asset/www.bundle/x.html',
    ]) {
      const err = await failure(api.get(url))
      expect(axios.isAxiosError(err)).toBe(true)
      expect(err?.code).toBe('ERR_NETWORK')
      expect(err?.response).toBeUndefined()
    }
    // a method the bridge does not carry fails the same way
    expect((await failure(api.put('/x', {})))?.code).toBe('ERR_NETWORK')
    expect(call).not.toHaveBeenCalled()
  })

  test('abort rejects and posts abort with its rid', async () => {
    let answer: (r: DomReply) => void = () => {}
    const { call, client } = bridged((m) =>
      m.kind === 'request' ? new Promise<DomReply>((r) => (answer = r)) : ACCEPTED,
    )
    const api = apiOver(client)
    const ctl = new AbortController()
    const p = failure(
      api.post('/portfolio/backtest', { apikey: NATIVE_KEY }, { signal: ctl.signal }),
    )
    await flush()
    ctl.abort()
    expect(axios.isCancel(await p)).toBe(true)
    const [req, abort] = sent(call)
    expect(req).toMatchObject({ kind: 'request', path: '/api/v1/portfolio/backtest' })
    expect(abort).toEqual({ v: 1, kind: 'abort', rid: (req as DomRequest).rid })
    // a reply that comes after the abort is not read
    answer(SUCCESS)
    await flush()
    expect(call).toHaveBeenCalledTimes(2)

    // A timeout gives up on native the same way.
    const slow = bridged((m) => (m.kind === 'request' ? never() : ACCEPTED))
    const err = await failure(apiOver(slow.client).get('/portfolio/benchmarks', { timeout: 20 }))
    expect(err?.code).toBe('ECONNABORTED')
    expect(err?.message).toBe('timeout of 20ms exceeded')
    const [late, gaveUp] = sent(slow.call)
    expect(gaveUp).toEqual({ v: 1, kind: 'abort', rid: (late as DomRequest).rid })
  })

  test('a raw XHR runs its handlers and listeners in order; a refused URL errors after send returns', async () => {
    const { client } = bridged(() => ({ status: 200, body: { status: 'success', data: [1] } }))
    const Xhr = createBridgedXhr(client)
    const xhr = new Xhr()
    const seen: string[] = []
    xhr.onreadystatechange = () => seen.push(`state ${xhr.readyState}`)
    xhr.onload = () => seen.push('load')
    xhr.addEventListener('loadend', (e) => seen.push(`loadend ${e.target === xhr}`))
    xhr.open('POST', '/api/v1/x')
    xhr.setRequestHeader('Content-Type', 'application/json')
    xhr.responseType = 'json'
    xhr.send('{}')
    expect(xhr.readyState).toBe(Xhr.OPENED)
    await flush()
    expect(seen).toEqual(['state 1', 'state 2', 'state 3', 'state 4', 'load', 'loadend true'])
    expect(xhr.status).toBe(200)
    expect(xhr.response).toEqual({ status: 'success', data: [1] })
    expect(xhr.getResponseHeader('Content-Type')).toBe('application/json')
    expect(xhr.getAllResponseHeaders()).toBe('content-type: application/json\r\n')
    expect(xhr.responseURL).toBe(`${DOM_ORIGIN}/api/v1/x`)
    expect(() => xhr.responseText).toThrow()
    expect(() => {
      xhr.responseType = 'arraybuffer'
    }).toThrow()
    expect(() => new Xhr().open('GET', '/x', false)).toThrow()

    const refused = new Xhr()
    const events: string[] = []
    for (const type of ['readystatechange', 'load', 'error', 'loadend'])
      refused.addEventListener(type, () => events.push(`${type} ${refused.readyState}`))
    refused.open('GET', 'https://example.com/x')
    refused.send()
    expect(events).toEqual(['readystatechange 1'])
    await flush()
    expect(events).toEqual(['readystatechange 1', 'readystatechange 4', 'error 4', 'loadend 4'])
    expect(refused.status).toBe(0)
    expect(refused.getAllResponseHeaders()).toBe('')
  })
})

describe('websocket', () => {
  const sockets = (call: jest.Mock) =>
    sent(call).filter((m): m is Extract<DomToNative, { kind: 'socket' }> => m.kind === 'socket')
  /** Every event a socket fires, in order. */
  function record(ws: WebSocket): string[] {
    const seen: string[] = []
    ws.onopen = () => seen.push('open')
    ws.addEventListener('message', (e) => seen.push(`message ${e.data}`))
    ws.onerror = () => seen.push('error')
    ws.onclose = (e) => seen.push(`close ${e.code} ${e.wasClean}`)
    return seen
  }

  test('WebSocket to DOM_WS_URL opens, sends and receives; any other URL errors and closes', async () => {
    const { call, client } = bridged()
    const WS = createBridgedWebSocket(client)
    const ws = new WS(DOM_WS_URL)
    const seen = record(ws)
    expect(ws.url).toBe(DOM_WS_URL)
    expect(ws.readyState).toBe(WS.CONNECTING)
    expect(() => ws.send('early')).toThrow()

    const [open] = sockets(call)
    expect(open).toEqual({
      v: 1,
      kind: 'socket',
      sid: expect.any(Number),
      op: 'open',
      url: DOM_WS_URL,
    })
    const sid = (open as { sid: number }).sid
    client.deliver([{ kind: 'socket', sid, event: 'open' }])
    expect(ws.readyState).toBe(WS.OPEN)
    ws.send('{"action":"subscribe"}')
    expect(sockets(call)[1]).toEqual({
      v: 1,
      kind: 'socket',
      sid,
      op: 'send',
      data: '{"action":"subscribe"}',
    })
    client.deliver([{ kind: 'socket', sid, event: 'message', data: '{"type":"market_data"}' }])

    // The page's close goes through CLOSING; its close event comes after close() returns.
    ws.close(1000, 'done')
    expect(ws.readyState).toBe(WS.CLOSING)
    expect(seen).toEqual(['open', 'message {"type":"market_data"}'])
    await flush()
    expect(ws.readyState).toBe(WS.CLOSED)
    expect(seen).toEqual(['open', 'message {"type":"market_data"}', 'close 1000 true'])
    expect(sockets(call).map((m) => m.op)).toEqual(['open', 'send', 'close'])
    ws.close()
    ws.send('late')
    expect(() => ws.close(1001)).toThrow()

    // Any other URL: nothing crosses the bridge, and the page sees a failed connection at once.
    const other = new WS('wss://example.com/ws')
    const otherSeen = record(other)
    await flush()
    expect(otherSeen).toEqual(['error', 'close 1006 false'])
    expect(other.readyState).toBe(WS.CLOSED)
    expect(sockets(call)).toHaveLength(3)
  })

  test('a refused open fails like a socket that never connects; a close from native ends an open one', async () => {
    const refusing = bridged((m) => (m.kind === 'socket' && m.op === 'open' ? REFUSED : ACCEPTED))
    const failed = new (createBridgedWebSocket(refusing.client))(DOM_WS_URL)
    const failedSeen = record(failed)
    await flush()
    expect(failedSeen).toEqual(['error', 'close 1006 false'])

    const { call, client } = bridged()
    const WS = createBridgedWebSocket(client)
    const ws = new WS(DOM_WS_URL)
    const seen = record(ws)
    const sid = (sent(call)[0] as { sid: number }).sid
    client.deliver([
      { kind: 'socket', sid, event: 'open' },
      { kind: 'socket', sid, event: 'close' },
    ])
    expect(ws.readyState).toBe(WS.CLOSING)
    await flush()
    expect(seen).toEqual(['open', 'close 1006 false'])

    // Closed by the page before it opened: a failure, and native is told.
    const early = new WS(DOM_WS_URL)
    const earlySeen = record(early)
    early.close()
    await flush()
    expect(earlySeen).toEqual(['error', 'close 1006 false'])
    expect(
      sent(call)
        .filter((m) => m.kind === 'socket')
        .map((m) => (m as { op: string }).op),
    ).toEqual(['open', 'open', 'close'])
  })
})

describe('downloads', () => {
  // jsdom has no blob URLs: the WebView's are stood in for.
  const urls = URL as unknown as {
    createObjectURL?: (b: Blob) => string
    revokeObjectURL?: (u: string) => void
  }
  let n = 0
  beforeEach(() => {
    urls.createObjectURL = jest.fn(() => `blob:file:///${++n}`)
    urls.revokeObjectURL = jest.fn()
  })
  afterEach(() => {
    delete urls.createObjectURL
    delete urls.revokeObjectURL
  })

  /** The pages' save: a link with `download` on an object URL, clicked, removed and revoked at
   *  once (SectorRotation.tsx:688-698, plotly's filesaver). Whether the click reached the link
   *  already cancelled; the link then cancels it itself, since jsdom cannot navigate. */
  function clickSave(blob: Blob, name: string): boolean {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.download = name
    link.href = url
    document.body.appendChild(link)
    let cancelled = false
    link.addEventListener('click', (e) => {
      cancelled = e.defaultPrevented
      e.preventDefault()
    })
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    return cancelled
  }
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await flush()
  }

  test('a PNG blob link click sends one save intent; the OPENED_IN_APP blob sends none', async () => {
    const create = urls.createObjectURL
    const onSave = jest.fn()
    const stop = installDownloads(window, onSave)

    const name = 'Sector_Rotation_NIFTY_daily_2026-11-27.png'
    expect(clickSave(new Blob([PNG], { type: 'image/png' }), name)).toBe(true)
    await until(() => onSave.mock.calls.length > 0)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith({
      type: 'save',
      name,
      mime: 'image/png',
      base64: 'iVBORw0KGgo=',
    })

    // The tearsheet native already saved: the page's blob is the gateway's marker.
    clickSave(new Blob([OPENED_IN_APP], { type: 'text/html' }), 'portfolio-tearsheet.html')
    // An unlisted MIME and an oversized blob are dropped.
    clickSave(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'chart.svg')
    clickSave(new Blob([new Uint8Array(MAX_SAVE_BYTES + 1)], { type: 'image/png' }), 'big.png')
    // A CSV with a charset is text/csv; a name the app cannot keep is made safe.
    clickSave(new Blob(['a,b\n'], { type: 'text/csv;charset=utf-8' }), 'search: 27/11.csv')
    await until(() => onSave.mock.calls.length > 1)
    await flush()
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave).toHaveBeenLastCalledWith({
      type: 'save',
      name: 'search_ 27_11.csv',
      mime: 'text/csv',
      base64: 'YSxiCg==',
    })

    // The largest blob that is kept is exactly the bridge's base64 limit.
    expect(Math.ceil(MAX_SAVE_BYTES / 3) * 4).toBe(4_000_000)

    stop()
    expect(urls.createObjectURL).toBe(create)
    expect(clickSave(new Blob([PNG], { type: 'image/png' }), name)).toBe(false)
    await flush()
    expect(onSave).toHaveBeenCalledTimes(2)
  })
})

describe('globals', () => {
  type Globals = Record<string, unknown>
  const w = window as unknown as Globals
  const NAMES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'open']
  let saved: Array<[string, PropertyDescriptor | undefined]> = []
  beforeEach(() => {
    saved = NAMES.map((k) => [k, Object.getOwnPropertyDescriptor(window, k)])
  })
  afterEach(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(window, k, d)
      else delete w[k]
    }
    delete (navigator as unknown as Globals).sendBeacon
  })

  test('after installNetworkShims, EventSource is gone and sendBeacon is false', async () => {
    // jsdom has neither: the WebView's are stood in for.
    w.EventSource = class {}
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => true })
    const { call, client } = bridged(() => SUCCESS)

    installNetworkShims(window, client)
    expect('EventSource' in window).toBe(false)
    expect(navigator.sendBeacon('/api/v1/x', 'data')).toBe(false)
    expect(window.open('https://example.com')).toBeNull()

    // fetch, XMLHttpRequest and WebSocket are the bridged ones.
    await fetch('/api/v1/a')
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/api/v1/b')
    xhr.send()
    await flush()
    expect(xhr.status).toBe(200)
    new WebSocket(DOM_WS_URL)
    expect(sent(call).map((m) => (m.kind === 'request' ? m.path : m.kind))).toEqual([
      '/api/v1/a',
      '/api/v1/b',
      'socket',
    ])
  })

  test('probeWebGl is whether a canvas gives a webgl context, which it then lets go', () => {
    const loseContext = jest.fn()
    const gl = {
      getExtension: (x: string) => (x === 'WEBGL_lose_context' ? { loseContext } : null),
    }
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext')
    try {
      getContext.mockReturnValueOnce(gl as unknown as WebGLRenderingContext)
      expect(probeWebGl(document)).toBe(true)
      expect(getContext).toHaveBeenLastCalledWith('webgl')
      expect(loseContext).toHaveBeenCalledTimes(1)

      getContext.mockReturnValueOnce(null)
      expect(probeWebGl(document)).toBe(false)
      getContext.mockImplementationOnce(() => {
        throw new Error('no GPU')
      })
      expect(probeWebGl(document)).toBe(false)
    } finally {
      getContext.mockRestore()
    }
  })
})
