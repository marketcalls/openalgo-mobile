import { render, screen } from '@testing-library/react-native'
import { Activity, type ComponentType, forwardRef, useImperativeHandle, useState } from 'react'
import { Linking } from 'react-native'
import { log } from '~/core/log/logger'
import {
  ACCEPTED_REPLY,
  type DomHandlers,
  DomHost,
  LINK_OPEN_EVERY_MS,
  REFUSED_REPLY,
} from './DomHost'
import { createOutbox, OUTBOX_RETRY_MS, type Outbox } from './outbox'
import type {
  DomEntryProps,
  DomHandle,
  DomReply,
  DomRequest,
  JSONValue,
  NativeToDom,
} from './protocol'

type PageProps = { scheme: 'dark' | 'light' }
type Seen = PageProps & DomEntryProps
type Bridge = (m: unknown) => Promise<JSONValue>

/** A frame scheduler the test runs by hand. */
function frames() {
  const due: Array<() => void> = []
  return {
    schedule: (fn: () => void) => {
      due.push(fn)
    },
    pending: () => due.length,
    run: () => {
      for (const fn of due.splice(0)) fn()
    },
  }
}

// The fake page's record: its last props and how often it rendered. fakeDom() resets it.
let seen = { last: null as Seen | null, renders: 0 }
let pageHandle: Partial<DomHandle> = {}

/** A fake 'use dom' page: it records its props and renders, and exposes `pageHandle` as its ref. */
const FakeDom = forwardRef<Partial<DomHandle>, Omit<Seen, 'ref'>>(function FakeDom(props, ref) {
  seen.renders += 1
  seen.last = props
  useImperativeHandle(ref, () => pageHandle, [])
  return null
}) as unknown as ComponentType<Seen>

function fakeDom(handle: Partial<DomHandle> = { deliver: jest.fn() }) {
  seen = { last: null, renders: 0 }
  pageHandle = handle
  return { Dom: FakeDom, seen, handle }
}

// Like expo's WebView wrapper (webview-wrapper.tsx:48): it fills the ref only while it is null and
// never clears it. Each instance is one page, with its own deliver.
const wrapper = { pages: [] as jest.Mock[], latest: null as Seen | null }
function WrapperDom(props: Seen) {
  const [deliver] = useState(() => {
    const d = jest.fn()
    wrapper.pages.push(d)
    return d
  })
  const ref = props.ref as { current: Partial<DomHandle> | null } | undefined
  if (ref && ref.current == null) ref.current = { deliver }
  wrapper.latest = props
  return null
}

async function mount(
  o: {
    handlers?: DomHandlers
    handle?: Partial<DomHandle>
    outbox?: Outbox
    webview?: Record<string, unknown>
    props?: PageProps
    onGone?: () => void
  } = {},
) {
  const page = fakeDom(o.handle)
  const outbox = o.outbox ?? createOutbox({ schedule: () => {} })
  const onGone = o.onGone ?? jest.fn()
  const props: PageProps = o.props ?? { scheme: 'dark' }
  await render(
    <DomHost
      Dom={page.Dom}
      props={props}
      handlers={o.handlers ?? {}}
      outbox={outbox}
      webview={o.webview}
      testID="dom"
      onGone={onGone}
    />,
  )
  const bridge: Bridge = (m) => (page.seen.last as Seen).bridge(m as JSONValue)
  return { ...page, outbox, onGone, bridge }
}

const v = 1 as const
const DARK: PageProps = { scheme: 'dark' }
const loaded = { v, kind: 'event', name: 'loaded' }
const ready = {
  v,
  kind: 'event',
  name: 'ready',
  info: { bars: 3, indicators: 0, mobile: true, csp: true },
}
const push = (n: number): NativeToDom => ({ kind: 'push', topic: 'chart.orders', payload: n })
const req = (rid: number) => ({
  v,
  kind: 'request',
  rid,
  method: 'POST',
  path: '/api/v1/history',
  body: { apikey: '__native__', symbol: 'INFY' },
})
const storageGet = { v, kind: 'storage', op: 'get', key: 'oac-widget:chart:state' }
const socketOpen = { v, kind: 'socket', sid: 0, op: 'open', url: 'wss://native.invalid/ws' }
const inst = { exchange: 'NSE', symbol: 'INFY' }
const intent = { v, kind: 'intent', intent: { type: 'trade', inst, side: 'BUY', lots: 1 } }
const link = (url: string) => ({ v, kind: 'event', name: 'link', url })
const SECRET = 'a'.repeat(64)

