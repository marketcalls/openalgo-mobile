/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "file:///android_asset/www.bundle/x.html"}
 */
// A release DOM page is a file:// URL (preflight conflict 14), so relative fetches must resolve
// against DOM_ORIGIN, not the page's location.
import { runInThisContext } from 'node:vm'
import {
  CHART_TOPICS,
  DOM_ORIGIN,
  DOM_WS_URL,
  type DomReply,
  type DomToNative,
  type JSONValue,
  NATIVE_KEY,
} from '~/dom/bridge/protocol'
import { createDomClient, isOk, nextRid } from './client'
import { DOM_CSP, DOM_CSP_DEV, installCsp, probeCsp } from './csp'
import { seedImportMetaEnv, VITE_ENV } from './env'
import { createBridgedFetch } from './fetch'
import { guardLinks } from './links'
import { createBridgedSocketFactory, createSocketChannel } from './socket'
import { createBridgedStorage, safeLocalStorage } from './storage'

const ACCEPTED: DomReply = { status: 202, body: null }
const REFUSED: DomReply = { status: 400, body: { status: 'error', message: 'Refused by the app' } }

/** A bridge that answers each message with `answer(m)`, and the client over it. */
function bridged(answer: (m: DomToNative) => DomReply | Promise<DomReply> = () => ACCEPTED) {
  const call = jest.fn(async (m: JSONValue): Promise<JSONValue> => answer(m as DomToNative))
  return { call, client: createDomClient(call) }
}
const sent = (call: jest.Mock) => call.mock.calls.map(([m]) => m as DomToNative)
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('env', () => {
  test('env is seeded on a fresh registry and an existing env is kept', () => {
    const fresh: Record<string, unknown> = { location: { href: 'file:///p.html' } }
    expect(seedImportMetaEnv(fresh)).toEqual({ preexisting: false })
    expect(fresh.__ExpoImportMetaRegistry).toEqual({ url: 'file:///p.html', env: VITE_ENV })
    expect((fresh.__ExpoImportMetaRegistry as { env: object }).env).not.toBe(VITE_ENV)

    // Expo's runtime installed the registry (url only): env is added, the registry kept.
    const registry = { url: 'x' }
    const expo = { __ExpoImportMetaRegistry: registry }
    expect(seedImportMetaEnv(expo)).toEqual({ preexisting: true })
    expect(expo.__ExpoImportMetaRegistry).toBe(registry)
    expect(expo.__ExpoImportMetaRegistry).toEqual({ url: 'x', env: VITE_ENV })

    const env = { MODE: 'test' }
    const seeded = { __ExpoImportMetaRegistry: { url: 'x', env } }
    expect(seedImportMetaEnv(seeded, { MODE: 'other' })).toEqual({ preexisting: true })
    expect(seeded.__ExpoImportMetaRegistry.env).toBe(env)
    expect(env).toEqual({ MODE: 'test' })
  })

  test('VITE_ENV is a production build with same-origin API URLs', () => {
    expect(VITE_ENV).toEqual({
      MODE: 'production',
      DEV: false,
      PROD: true,
      SSR: false,
      BASE_URL: '/',
      VITE_API_URL: '',
    })
  })
})

