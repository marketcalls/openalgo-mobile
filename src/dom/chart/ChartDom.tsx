'use dom'
// The chart page (design 7.9): the openalgo-charts widget in an Expo DOM component. Native sends
// everything as pushes (CHART_TOPICS) through the outbox; the page answers with events, and its
// history, search, socket and storage cross the same typed bridge. The page holds no key, no
// server address and no socket, and it places nothing.
//
// A 'use dom' file exports only its default component (types aside), so the page's lifecycle
// lives here unexported; the pieces it puts together are in the modules beside it.
import '~/dom/web/prelude'
import './eagerChunks'
import './tiers'

import { useDOMImperativeHandle } from 'expo/dom'
import { type OpenAlgoLiveDataFeed, registeredIndicators } from 'openalgo-charts'
import { createWidget, type Widget, type WidgetBusEvents } from 'openalgo-charts/widget'
import { type CSSProperties, type JSX, useEffect, useRef, useState } from 'react'
import {
  type CalendarSpecJson,
  CHART_TOPICS,
  type ChartDomProps,
  type ChartInit,
  type DomEntryProps,
  type DomEvent,
  type JSONValue,
} from '~/dom/bridge/protocol'
import { createDomClient, type DomClient } from '~/dom/web/client'
import { probeCsp } from '~/dom/web/csp'
import { guardLinks } from '~/dom/web/links'
import { createBridgedStorage, safeLocalStorage } from '~/dom/web/storage'
import type { SessionCalendars } from './calendars'
import { createChartFeeds } from './feeds'
import { DOM_BUNDLE } from './marker'
import { chartTheme, keepAppPalette } from './theme'
import { attachTrading, holdTradePushes } from './trading/glue'
import { savedInterval, widgetOptions } from './widgetOptions'

type Scheme = ChartDomProps['scheme']

// The widget injects its own styles; the page adds two rules, NO_ALERTS and BAR_LABELS.
const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'hidden',
  touchAction: 'none',
  userSelect: 'none',
}

/** The bridge's cap on an event message (MAX_MESSAGE in dom/bridge/schemas.ts, native only). */
const MAX_MESSAGE = 500
/**
 * The widget's own alerts are left out (design 7.9): they fire only while this page is open and in
 * front, as a toast on the chart, so the trader would miss one with the app closed. Its Alerts
 * button (the topbar's) and row (the phone's More sheet) are hidden; the price menu that offers
 * one more is the long press's, which is native's.
 */
const NO_ALERTS = '.oac-topbar__alerts,[data-mobile-action=alerts]{display:none!important}'
/**
 * The phone footer's labels (Draw, Indicators, Objects, More) on one line each: at 360 px a
 * quarter of the bar is too narrow for "Indicators" at the widget's size, which then broke
 * mid-word. The label shrinks with the width, never below 12 px nor above the widget's own size,
 * and an ellipsis is the last resort. Above the widget's `.oac-widget .oac-mobile__action`.
 */
const BAR_LABELS =
  '.oac-widget .oac-mobile__bar>.oac-mobile__action{white-space:nowrap;overflow:hidden;' +
  'text-overflow:ellipsis;padding-inline:4px;font-size:clamp(12px,3.4vw,1em)}'
/** At most one page error a second reaches native: a throw on every frame would flood it. */
const ERROR_EVERY_MS = 1_000
/** Chromium's harmless "ResizeObserver loop completed with undelivered notifications". */
const RESIZE_LOOP = /ResizeObserver loop/
const ignore = () => {}

const messageOf = (x: unknown): string =>
  (x instanceof Error ? x.message : String(x)).slice(0, MAX_MESSAGE)

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** The fields of chart.init the page reads before it builds anything. */
function isChartInit(x: unknown): x is ChartInit {
  return (
    isObj(x) &&
    isObj(x.inst) &&
    typeof x.inst.symbol === 'string' &&
    typeof x.inst.exchange === 'string' &&
    Array.isArray(x.intervals) &&
    x.intervals.every((c) => typeof c === 'string') &&
    isObj(x.calendars)
  )
}

/** Two frames: the first paints the candles, the second runs after that paint. */
const twoFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

/**
 * The WebView saves no file: @expo/dom-webview has no download handler, and the link guard
 * cancels blob: and data: links. Without object URLs and a screenshot canvas, the widget's own
 * checks report "This runtime cannot save files" for every capture and export, instead of a
 * success the user never gets.
 */
function withoutDownloads(widget: Widget): void {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: undefined })
  const chart = widget.chart as { takeScreenshot(): HTMLCanvasElement | null }
  chart.takeScreenshot = () => null
}

type Page = { setScheme(scheme: Scheme): void; dispose(): void }