function everyHandler() {
  return {
    request: jest.fn(async () => ACCEPTED_REPLY),
    socket: jest.fn(),
    storage: jest.fn(async () => ACCEPTED_REPLY),
    intent: jest.fn(),
    event: jest.fn(),
  }
}

let warn: jest.SpyInstance
beforeEach(() => {
  warn = jest.spyOn(log, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('a malformed message is refused and reaches no handler', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const handlers = everyHandler()
  const { bridge } = await mount({ handlers })
  const malformed: unknown[] = [
    null,
    'loaded',
    [loaded],
    { ...loaded, v: 2 },
    { v, kind: 'eval', code: 'x' },
    { ...loaded, extra: SECRET },
    { ...req(1), rid: -1 },
    { ...req(1), path: '/api/../auth/csrf-token' },
    { ...req(1), method: 'DELETE' },
    { ...storageGet, apikey: SECRET },
    { ...socketOpen, sid: 1000 },
    { ...intent, intent: { ...intent.intent, lots: 0 } },
    { v, kind: 'event', name: 'link', url: 7 },
  ]
  for (const m of malformed) expect(await bridge(m)).toEqual(REFUSED_REPLY)
  for (const h of Object.values(handlers)) expect(h).not.toHaveBeenCalled()

  // One line per 10 s, naming the kind and never the payload.
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('dom', 'refused message')
  now.mockReturnValue(1_009_999)
  await bridge({ ...storageGet, apikey: SECRET })
  expect(warn).toHaveBeenCalledTimes(1)
  now.mockReturnValue(1_010_000)
  await bridge({ ...storageGet, apikey: SECRET })
  expect(warn).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenLastCalledWith('dom', 'refused storage')
})

test('a request reaches its handler and the reply goes back to the DOM; an abort with its rid aborts its signal', async () => {
  const signals = new Map<number, AbortSignal>()
  const settle = new Map<number, (r: DomReply) => void>()
  const request = jest.fn(
    (r: DomRequest, signal: AbortSignal) =>
      new Promise<DomReply>((resolve) => {
        signals.set(r.rid, signal)
        settle.set(r.rid, resolve)
      }),
  )
  const { bridge } = await mount({ handlers: { request } })

  const first = bridge(req(1))
  const second = bridge(req(2))
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenNthCalledWith(1, req(1), expect.any(AbortSignal))

  // A rid already in flight is refused; an unknown rid's abort is still accepted.
  expect(await bridge(req(2))).toEqual(REFUSED_REPLY)
  expect(request).toHaveBeenCalledTimes(2)
  expect(await bridge({ v, kind: 'abort', rid: 99 })).toEqual(ACCEPTED_REPLY)

  expect(await bridge({ v, kind: 'abort', rid: 1 })).toEqual(ACCEPTED_REPLY)
  expect(signals.get(1)?.aborted).toBe(true)
  expect(signals.get(2)?.aborted).toBe(false)

  const reply: DomReply = { status: 200, body: { status: 'success', data: [] } }
  settle.get(2)?.(reply)
  expect(await second).toEqual(reply)
  settle.get(1)?.(reply)
  expect(await first).toEqual(reply)

  // Once settled, the rid may be used again.
  bridge(req(2))
  expect(request).toHaveBeenCalledTimes(3)
})

test('socket, storage and intent messages reach their own handlers', async () => {
  const handlers = everyHandler()
  const stored: DomReply = { status: 200, body: { status: 'success', data: 'x' } }
  handlers.storage.mockResolvedValue(stored)
  const { bridge } = await mount({ handlers })

  expect(await bridge(socketOpen)).toEqual(ACCEPTED_REPLY)
  expect(handlers.socket).toHaveBeenCalledWith(socketOpen)
  expect(await bridge(storageGet)).toEqual(stored)
  expect(handlers.storage).toHaveBeenCalledWith(storageGet)
  expect(await bridge(intent)).toEqual(ACCEPTED_REPLY)
  expect(handlers.intent).toHaveBeenCalledWith(intent)
  expect(await bridge(ready)).toEqual(ACCEPTED_REPLY)
  expect(handlers.event).toHaveBeenCalledWith(ready)
  expect(warn).not.toHaveBeenCalled()
})

test('a kind with no handler is refused', async () => {
  const { bridge } = await mount({ handlers: {} })
  expect(await bridge(storageGet)).toEqual(REFUSED_REPLY)
  expect(warn).toHaveBeenCalledWith('dom', 'refused storage')
  for (const m of [req(1), socketOpen, intent]) expect(await bridge(m)).toEqual(REFUSED_REPLY)
  // Events are the host's own (loaded, link), so they need no event handler.
  expect(await bridge(ready)).toEqual(ACCEPTED_REPLY)
})

test('a handler that throws or rejects gives the refusal, never its error', async () => {
  const { bridge } = await mount({
    handlers: {
      storage: () => Promise.reject(new Error('https://server.example/api/v1 failed')),
      intent: () => {
        throw new Error('boom')
      },
    },
  })
  expect(await bridge(storageGet)).toEqual(REFUSED_REPLY)
  expect(await bridge(intent)).toEqual(REFUSED_REPLY)
})

test('a handler failure is logged under its own 10 s limit, so refusals cannot hide it', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const { bridge } = await mount({
    handlers: { storage: () => Promise.reject(new Error('disk full')) },
  })
  // A flood of malformed messages uses up the refusals' line.
  for (let i = 0; i < 50; i++) await bridge({ v, kind: 'eval', code: String(i) })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenLastCalledWith('dom', 'refused message')

  // The failed storage write still gets its line.
  expect(await bridge({ ...storageGet, op: 'set', value: 'x' })).toEqual(REFUSED_REPLY)
  expect(warn).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenLastCalledWith('dom', 'failed storage', expect.any(Error))

  // Failures have a 10 s limit of their own.
  now.mockReturnValue(1_009_999)
  await bridge(storageGet)
  expect(warn).toHaveBeenCalledTimes(2)
  now.mockReturnValue(1_010_000)
  await bridge(storageGet)
  expect(warn).toHaveBeenCalledTimes(3)
  expect(warn).toHaveBeenLastCalledWith('dom', 'failed storage', expect.any(Error))
})

test('posts wait for loaded, then go once per frame in order', async () => {
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  let pendingAtEvent = -1
  const event = jest.fn(() => {
    pendingAtEvent = f.pending()
  })
  const { bridge, handle } = await mount({ outbox, handlers: { event } })

  outbox.post(push(1))
  outbox.post(push(2))
  outbox.post(push(3))
  expect(f.pending()).toBe(0)

  await bridge(loaded)
  // The outbox was attached before the event reached the screen's handler.
  expect(event).toHaveBeenCalledWith(loaded)
  expect(pendingAtEvent).toBe(1)
  expect(handle.deliver).not.toHaveBeenCalled()

  f.run()
  expect(handle.deliver).toHaveBeenCalledTimes(1)
  expect(handle.deliver).toHaveBeenCalledWith([push(1), push(2), push(3)])

  outbox.post(push(4))
  outbox.post(push(5))
  expect(f.pending()).toBe(1)
  f.run()
  expect(handle.deliver).toHaveBeenLastCalledWith([push(4), push(5)])
  expect(f.pending()).toBe(0)
})

test('a frame delivers at most maxBatch, and the rest go the next frame', () => {
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule, maxBatch: 2 })
  const deliver = jest.fn()
  for (const n of [1, 2, 3]) outbox.post(push(n))
  outbox.attach(deliver)
  f.run()
  expect(deliver).toHaveBeenLastCalledWith([push(1), push(2)])
  f.run()
  expect(deliver).toHaveBeenLastCalledWith([push(3)])
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(f.pending()).toBe(0)
})