describe('csp', () => {
  const cspMetas = () =>
    document.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')

  test('the release policy is exactly DOM_CSP, first in head, once', () => {
    expect(DOM_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
        "form-action 'none'; base-uri 'none'",
    )
    document.head.innerHTML = '<title>t</title><style>a{}</style>'

    const meta = installCsp(document, false)
    expect(installCsp(document, false)).toBe(meta)

    expect(cspMetas()).toHaveLength(1)
    expect(document.head.firstElementChild).toBe(meta)
    expect(meta.httpEquiv).toBe('Content-Security-Policy')
    expect(meta.content).toBe(DOM_CSP)
  })

  /** A policy as directive → sources. */
  const directives = (policy: string) =>
    Object.fromEntries(
      policy.split(';').map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/)
        return [name, sources]
      }),
    )

  test('the release policy has no eval; the dev policy adds eval and self connects, nothing else', () => {
    expect(DOM_CSP).not.toContain("'unsafe-eval'")
    expect(directives(DOM_CSP)['script-src']).toEqual(["'self'"])

    expect(DOM_CSP_DEV).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self' data:; connect-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
        "form-action 'none'; base-uri 'none'",
    )
    expect(directives(DOM_CSP_DEV)).toEqual({
      ...directives(DOM_CSP),
      'script-src': ["'self'", "'unsafe-eval'"],
      'connect-src': ["'self'"],
    })
    expect(installCsp(document, true).content).toBe(DOM_CSP_DEV)
    expect(cspMetas()).toHaveLength(1)
  })

  describe('prelude', () => {
    const g = globalThis as unknown as {
      __DEV__: boolean
      __ExpoImportMetaRegistry?: { url: string; env: object }
    }
    const runPrelude = (dev: boolean) => {
      const was = g.__DEV__
      g.__DEV__ = dev
      try {
        jest.isolateModules(() => {
          require('./prelude')
        })
      } finally {
        g.__DEV__ = was
      }
      return document.head.firstElementChild as HTMLMetaElement
    }
    beforeEach(() => {
      delete g.__ExpoImportMetaRegistry
    })
    afterEach(() => {
      delete g.__ExpoImportMetaRegistry
    })

    test('the prelude seeds the env and installs the release policy', () => {
      expect(g.__DEV__).toBe(false)
      const meta = runPrelude(false)
      expect(g.__ExpoImportMetaRegistry).toEqual({ url: location.href, env: VITE_ENV })
      expect(cspMetas()).toHaveLength(1)
      expect(meta.content).toBe(DOM_CSP)
    })

    test("every 'use dom' entry imports the prelude first, by a name it uses", () => {
      // Expo's tree shaking drops a bare `import '~/dom/web/prelude'` (prelude.ts), which shipped
      // every page without its CSP or env; a named import that the entry uses is kept.
      const { readdirSync, readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs')
      const { join } = jest.requireActual<typeof import('node:path')>('node:path')
      const src = join(__dirname, '..', '..')
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : [],
        )
      const entries = walk(src).filter((f) => readFileSync(f, 'utf8').startsWith("'use dom'"))
      expect(entries.length).toBeGreaterThanOrEqual(4)
      for (const f of entries) {
        const code = readFileSync(f, 'utf8')
        const imports = code.split('\n').filter((l) => /^import\b/.test(l))
        expect([f, imports[0]]).toEqual([f, "import { PRELUDE } from '~/dom/web/prelude'"])
        expect(code).not.toMatch(/^import ['"][^'"]*prelude['"]/m)
        // used beyond its import, so the tree shaker counts the binding as used
        expect(code.split('PRELUDE').length).toBeGreaterThan(2)
      }
    })

    test('the prelude picks the dev policy only under __DEV__', () => {
      expect(runPrelude(true).content).toBe(DOM_CSP_DEV)
      document.head.innerHTML = ''
      expect(runPrelude(false).content).toBe(DOM_CSP)
      expect(cspMetas()).toHaveLength(1)
    })
  })

  describe('probe', () => {
    afterEach(() => {
      jest.useRealTimers()
      jest.restoreAllMocks()
    })

    test('probeCsp is true on a violation and false after its timeout', async () => {
      jest.useFakeTimers()
      const src = jest.spyOn(HTMLImageElement.prototype, 'src', 'set')
      const add = jest.spyOn(window, 'addEventListener')
      const remove = jest.spyOn(window, 'removeEventListener')

      const blocked = probeCsp(window)
      expect(src).toHaveBeenCalledWith('https://csp-probe.invalid/p.png')
      document.dispatchEvent(new Event('securitypolicyviolation', { bubbles: true }))
      await expect(blocked).resolves.toBe(true)

      let settled = false
      const open = probeCsp(window).then((v) => {
        settled = true
        return v
      })
      jest.advanceTimersByTime(999)
      await Promise.resolve()
      expect(settled).toBe(false)
      jest.advanceTimersByTime(1)
      await expect(open).resolves.toBe(false)

      // Each probe leaves no listener and no timer behind.
      const added = add.mock.calls.filter(([type]) => type === 'securitypolicyviolation')
      expect(added).toHaveLength(2)
      for (const [type, fn] of added) expect(remove).toHaveBeenCalledWith(type, fn)
      expect(jest.getTimerCount()).toBe(0)
    })

    test('probeCsp takes its own timeout', async () => {
      jest.useFakeTimers()
      const p = probeCsp(window, 50)
      jest.advanceTimersByTime(50)
      await expect(p).resolves.toBe(false)
    })
  })
})

