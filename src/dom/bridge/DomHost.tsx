// The native side of a DOM page (design 7.7): the one function the page may call (`bridge`, every
// message checked with zod), the outbox that feeds the page once it has loaded, and the WebView
// settings it runs with.
//
// Design 7.7 also limits the WebView's origins and file access. @expo/dom-webview cannot: it
// ignores originWhitelist and allowFileAccess*, and file access is always on
// (DomWebView.types.d.ts:222-236). The page's CSP and link guard (src/dom/web) carry that limit,
// and the 0.2.0 device test checks it.
import type { DOMProps } from 'expo/dom'
import {
  type ComponentType,
  type JSX,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import type { Outbox } from './outbox'
import type {
  DomEntryProps,
  DomEvent,
  DomHandle,
  DomIntentMsg,
  DomReply,
  DomRequest,
  DomSocketMsg,
  DomStorageMsg,
  DomToNative,
  JSONValue,
  NativeToDom,
} from './protocol'
import { parseDomToNative } from './schemas'

export type DomHandlers = {
  request?: (r: DomRequest, signal: AbortSignal) => Promise<DomReply>
  socket?: (m: DomSocketMsg) => void
  storage?: (m: DomStorageMsg) => Promise<DomReply>
  intent?: (m: DomIntentMsg) => void
  event?: (e: DomEvent) => void
}

export const REFUSED_REPLY: DomReply = {
  status: 400,
  body: { status: 'error', message: 'Refused by the app' },
}
export const ACCEPTED_REPLY: DomReply = { status: 202, body: null }

const WARN_EVERY_MS = 10_000
const KINDS: ReadonlySet<string> = new Set([
  'request',
  'abort',
  'socket',
  'storage',
  'intent',
  'event',
])

// The page owns every gesture, so the WebView neither scrolls nor bounces (both iOS only).
// overScrollMode is not an @expo/dom-webview prop: a documented no-op, kept for parity.
const WEBVIEW_DEFAULTS = {
  scrollEnabled: false,
  bounces: false,
  overScrollMode: 'never',
  matchContents: false,
  unstable_useExpoModulesBridge: false,
  webviewDebuggingEnabled: __DEV__,
}

/** The kind to name in a refusal: one of the protocol's, never a string the page made up. */
function kindOf(raw: unknown): string {
  const kind =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as { kind?: unknown }).kind
      : undefined
  return typeof kind === 'string' && KINDS.has(kind) ? kind : 'message'
}