test('a deliver that throws keeps its batch first, logs once per 10 s, and tries again after 250 ms', () => {
  jest.useFakeTimers()
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule, maxBatch: 2 })
  for (const n of [1, 2, 3]) outbox.post(push(n))
  const deliver = jest.fn((_b: NativeToDom[]): unknown => {
    throw new Error('the view is gone')
  })
  outbox.attach(deliver)

  // The error stays inside the frame, and nothing is lost.
  expect(() => f.run()).not.toThrow()
  expect(deliver).toHaveBeenCalledWith([push(1), push(2)])
  expect(outbox.stats()).toEqual({ queued: 3, dropped: 0 })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('dom', 'could not deliver to the page', expect.any(Error))

  // Not on the next frame: after 250 ms, even when more is posted meanwhile.
  outbox.post(push(4))
  expect(f.pending()).toBe(0)
  jest.advanceTimersByTime(OUTBOX_RETRY_MS - 1)
  expect(f.pending()).toBe(0)
  jest.advanceTimersByTime(1)
  expect(f.pending()).toBe(1)
  f.run()
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledTimes(1)

  // A failure 10 s after the last line gets a new one.
  jest.advanceTimersByTime(10_000)
  f.run()
  expect(deliver).toHaveBeenCalledTimes(3)
  expect(warn).toHaveBeenCalledTimes(2)

  // Once the page takes it, the batch goes first and the rest follow, one frame each.
  deliver.mockImplementation(() => undefined)
  jest.advanceTimersByTime(OUTBOX_RETRY_MS)
  f.run()
  expect(deliver).toHaveBeenLastCalledWith([push(1), push(2)])
  f.run()
  expect(deliver).toHaveBeenLastCalledWith([push(3), push(4)])
  expect(outbox.stats()).toEqual({ queued: 0, dropped: 0 })
  expect(f.pending()).toBe(0)
})