describe('links', () => {
  function link(href: string, inner = 'go') {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    a.innerHTML = `<span>${inner}</span>`
    document.body.append(a)
    return a
  }
  function click(el: Element) {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e
  }

  test('an https link goes to native and is not followed; javascript: is dropped', () => {
    const onLink = jest.fn()
    const stop = guardLinks(document, onLink)

    const https = click(link('https://openalgo.in/news?id=1').querySelector('span') as Element)
    expect(https.defaultPrevented).toBe(true)
    expect(onLink).toHaveBeenCalledWith('https://openalgo.in/news?id=1')

    const js = click(link('javascript:alert(1)'))
    expect(js.defaultPrevented).toBe(true)
    // A relative link resolves to the page's own file:// URL: never followed, never sent.
    const rel = click(link('other.html'))
    expect(rel.defaultPrevented).toBe(true)
    const data = click(link('data:text/html,<b>x</b>'))
    expect(data.defaultPrevented).toBe(true)
    expect(onLink).toHaveBeenCalledTimes(1)

    stop()
    // After stop the guard is gone; a later bubble-phase handler stops jsdom's navigation.
    const after = (e: Event) => e.preventDefault()
    document.addEventListener('click', after)
    click(link('https://openalgo.in/b'))
    document.removeEventListener('click', after)
    expect(onLink).toHaveBeenCalledTimes(1)
  })

  test('an http link is cancelled in the page and never reaches native; a click off a link is left alone', () => {
    const onLink = jest.fn()
    const stop = guardLinks(document, onLink)
    expect(click(link('http://example.com/a')).defaultPrevented).toBe(true)
    expect(click(link('HTTP://example.com/b')).defaultPrevented).toBe(true)
    expect(onLink).not.toHaveBeenCalled()

    const div = document.createElement('div')
    document.body.append(div)
    expect(click(div).defaultPrevented).toBe(false)
    expect(onLink).not.toHaveBeenCalled()
    stop()
  })

  test('a window capture listener that stops the click cannot take its link past the guard', () => {
    const onLink = jest.fn()
    // Added before the guard: stopPropagation still leaves the window's other listeners running.
    const earlier = jest.fn((e: Event) => e.stopPropagation())
    window.addEventListener('click', earlier, true)
    const stop = guardLinks(document, onLink)
    // Added after the guard: it runs second, so even stopImmediatePropagation is too late.
    const later = jest.fn((e: Event) => e.stopImmediatePropagation())
    window.addEventListener('click', later, true)
    try {
      const e = click(link('https://openalgo.in/a'))
      expect(earlier).toHaveBeenCalledTimes(1)
      expect(later).toHaveBeenCalledTimes(1)
      expect(e.defaultPrevented).toBe(true)
      expect(onLink).toHaveBeenCalledWith('https://openalgo.in/a')
    } finally {
      window.removeEventListener('click', earlier, true)
      window.removeEventListener('click', later, true)
      stop()
    }
  })
})