/** An https URL with a host, and no whitespace or control character anywhere. */
function isHttpsLink(url: string): boolean {
  if (!/^https:\/\/[^/?#\\]/i.test(url) || /\s/.test(url)) return false
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

type Live = { handlers: DomHandlers; outbox: Outbox; onGone: () => void }

/** One host's state. It lives as long as the host: a remount (a new `key`) makes a new one. */
function createHost(initial: Live) {
  let live = initial
  let loaded = false
  let lastWarn = Number.NEGATIVE_INFINITY
  const inflight = new Map<number, AbortController>()
  // The page's ref. Expo's wrapper fills a ref only while it is null and never clears it (spike
  // CHANGES.chart.md §9), so each host starts its own at null: a remounted page never inherits
  // the dead WebView's proxy.
  const handle: { current: DomHandle | null } = { current: null }

  // At most one line per 10 s, and never the page's payload.
  const warn = (msg: string, e?: unknown) => {
    const now = Date.now()
    if (now - lastWarn < WARN_EVERY_MS) return
    lastWarn = now
    if (e === undefined) log.warn('dom', msg)
    else log.warn('dom', msg, e)
  }
  const refuse = (what: string): DomReply => {
    warn(`refused ${what}`)
    return REFUSED_REPLY
  }

  // The proxy answers `deliver` only once the page has registered its handle, so until then the
  // batch stays queued (preflight conflict 12).
  const deliver = (batch: NativeToDom[]): boolean => {
    const page = handle.current
    if (typeof page?.deliver !== 'function') return false
    page.deliver(batch)
    return true
  }

  async function request(m: DomRequest): Promise<DomReply> {
    const handler = live.handlers.request
    if (!handler || inflight.has(m.rid)) return refuse('request')
    const ctl = new AbortController()
    inflight.set(m.rid, ctl)
    try {
      return await handler(m, ctl.signal)
    } catch (e) {
      // The page gave up on it and is not waiting for the answer.
      if (ctl.signal.aborted) return REFUSED_REPLY
      throw e
    } finally {
      if (inflight.get(m.rid) === ctl) inflight.delete(m.rid)
    }
  }

  function event(e: DomEvent): DomReply {
    if (e.name === 'link') {
      if (!isHttpsLink(e.url)) return refuse('link')
      Linking.openURL(e.url).catch(() => log.warn('dom', 'could not open a link'))
    }
    if (e.name === 'loaded') {
      loaded = true
      live.outbox.attach(deliver)
    }
    live.handlers.event?.(e)
    return ACCEPTED_REPLY
  }

  async function route(m: DomToNative): Promise<DomReply> {
    const h = live.handlers
    switch (m.kind) {
      case 'request':
        return request(m)
      case 'abort':
        inflight.get(m.rid)?.abort()
        inflight.delete(m.rid)
        return ACCEPTED_REPLY
      case 'socket':
        if (!h.socket) return refuse('socket')
        h.socket(m)
        return ACCEPTED_REPLY
      case 'storage':
        return h.storage ? h.storage(m) : refuse('storage')
      case 'intent':
        if (!h.intent) return refuse('intent')
        h.intent(m)
        return ACCEPTED_REPLY
      case 'event':
        return event(m)
    }
  }

  return {
    handle,
    /** The page's only action. A handler's error never reaches the page (its message or stack
     *  could carry what the WebView must not hold); the page gets the refusal. */
    async bridge(raw: JSONValue): Promise<JSONValue> {
      const parsed = parseDomToNative(raw)
      if (!parsed.success) return refuse(kindOf(raw))
      try {
        return await route(parsed.data)
      } catch (e) {
        warn(`failed ${parsed.data.kind}`, e)
        return REFUSED_REPLY
      }
    },
    gone() {
      loaded = false
      live.outbox.detach()
      live.onGone()
    },
    update(next: Live) {
      live = next
    },
    // React may run the cleanup and the setup again on the same host, so the setup re-attaches a
    // page that had loaded. The cleanup stops deliveries and aborts what is in flight.
    mount(): () => void {
      if (loaded) live.outbox.attach(deliver)
      return () => {
        live.outbox.detach()
        for (const c of inflight.values()) c.abort()
        inflight.clear()
      }
    },
  }
}

export type DomHostProps<P extends object> = {
  /** The page's 'use dom' entry; constant for the host's life. */
  Dom: ComponentType<P & DomEntryProps>
  /** What the page gets as props: JSON, as expo sends it. An equal object is the same props. */
  props: P
  handlers: DomHandlers
  outbox: Outbox
  /** Added to the WebView defaults; pass a constant, since a new object re-renders the page. */
  webview?: Partial<DOMProps>
  testID: string
  onGone: () => void
}

function DomHostView<P extends object>({
  Dom,
  props,
  handlers,
  outbox,
  webview,
  testID,
  onGone,
}: DomHostProps<P>): JSX.Element {
  const [host] = useState(() => createHost({ handlers, outbox, onGone }))
  useLayoutEffect(() => {
    host.update({ handlers, outbox, onGone })
  }, [host, handlers, outbox, onGone])
  useEffect(() => host.mount(), [host])

  // Expo's wrapper re-sends every prop, and the page re-renders its whole tree, each time the
  // page element renders (spike CHANGES.chart.md §9). So the element stays the same until what the
  // page sees changes. Props go through JSON as expo marshals them: an equal object is the same
  // props, and no function but `bridge` reaches the page (design 7.7: only the typed actions).
  const json = JSON.stringify(props)
  const pageProps = useMemo(() => JSON.parse(json) as P, [json])
  const dom = useMemo<DOMProps>(
    () => ({
      ...WEBVIEW_DEFAULTS,
      ...webview,
      unstable_useExpoModulesBridge: false,
      onRenderProcessGone: host.gone,
      onContentProcessDidTerminate: host.gone,
    }),
    [webview, host],
  )
  const page = useMemo(
    () => <Dom {...pageProps} bridge={host.bridge} dom={dom} ref={host.handle} />,
    [Dom, pageProps, dom, host],
  )
  return (
    <View testID={testID} style={styles.fill}>
      {page}
    </View>
  )
}

/** Hosts one DOM page. Wrapped in `memo`; a parent that re-renders with equal props does not
 *  re-render the page. */
export const DomHost = memo(DomHostView) as typeof DomHostView

const styles = StyleSheet.create({ fill: { flex: 1 } })