test('a batch the page does not take waits 250 ms, not a frame, and goes at once on the next attach', () => {
  jest.useFakeTimers()
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  let takes = false
  const deliver = jest.fn((_b: NativeToDom[]) => takes)
  outbox.post(push(1))
  outbox.attach(deliver)
  f.run()
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(f.pending()).toBe(0)

  outbox.post(push(2))
  expect(f.pending()).toBe(0)
  jest.advanceTimersByTime(OUTBOX_RETRY_MS - 1)
  expect(f.pending()).toBe(0)
  jest.advanceTimersByTime(1)
  expect(f.pending()).toBe(1)
  f.run()
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(deliver).toHaveBeenLastCalledWith([push(1), push(2)])

  // A page that never registers its handle: 4 tries a second, not 60.
  for (let i = 0; i < 4; i++) {
    jest.advanceTimersByTime(OUTBOX_RETRY_MS)
    f.run()
  }
  expect(deliver).toHaveBeenCalledTimes(6)
  expect(outbox.stats().queued).toBe(2)
  expect(warn).not.toHaveBeenCalled()

  // The page loads (a new attach): the next frame offers it, with no wait for the retry.
  takes = true
  outbox.attach(deliver)
  expect(f.pending()).toBe(1)
  f.run()
  expect(deliver).toHaveBeenCalledTimes(7)
  expect(outbox.stats().queued).toBe(0)
  // The cancelled retry never fires.
  jest.advanceTimersByTime(OUTBOX_RETRY_MS)
  expect(f.pending()).toBe(0)
  expect(deliver).toHaveBeenCalledTimes(7)

  // A detach while a retry waits leaves no timer behind.
  takes = false
  outbox.post(push(3))
  f.run()
  expect(jest.getTimerCount()).toBe(1)
  outbox.detach()
  expect(jest.getTimerCount()).toBe(0)
})