describe('client', () => {
  test('deliver routes socket events by sid and pushes by topic; a malformed batch is ignored', () => {
    const { client } = bridged()
    const one = jest.fn()
    const two = jest.fn()
    const orders = jest.fn()
    client.onSocket(1, one)
    client.onSocket(2, two)
    const off = client.onPush(CHART_TOPICS.orders, orders)

    client.deliver([
      { kind: 'socket', sid: 1, event: 'open' },
      { kind: 'socket', sid: 2, event: 'message', data: '{"type":"pong"}' },
      { kind: 'push', topic: CHART_TOPICS.orders, payload: [{ id: 'A1' }] },
      { kind: 'push', topic: CHART_TOPICS.redraw, payload: null },
      { kind: 'socket', sid: 7, event: 'close' },
    ])
    expect(one).toHaveBeenCalledTimes(1)
    expect(one).toHaveBeenCalledWith({ kind: 'socket', sid: 1, event: 'open' })
    expect(two).toHaveBeenCalledWith({
      kind: 'socket',
      sid: 2,
      event: 'message',
      data: '{"type":"pong"}',
    })
    expect(orders).toHaveBeenCalledTimes(1)
    expect(orders).toHaveBeenCalledWith([{ id: 'A1' }])

    // One bad message spoils the batch: nothing in it is delivered.
    client.deliver([
      { kind: 'socket', sid: 1, event: 'close' },
      { kind: 'eval', code: 'x' },
    ])
    client.deliver('[{"kind":"socket","sid":1,"event":"close"}]')
    client.deliver(null)
    client.deliver({ kind: 'push', topic: CHART_TOPICS.orders, payload: [] })
    expect(one).toHaveBeenCalledTimes(1)
    expect(orders).toHaveBeenCalledTimes(1)

    off()
    client.deliver([{ kind: 'push', topic: CHART_TOPICS.orders, payload: [] }])
    expect(orders).toHaveBeenCalledTimes(1)
  })

  test('a listener that throws costs no other message; the error surfaces after the batch', () => {
    const { client } = bridged()
    const later = jest.fn()
    client.onPush('a', () => {
      throw new Error('boom')
    })
    client.onPush('b', later)
    expect(() =>
      client.deliver([
        { kind: 'push', topic: 'a', payload: 1 },
        { kind: 'push', topic: 'b', payload: 2 },
      ]),
    ).toThrow('boom')
    expect(later).toHaveBeenCalledWith(2)
  })

  test('call returns the native reply; a reply that is not one rejects', async () => {
    const { client, call } = bridged(() => ({ status: 200, body: { ok: 1 } }))
    const m: DomToNative = { v: 1, kind: 'event', name: 'loaded' }
    await expect(client.call(m)).resolves.toEqual({ status: 200, body: { ok: 1 } })
    expect(call).toHaveBeenCalledWith(m)

    for (const bad of [null, 'ok', { status: 'x', body: null }, { status: 200 }]) {
      const broken = createDomClient(async () => bad as JSONValue)
      await expect(broken.call(m)).rejects.toThrow('bridge reply')
    }
  })

  test('isOk is a 2xx reply', () => {
    const at = (status: number) => isOk({ status, body: null })
    expect([199, 200, 202, 204, 299, 300, 400, 413].map(at)).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })

  test('nextRid counts up within the protocol range', () => {
    const a = nextRid()
    const b = nextRid()
    expect(b).toBe(a + 1)
    expect(Number.isSafeInteger(b) && a >= 0).toBe(true)
  })

  test('nextSid stays within the protocol range and skips ids still listened to', () => {
    const { client } = bridged()
    const first = client.nextSid()
    client.onSocket(first + 1, jest.fn())
    expect(client.nextSid()).toBe(first + 2)

    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const sid = client.nextSid()
      expect(sid).toBeGreaterThanOrEqual(0)
      expect(sid).toBeLessThanOrEqual(999)
      seen.add(sid)
    }
    expect(seen.has(first + 1)).toBe(false)
  })
})