/** The page once mounted: the widget is built on chart.init, then follows native's pushes. */
function openPage(
  client: DomClient,
  root: HTMLElement,
  scheme: () => Scheme,
  send: (e: DomEvent) => void,
): Page {
  let started = false
  let disposed = false
  let widget: Widget | null = null
  let live: OpenAlgoLiveDataFeed | null = null
  let stopPalette: (() => void) | null = null
  let trading: { dispose(): void } | null = null
  // The trade pushes that come while the widget is being built, for the trading glue.
  const held = holdTradePushes(client)
  let calendars: SessionCalendars | null = null
  // A calendars push that comes before the widget exists, for the widget to open with.
  let pendingCalendars: Record<string, CalendarSpecJson> | null = null
  // The first load failed: the one error that ends the page (a window error does not).
  const fail = (e: unknown) =>
    send({ v: 1, kind: 'event', name: 'error', message: messageOf(e), load: true })

  // Ready once the first load settles, an empty history included, and its candles are painted;
  // a failed first load is an error with the feed's message instead.
  function settle(w: Widget, e: WidgetBusEvents['data']) {
    // The widget's failure events carry an `error` key, even when it has no message.
    if ('error' in e) return fail(e.error ?? 'The chart could not load this instrument.')
    twoFrames()
      .then(() => (disposed ? null : probeCsp(window)))
      .then((csp) => {
        if (csp === null || disposed) return
        const info = {
          bars: e.bars,
          indicators: registeredIndicators().length,
          mobile: w.root.dataset.mobile === 'true',
          csp,
        }
        send({ v: 1, kind: 'event', name: 'ready', info })
      }, fail)
  }

  async function build(init: ChartInit) {
    const storage = createBridgedStorage(client, safeLocalStorage())
    const saved = await savedInterval(storage)
    if (disposed) return
    const feeds = createChartFeeds(client)
    const options = widgetOptions(init, { scheme: scheme(), feed: feeds.cached, storage, saved })
    calendars = options.sessionCalendar
    if (pendingCalendars) calendars.replace(pendingCalendars)
    live = feeds.live
    const w = createWidget(root, options)
    widget = w
    withoutDownloads(w)
    // The widget's own Theme control would put the library's teal and off-red on the candles.
    stopPalette = keepAppPalette(w)
    trading = attachTrading(w, client, feeds.live, held.seed)
    held.stop()
    let settled = false
    const off = w.on('data', (e) => {
      if (settled) return
      settled = true
      off()
      settle(w, e)
    })
  }

  function setCalendars(next: Record<string, CalendarSpecJson>) {
    if (calendars === null) {
      pendingCalendars = next
      return
    }
    calendars.replace(next)
    const w = widget
    if (w && !w.isDestroyed) {
      w.chart.setSessionCalendar(calendars({ symbol: w.symbol(), exchange: w.exchange() }))
    }
  }

  // Back in front after a load failed while the screen was hidden (a request held until then
  // times out in the library): load again rather than stay on the error.
  function recover() {
    const w = widget
    if (!w || w.isDestroyed) return
    const status = w.dataController?.getState().status
    if (status === 'error') w.reload().catch(ignore)
    else if (status === 'stale') w.dataController?.refresh().catch(ignore)
  }

  const offs = [
    client.onPush(CHART_TOPICS.init, (p) => {
      // Thrown here, out of deliver, where the page's error handler reports it.
      if (!isChartInit(p)) throw new Error('openalgo-mobile: chart.init is not a ChartInit')
      if (started) return
      started = true
      build(p).catch(fail)
    }),
    client.onPush(CHART_TOPICS.calendars, (p) => {
      if (isObj(p)) setCalendars(p as Record<string, CalendarSpecJson>)
    }),
    client.onPush(CHART_TOPICS.redraw, recover),
  ]

  return {
    setScheme(next) {
      if (widget && !widget.isDestroyed) widget.setTheme(chartTheme(next))
    },
    dispose() {
      disposed = true
      for (const off of offs) off()
      held.stop()
      stopPalette?.()
      trading?.dispose()
      widget?.destroy()
      live?.close()
    },
  }
}

export default function ChartDom({
  scheme,
  bridge,
  ref,
}: ChartDomProps & DomEntryProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<Page | null>(null)
  const schemeRef = useRef(scheme)
  schemeRef.current = scheme
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const [client] = useState(() => createDomClient((m: JSONValue) => bridgeRef.current(m)))

  useDOMImperativeHandle(ref ?? null, () => ({ deliver: client.deliver }), [client])

  // Declared after the handle, so its registration reaches native before 'loaded' does and the
  // outbox's first delivery finds the handle (preflight conflict 12).
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    document.title = DOM_BUNDLE
    const send = (e: DomEvent) => void client.call(e).catch(ignore)
    // First, before the widget adds a listener of its own.
    const stopLinks = guardLinks(document, (url) =>
      send({ v: 1, kind: 'event', name: 'link', url }),
    )
    let reported = Number.NEGATIVE_INFINITY
    const report = (x: unknown) => {
      const now = Date.now()
      if (now - reported < ERROR_EVERY_MS) return
      reported = now
      send({ v: 1, kind: 'event', name: 'error', message: messageOf(x) })
    }
    // The ResizeObserver warning is an error event with no error; the widget's own observer,
    // which resizes the chart inside its callback, can raise it.
    const onError = (e: ErrorEvent) => {
      if (e.error == null && RESIZE_LOOP.test(e.message)) return
      report(e.error ?? e.message)
    }
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    const page = openPage(client, root, () => schemeRef.current, send)
    pageRef.current = page
    send({ v: 1, kind: 'event', name: 'loaded' })
    return () => {
      pageRef.current = null
      page.dispose()
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      stopLinks()
    }
  }, [client])

  useEffect(() => {
    pageRef.current?.setScheme(scheme)
  }, [scheme])

  return (
    <>
      <style>{NO_ALERTS + BAR_LABELS}</style>
      <div ref={rootRef} style={ROOT_STYLE} />
    </>
  )
}