test('past 2,000 queued the oldest go and are counted; clear drops the queue', () => {
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  for (let n = 0; n < 2005; n++) outbox.post(push(n))
  expect(outbox.stats()).toEqual({ queued: 2000, dropped: 5 })

  const deliver = jest.fn()
  outbox.attach(deliver)
  f.run()
  const batch = deliver.mock.calls[0][0] as NativeToDom[]
  expect(batch).toHaveLength(256)
  expect(batch[0]).toEqual(push(5))
  expect(outbox.stats()).toEqual({ queued: 1744, dropped: 5 })
  expect(f.pending()).toBe(1)

  outbox.clear()
  expect(outbox.stats()).toEqual({ queued: 0, dropped: 5 })
  f.run()
  expect(deliver).toHaveBeenCalledTimes(1)
})

test('a page whose handle has no deliver yet keeps the queue', async () => {
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  const handle: Partial<DomHandle> = {}
  const { bridge } = await mount({ outbox, handle })
  jest.useFakeTimers()

  outbox.post(push(1))
  await bridge(loaded)
  f.run()
  expect(outbox.stats().queued).toBe(1)
  // Offered again after 250 ms, not on every frame.
  expect(f.pending()).toBe(0)
  jest.advanceTimersByTime(OUTBOX_RETRY_MS)
  expect(f.pending()).toBe(1)
  f.run()
  expect(outbox.stats().queued).toBe(1)

  // The page registers its handle and says 'loaded' again: the next frame delivers what was
  // kept, without waiting out the retry.
  const deliver = jest.fn()
  handle.deliver = deliver
  await bridge(loaded)
  expect(f.pending()).toBe(1)
  f.run()
  expect(deliver).toHaveBeenCalledWith([push(1)])
  expect(outbox.stats().queued).toBe(0)
  expect(f.pending()).toBe(0)
  expect(jest.getTimerCount()).toBe(0)
})

test('a parent re-render with the same props does not re-render the DOM', async () => {
  const page = fakeDom()
  const outbox = createOutbox({ schedule: () => {} })
  const first = jest.fn()
  const second = jest.fn()
  // Every render passes new objects, as a screen does.
  const host = (scheme: PageProps['scheme'], event: () => void) => (
    <DomHost
      Dom={page.Dom}
      props={{ scheme }}
      handlers={{ event }}
      outbox={outbox}
      testID="dom"
      onGone={() => {}}
    />
  )
  await render(host('dark', first))
  const bridge = page.seen.last?.bridge
  expect(page.seen.renders).toBe(1)

  await screen.rerender(host('dark', second))
  expect(page.seen.renders).toBe(1)
  // The page keeps its bridge, and it reaches the new handlers.
  await bridge?.(ready)
  expect(second).toHaveBeenCalledWith(ready)
  expect(first).not.toHaveBeenCalled()

  await screen.rerender(host('light', second))
  expect(page.seen.renders).toBe(2)
  expect(page.seen.last?.scheme).toBe('light')
  expect(page.seen.last?.bridge).toBe(bridge)
})

test('the page gets its props, the bridge and the WebView settings, and no other function', async () => {
  const leaky = { scheme: 'dark', run: () => SECRET } as PageProps
  const { seen } = await mount({ props: leaky })
  expect(screen.getByTestId('dom')).toBeOnTheScreen()
  expect(Object.keys(seen.last ?? {}).sort()).toEqual(['bridge', 'dom', 'scheme'])
  // The defaults plus the two process-gone handlers, exactly.
  expect(seen.last?.dom).toEqual({
    scrollEnabled: false,
    bounces: false,
    overScrollMode: 'never',
    matchContents: false,
    unstable_useExpoModulesBridge: false,
    webviewDebuggingEnabled: __DEV__,
    onRenderProcessGone: expect.any(Function),
    onContentProcessDidTerminate: expect.any(Function),
  })
})

test('the screen may add WebView settings but not turn the modules bridge on', async () => {
  const style = { flex: 1 }
  const { seen } = await mount({
    webview: { style, bounces: true, unstable_useExpoModulesBridge: true },
  })
  expect(seen.last?.dom).toMatchObject({
    style,
    bounces: true,
    unstable_useExpoModulesBridge: false,
  })
})