describe('fetch', () => {
  const HISTORY: DomReply = { status: 200, body: { status: 'success', data: [] } }

  test('a relative POST goes over the bridge with its JSON body', async () => {
    const { call, client } = bridged(() => HISTORY)
    const f = createBridgedFetch(client)

    const res = await f('/api/v1/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: NATIVE_KEY, symbol: 'INFY' }),
    })
    expect(call).toHaveBeenCalledWith({
      v: 1,
      kind: 'request',
      rid: expect.any(Number),
      method: 'POST',
      path: '/api/v1/history',
      body: { apikey: '__native__', symbol: 'INFY' },
    })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('x-other')).toBeNull()
    await expect(res.json()).resolves.toEqual({ status: 'success', data: [] })
    await expect(res.clone().text()).resolves.toBe('{"status":"success","data":[]}')
  })

  test('json() is the body the bridge delivered, with no JSON work; a clone reads its own copy', async () => {
    const bar = { close: 1 }
    const body = { status: 'success', data: [bar] }
    const { client } = bridged(() => ({ status: 200, body }))
    const f = createBridgedFetch(client)
    // The counts are read before restoring: mockRestore clears a spy's calls.
    const stringify = jest.spyOn(JSON, 'stringify')
    const parse = jest.spyOn(JSON, 'parse')
    let jsonWork: number
    let res: Response
    let read: unknown
    try {
      res = await f('/api/v1/history')
      read = await res.json()
    } finally {
      jsonWork = stringify.mock.calls.length + parse.mock.calls.length
      stringify.mockRestore()
      parse.mockRestore()
    }
    expect(read).toBe(body)
    expect(jsonWork).toBe(0)

    // The page changes what it read: the clone keeps its own copy, and text() writes out the body.
    const copy = res.clone()
    bar.close = 2
    await expect(copy.json()).resolves.toEqual({ status: 'success', data: [{ close: 1 }] })
    await expect(res.text()).resolves.toBe('{"status":"success","data":[{"close":2}]}')
  })

  test('a GET carries its query; DOM_ORIGIN URLs and paths from the file page are the app', async () => {
    const { call, client } = bridged(() => ({ status: 403, body: { status: 'error' } }))
    const f = createBridgedFetch(client)

    const res = await f(`${DOM_ORIGIN}/api/v1/ping?a=1&b=two`)
    expect(location.protocol).toBe('file:')
    await f(new URL('/api/v1/search', DOM_ORIGIN))
    await f('api/v1/intervals', { method: 'post' })

    expect(sent(call)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/v1/ping', query: { a: '1', b: 'two' } }),
      expect.objectContaining({ method: 'GET', path: '/api/v1/search' }),
      expect.objectContaining({ method: 'POST', path: '/api/v1/intervals' }),
    ])
    expect(sent(call)[1]).not.toHaveProperty('query')
    expect(sent(call)[1]).not.toHaveProperty('body')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.statusText).toBe('Forbidden')
  })

  describe('a Request input', () => {
    // jsdom has no fetch classes, so Node's own Request (WHATWG fetch, in Node's main context
    // outside jsdom's window) stands in for the WebView's. It takes a signal of its own realm.
    const NodeRequest = runInThisContext('Request') as typeof Request
    const NodeAbortController = runInThisContext('AbortController') as typeof AbortController

    test("a Request's url, method and signal are used; a Request's own body is refused", async () => {
      const { call, client } = bridged((m) =>
        m.kind === 'request' && m.path === '/slow' ? new Promise<DomReply>(() => {}) : HISTORY,
      )
      const f = createBridgedFetch(client)
      await f(new NodeRequest(`${DOM_ORIGIN}/api/v1/search?q=INF`, { method: 'post' }), {
        body: '{"query":"INF"}',
      })
      expect(sent(call)[0]).toMatchObject({
        kind: 'request',
        method: 'POST',
        path: '/api/v1/search',
        query: { q: 'INF' },
        body: { query: 'INF' },
      })

      const aborted = new NodeAbortController()
      aborted.abort()
      const early = new NodeRequest(`${DOM_ORIGIN}/a`, { signal: aborted.signal })
      await expect(f(early)).rejects.toMatchObject({ name: 'AbortError' })
      const withBody = new NodeRequest(`${DOM_ORIGIN}/a`, { method: 'POST', body: '{}' })
      await expect(f(withBody)).rejects.toThrow(TypeError)
      expect(call).toHaveBeenCalledTimes(1)

      // The Request's signal aborts a request in flight, and native is told its rid.
      const ctl = new NodeAbortController()
      const p = f(new NodeRequest(`${DOM_ORIGIN}/slow`, { signal: ctl.signal }))
      await flush()
      ctl.abort()
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
      const [, slow, abort] = sent(call)
      expect(slow).toMatchObject({ kind: 'request', method: 'GET', path: '/slow' })
      expect(abort).toEqual({ v: 1, kind: 'abort', rid: (slow as { rid: number }).rid })
    })

    test('a relative Request resolves against the file:// page and is refused', async () => {
      const { call, client } = bridged(() => HISTORY)
      const f = createBridgedFetch(client)
      // The WebView's new Request('/api/v1/history') resolves the path against the page's file://
      // URL. Node's Request has no page to resolve against, so the test resolves it the same way.
      const req = new NodeRequest(new URL('/api/v1/history', document.baseURI))
      expect(req.url).toBe('file:///api/v1/history')
      await expect(f(req)).rejects.toThrow(TypeError)
      expect(call).not.toHaveBeenCalled()
    })
  })

  test('every rid on the page comes from one sequence: two fetches on two clients and nextRid', async () => {
    const a = bridged(() => HISTORY)
    const b = bridged(() => HISTORY)
    const f = createBridgedFetch(a.client)
    const g = createBridgedFetch(b.client)
    const first = nextRid()
    await Promise.all([f('/a'), g('/b'), f('/c'), g('/d')])
    const last = nextRid()

    const rids = [...sent(a.call), ...sent(b.call)].map((m) => (m as { rid: number }).rid)
    expect(new Set(rids).size).toBe(4)
    for (const rid of rids) {
      expect(rid).toBeGreaterThan(first)
      expect(rid).toBeLessThan(last)
    }
    expect(last).toBe(first + 5)
  })

  test('an absolute URL to another host rejects and is never bridged', async () => {
    const { call, client } = bridged(() => HISTORY)
    const f = createBridgedFetch(client)
    for (const url of [
      'https://example.com/api/v1/history',
      '//example.com/api/v1/history',
      'http://native.invalid/api/v1/history',
      'file:///android_asset/www.bundle/x.html',
      'wss://native.invalid/ws',
    ]) {
      await expect(f(url)).rejects.toThrow(TypeError)
    }
    expect(call).not.toHaveBeenCalled()
  })

  test('only GET and POST with a JSON body are bridged', async () => {
    const { call, client } = bridged(() => HISTORY)
    const f = createBridgedFetch(client)
    await expect(f('/api/v1/x', { method: 'PUT', body: '{}' })).rejects.toThrow(TypeError)
    await expect(f('/api/v1/x', { method: 'POST', body: 'not json' })).rejects.toThrow(TypeError)
    await expect(f('/api/v1/x', { method: 'POST', body: new Blob(['{}']) })).rejects.toThrow(
      TypeError,
    )
    await expect(f('/api/v1/x', { method: 'GET', body: '{}' })).rejects.toThrow(TypeError)
    expect(call).not.toHaveBeenCalled()
  })

  test('an aborted request rejects with AbortError and posts abort with its rid', async () => {
    const { call, client } = bridged((m) =>
      m.kind === 'request' ? new Promise<DomReply>(() => {}) : ACCEPTED,
    )
    const f = createBridgedFetch(client)
    const ctl = new AbortController()

    const p = f('/api/v1/history', { method: 'POST', body: '{}', signal: ctl.signal })
    await flush()
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })

    const [req, abort] = sent(call)
    expect(req).toMatchObject({ kind: 'request' })
    expect(abort).toEqual({ v: 1, kind: 'abort', rid: (req as { rid: number }).rid })
    expect(call).toHaveBeenCalledTimes(2)

    // Already aborted: rejects at once and nothing crosses the bridge.
    await expect(f('/api/v1/history', { signal: ctl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(call).toHaveBeenCalledTimes(2)
  })

  test('an abort after the reply posts nothing', async () => {
    const { call, client } = bridged(() => HISTORY)
    const ctl = new AbortController()
    await createBridgedFetch(client)('/api/v1/history', { signal: ctl.signal })
    ctl.abort()
    expect(call).toHaveBeenCalledTimes(1)
  })

  test('a broken bridge rejects like a network failure', async () => {
    const client = createDomClient(async () => {
      throw new Error('bridge down')
    })
    await expect(createBridgedFetch(client)('/api/v1/history')).rejects.toThrow(TypeError)
  })
})

describe('socket', () => {
  const sockets = (call: jest.Mock) =>
    sent(call).filter((m): m is Extract<DomToNative, { kind: 'socket' }> => m.kind === 'socket')

  test('the socket opens, carries frames and closes as native says', async () => {
    const { call, client } = bridged()
    const ws = createBridgedSocketFactory(client)(DOM_WS_URL)
    const onopen = jest.fn()
    const onmessage = jest.fn()
    const onclose = jest.fn()
    Object.assign(ws, { onopen, onmessage, onclose })

    expect(ws.readyState).toBe(0)
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
    expect(onopen).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(1)

    ws.send('{"action":"authenticate"}')
    expect(sockets(call)[1]).toEqual({
      v: 1,
      kind: 'socket',
      sid,
      op: 'send',
      data: '{"action":"authenticate"}',
    })

    client.deliver([
      { kind: 'socket', sid, event: 'message', data: '{"type":"auth","status":"success"}' },
      { kind: 'socket', sid: sid + 1, event: 'message', data: 'not mine' },
    ])
    expect(onmessage).toHaveBeenCalledTimes(1)
    expect(onmessage).toHaveBeenCalledWith({ data: '{"type":"auth","status":"success"}' })

    client.deliver([{ kind: 'socket', sid, event: 'close' }])
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(3)

    // Closed by native: nothing more is sent, and close() posts nothing.
    ws.send('late')
    ws.close()
    client.deliver([{ kind: 'socket', sid, event: 'message', data: 'after' }])
    await flush()
    expect(sockets(call).map((m) => m.op)).toEqual(['open', 'send'])
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(onmessage).toHaveBeenCalledTimes(1)
  })

  test('send before open is dropped; close() posts close once and fires onclose', () => {
    const { call, client } = bridged()
    const ws = createBridgedSocketFactory(client)(DOM_WS_URL)
    const onopen = jest.fn()
    const onclose = jest.fn()
    Object.assign(ws, { onopen, onclose })

    ws.send('early')
    ws.close()
    ws.close()
    expect(sockets(call).map((m) => m.op)).toEqual(['open', 'close'])
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(3)

    // A late open for the closed socket is not delivered.
    const sid = (sockets(call)[0] as { sid: number }).sid
    client.deliver([{ kind: 'socket', sid, event: 'open' }])
    expect(onopen).not.toHaveBeenCalled()
  })

  test('an open native refuses closes the socket', async () => {
    const { client } = bridged((m) => (m.kind === 'socket' && m.op === 'open' ? REFUSED : ACCEPTED))
    const ws = createBridgedSocketFactory(client)('wss://elsewhere.example/ws')
    const onclose = jest.fn()
    ws.onclose = onclose
    await flush()
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(3)
  })

  test('the channel gives each socket its own sid', () => {
    const { call, client } = bridged()
    const channel = createSocketChannel(client)
    const a = { onOpen: jest.fn(), onMessage: jest.fn(), onClose: jest.fn() }
    const b = { onOpen: jest.fn(), onMessage: jest.fn(), onClose: jest.fn() }
    channel.open(DOM_WS_URL, a)
    const bConn = channel.open(DOM_WS_URL, b)
    const [sa, sb] = sockets(call).map((m) => m.sid)
    expect(sa).not.toBe(sb)

    client.deliver([
      { kind: 'socket', sid: sa as number, event: 'open' },
      { kind: 'socket', sid: sb as number, event: 'open' },
      { kind: 'socket', sid: sb as number, event: 'message', data: 'for b' },
    ])
    expect(a.onMessage).not.toHaveBeenCalled()
    expect(b.onMessage).toHaveBeenCalledWith('for b')
    bConn.close()
    expect(b.onClose).toHaveBeenCalledTimes(1)
    expect(a.onClose).not.toHaveBeenCalled()
  })
})