test('an https link opens in the browser and other schemes do not', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  // React Native's jest setup makes openURL a shared jest.fn, so its calls carry over: clear them.
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  open.mockClear()
  const event = jest.fn()
  const { bridge } = await mount({ handlers: { event } })

  expect(await bridge(link('https://openalgo.in/docs?x=1#y'))).toEqual(ACCEPTED_REPLY)
  expect(open).toHaveBeenCalledWith('https://openalgo.in/docs?x=1#y')
  expect(event).toHaveBeenCalledWith(link('https://openalgo.in/docs?x=1#y'))

  const others = [
    'http://openalgo.in',
    'javascript:alert(1)',
    'intent://scan#Intent;scheme=zxing;end',
    'file:///data/data/x',
    'mailto:a@b.c',
    'upi://pay?pa=x',
    'https:openalgo.in',
    'https:///openalgo.in',
    ' https://openalgo.in',
    'https://openalgo.in/a b',
    'https://openalgo.in/\u0000',
  ]
  for (const url of others) expect(await bridge(link(url))).toEqual(REFUSED_REPLY)
  expect(open).toHaveBeenCalledTimes(1)
  expect(event).toHaveBeenCalledTimes(1)

  // A browser that cannot open is only logged.
  now.mockReturnValue(1_000_000 + LINK_OPEN_EVERY_MS)
  open.mockRejectedValueOnce(new Error('no browser'))
  expect(await bridge(link('https://openalgo.in'))).toEqual(ACCEPTED_REPLY)
  await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenLastCalledWith('dom', 'could not open a link')
})

test('a page opens at most one link per 2 s; the rest are dropped with the limited warning', async () => {
  expect(LINK_OPEN_EVERY_MS).toBe(2000)
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  // React Native's jest setup makes openURL a shared jest.fn, so its calls carry over: clear them.
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  open.mockClear()
  const event = jest.fn()
  const { bridge } = await mount({ handlers: { event } })

  expect(await bridge(link('https://openalgo.in/a'))).toEqual(ACCEPTED_REPLY)
  now.mockReturnValue(1_000_000 + LINK_OPEN_EVERY_MS - 1)
  for (const p of ['b', 'c', 'd']) {
    expect(await bridge(link(`https://openalgo.in/${p}`))).toEqual(REFUSED_REPLY)
  }
  expect(open).toHaveBeenCalledTimes(1)
  expect(event).toHaveBeenCalledTimes(1)
  // One line for the three, through the refusals' 10 s limit.
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith('dom', 'refused link')

  // 2 s after the last open, the next one opens; a dropped link did not restart the 2 s.
  now.mockReturnValue(1_000_000 + LINK_OPEN_EVERY_MS)
  expect(await bridge(link('https://openalgo.in/e'))).toEqual(ACCEPTED_REPLY)
  expect(open).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenLastCalledWith('https://openalgo.in/e')
  expect(event).toHaveBeenLastCalledWith(link('https://openalgo.in/e'))
  expect(warn).toHaveBeenCalledTimes(1)
})

test.each(['onRenderProcessGone', 'onContentProcessDidTerminate'] as const)(
  'a killed WebView detaches the outbox and calls onGone (RF 3): %s',
  async (name) => {
    const f = frames()
    const outbox = createOutbox({ schedule: f.schedule })
    let pendingAtGone = -1
    const onGone = jest.fn(() => {
      outbox.post(push(2))
      pendingAtGone = f.pending()
    })
    const { bridge, seen, handle } = await mount({ outbox, onGone })
    await bridge(loaded)
    outbox.post(push(1))
    f.run()
    expect(handle.deliver).toHaveBeenCalledTimes(1)

    const dom = seen.last?.dom as Record<typeof name, () => void>
    dom[name]()
    expect(onGone).toHaveBeenCalledTimes(1)
    // Detached first: what onGone posts waits for the next page.
    expect(pendingAtGone).toBe(0)
    expect(outbox.stats().queued).toBe(1)
    expect(handle.deliver).toHaveBeenCalledTimes(1)
  },
)

test('a remount (a new key) starts from an empty handle and delivers to the new page only', async () => {
  wrapper.pages = []
  wrapper.latest = null
  const pages = wrapper.pages
  const bridge: Bridge = (m) => (wrapper.latest as Seen).bridge(m as JSONValue)
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  const signals: AbortSignal[] = []
  const request = jest.fn(
    (_r: DomRequest, signal: AbortSignal) =>
      new Promise<DomReply>(() => {
        signals.push(signal)
      }),
  )
  const host = (key: number) => (
    <DomHost
      key={key}
      Dom={WrapperDom}
      props={{ scheme: 'dark' }}
      handlers={{ request }}
      outbox={outbox}
      testID="dom"
      onGone={() => {}}
    />
  )

  await render(host(1))
  await bridge(loaded)
  bridge(req(1))
  outbox.post(push(1))
  f.run()
  expect(pages[0]).toHaveBeenCalledWith([push(1)])

  await screen.rerender(host(2))
  expect(pages).toHaveLength(2)
  // The old page's request is aborted and the outbox waits for the new page.
  expect(signals[0]?.aborted).toBe(true)
  outbox.post(push(2))
  expect(f.pending()).toBe(0)

  await bridge(loaded)
  f.run()
  expect(pages[1]).toHaveBeenCalledWith([push(2)])
  expect(pages[0]).toHaveBeenCalledTimes(1)
})

test('the outbox is constant for the host life: a new one is ignored, with one warning in development', async () => {
  const page = fakeDom()
  const f = frames()
  const first = createOutbox({ schedule: f.schedule })
  const second = createOutbox({ schedule: f.schedule })
  const host = (outbox: Outbox) => (
    <DomHost
      Dom={page.Dom}
      props={DARK}
      handlers={{}}
      outbox={outbox}
      testID="dom"
      onGone={() => {}}
    />
  )
  await render(host(first))
  await screen.rerender(host(second))
  await screen.rerender(host(createOutbox({ schedule: f.schedule })))
  expect(page.seen.renders).toBe(1)
  expect(__DEV__).toBe(true)
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith(
    'dom',
    'DomHost keeps its first outbox: give the host a new key to change it',
  )

  // 'loaded' attaches the first outbox, and only it.
  first.post(push(1))
  second.post(push(2))
  await page.seen.last?.bridge(loaded as JSONValue)
  f.run()
  expect(page.handle.deliver).toHaveBeenCalledTimes(1)
  expect(page.handle.deliver).toHaveBeenCalledWith([push(1)])
  expect(second.stats().queued).toBe(1)

  // The unmount detaches the outbox that was attached.
  await screen.unmount()
  first.post(push(3))
  expect(f.pending()).toBe(0)
})

test('a page that had loaded is attached again when React runs the effects again (Activity)', async () => {
  const page = fakeDom()
  const f = frames()
  const outbox = createOutbox({ schedule: f.schedule })
  const host = (mode: 'visible' | 'hidden') => (
    <Activity mode={mode}>
      <DomHost
        Dom={page.Dom}
        props={DARK}
        handlers={{}}
        outbox={outbox}
        testID="dom"
        onGone={() => {}}
      />
    </Activity>
  )
  await render(host('visible'))

  // Before 'loaded', hiding and showing again attaches nothing.
  await screen.rerender(host('hidden'))
  await screen.rerender(host('visible'))
  outbox.post(push(1))
  expect(f.pending()).toBe(0)

  await page.seen.last?.bridge(loaded as JSONValue)
  f.run()
  expect(page.handle.deliver).toHaveBeenLastCalledWith([push(1)])

  // Hidden: the effect's cleanup detaches.
  await screen.rerender(host('hidden'))
  outbox.post(push(2))
  expect(f.pending()).toBe(0)

  // Shown again: the setup attaches the loaded page again, with no new 'loaded'.
  await screen.rerender(host('visible'))
  expect(f.pending()).toBe(1)
  f.run()
  expect(page.handle.deliver).toHaveBeenLastCalledWith([push(2)])
  expect(page.handle.deliver).toHaveBeenCalledTimes(2)
})