describe('storage', () => {
  const KEY = 'oac-widget:chart:drawings:NSE:INFY'

  test('storage entries, get, set and remove go over the bridge; a refused set rejects', async () => {
    const { call, client } = bridged((m) => {
      if (m.kind !== 'storage') return REFUSED
      switch (m.op) {
        case 'entries':
          return { status: 200, body: [[KEY, '[]']] }
        case 'get':
          return { status: 200, body: m.key === KEY ? '[]' : null }
        case 'set':
          return m.value.length > 10 ? { status: 413, body: null } : { status: 204, body: null }
        case 'remove':
          return { status: 204, body: null }
      }
    })
    const store = createBridgedStorage(client)

    await expect(store.entries('oac-widget:chart:')).resolves.toEqual([[KEY, '[]']])
    await expect(store.getItem?.(KEY)).resolves.toBe('[]')
    await expect(store.getItem?.('oac-widget:chart:none')).resolves.toBeNull()
    await expect(store.setItem(KEY, '[1]')).resolves.toBeUndefined()
    await expect(store.removeItem(KEY)).resolves.toBeUndefined()
    await expect(store.setItem(KEY, 'x'.repeat(11))).rejects.toThrow('413')

    expect(sent(call)).toEqual([
      { v: 1, kind: 'storage', op: 'entries', prefix: 'oac-widget:chart:' },
      { v: 1, kind: 'storage', op: 'get', key: KEY },
      { v: 1, kind: 'storage', op: 'get', key: 'oac-widget:chart:none' },
      { v: 1, kind: 'storage', op: 'set', key: KEY, value: '[1]' },
      { v: 1, kind: 'storage', op: 'remove', key: KEY },
      { v: 1, kind: 'storage', op: 'set', key: KEY, value: 'x'.repeat(11) },
    ])
  })

  test('a refused read or a malformed reply rejects', async () => {
    const replies: DomReply[] = [
      REFUSED,
      { status: 200, body: [[KEY]] },
      { status: 200, body: { k: 'v' } },
      { status: 200, body: 5 },
      { status: 403, body: null },
    ]
    const { client } = bridged(() => replies.shift() as DomReply)
    const store = createBridgedStorage(client)
    await expect(store.entries('oac-widget:')).rejects.toThrow('400')
    await expect(store.entries('oac-widget:')).rejects.toThrow('entries')
    await expect(store.entries('oac-widget:')).rejects.toThrow('entries')
    await expect(store.getItem?.(KEY)).rejects.toThrow('get')
    await expect(store.removeItem(KEY)).rejects.toThrow('403')
  })

  test('the journal is the one given, else none', () => {
    const { client } = bridged()
    const journal = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    expect(createBridgedStorage(client, journal).journal).toBe(journal)
    expect(createBridgedStorage(client).journal).toBeNull()
    expect(createBridgedStorage(client, null).journal).toBeNull()
  })

  describe('safeLocalStorage', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage')
    afterEach(() => {
      if (own) Object.defineProperty(window, 'localStorage', own)
      else delete (window as { localStorage?: Storage }).localStorage
    })
    const use = (d: PropertyDescriptor) =>
      Object.defineProperty(window, 'localStorage', { configurable: true, ...d })

    test('it is the page storage when it works, else null', () => {
      // This file:// page has none.
      expect(safeLocalStorage()).toBeNull()

      const data = new Map<string, string>()
      const working = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      }
      use({ value: working })
      expect(safeLocalStorage()).toBe(working)
      expect(data.size).toBe(0)

      use({
        get: () => {
          throw new DOMException('denied', 'SecurityError')
        },
      })
      expect(safeLocalStorage()).toBeNull()

      use({
        value: {
          ...working,
          setItem: () => {
            throw new DOMException('full', 'QuotaExceededError')
          },
        },
      })
      expect(safeLocalStorage()).toBeNull()
    })
  })
})
