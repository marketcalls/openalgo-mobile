// The chart page (design 7.9, 17.4). The "dom" project runs this in jsdom, built for web, so the
// 'use dom' body is the page's own code (preflight conflict 2); testCanvas.ts stands in for the
// canvas the WebView has.
import {
  BarCache,
  Chart,
  DataLoadingController,
  darkTheme,
  indicatorDefaults,
  lightTheme,
  registeredChartTypes,
  registeredIndicators,
  registeredSeriesTransforms,
  SessionCalendar,
} from 'openalgo-charts'
import { type AsyncStorageLike, createWidget } from 'openalgo-charts/widget'
import { act, createElement, type ReactElement } from 'react'
import {
  type CalendarSpecJson,
  CHART_TOPICS,
  type ChartInit,
  type ChartReady,
  DOM_WS_URL,
  type DomReply,
  type DomToNative,
  type JSONValue,
  NATIVE_KEY,
} from '~/dom/bridge/protocol'
import { createDomClient } from '~/dom/web/client'
import { tokens } from '~/ui/tokens'
import ChartDom from './ChartDom'
import { sessionCalendarOf } from './calendars'
import { createChartFeeds } from './feeds'
import { ensureInterval, pickInterval, widgetIntervals } from './intervals'
import { DOM_BUNDLE } from './marker'
import { stubCanvas } from './testCanvas'
import { chartTheme, keepAppPalette } from './theme'
import { LOADING, savedInterval, widgetOptions } from './widgetOptions'

const NSE: CalendarSpecJson = {
  timezone: 'Asia/Kolkata',
  sessions: ['0915-1530:23456'],
  exceptions: {},
  preMarketMinutes: 15,
}
// As T9's calendarSpec writes them: round the clock in UTC, no day mask, no pre-open.
const CRYPTO: CalendarSpecJson = { timezone: 'UTC', sessions: ['0000-0000'], exceptions: {} }

const utc = (iso: string) => Date.parse(iso) / 1000
/** Friday 27 November 2026, 10:30 IST. */
const FRIDAY_1030 = utc('2026-11-27T05:00:00Z')

const INIT: ChartInit = {
  inst: { exchange: 'NSE', symbol: 'INFY' },
  intervals: ['1m', '5m', '15m', '1h', 'D', 'bogus'],
  calendars: { NSE, CRYPTO },
  meta: null,
  ltp: null,
  polling: false,
}

const ACCEPTED: DomReply = { status: 202, body: null }
const ok = (data: JSONValue): DomReply => ({ status: 200, body: { status: 'success', data } })

/** Three closed 5-minute candles ending one bar before now. */
function recentBars(): JSONValue {
  const last = Math.floor(Date.now() / 300_000) * 300 - 300
  return [2, 1, 0].map((k) => {
    const t = last - 300 * k
    return { timestamp: t, open: 100 + k, high: 102 + k, low: 99 + k, close: 101 + k, volume: 10 }
  })
}

const storage = (over: Partial<AsyncStorageLike> = {}): AsyncStorageLike => ({
  entries: async () => [],
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
  ...over,
})

// The app has no @types/react-dom: the two calls this file makes, typed here.
const { createRoot } = require('react-dom/client') as {
  createRoot(container: Element): { render(node: ReactElement): void; unmount(): void }
}
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup(node: ReactElement): string
}

let restoreCanvas: () => void
beforeAll(() => {
  restoreCanvas = stubCanvas()
})
afterAll(() => restoreCanvas())

describe('registries and tiers', () => {
  test('all 112 built-in indicators register, each with defaults', () => {
    const all = registeredIndicators()
    expect(all).toHaveLength(112)
    expect(new Set(all.map((d) => d.id)).size).toBe(112)
    for (const defaults of all.map(indicatorDefaults)) expect(defaults).toEqual(expect.any(Object))
  })

  test('every chart type and transform is offered', () => {
    expect(registeredChartTypes()).toEqual(
      expect.arrayContaining(
        'candlestick hollow-candle volume-candle bar high-low line line-markers step area hlc-area baseline column histogram point-figure kagi'.split(
          ' ',
        ),
      ),
    )
    expect(registeredSeriesTransforms()).toEqual(
      expect.arrayContaining(
        'heikin-ashi renko range-bars line-break point-figure kagi'.split(' '),
      ),
    )
  })
})

describe('intervals', () => {
  test('server codes become widget codes and M registers as a month', () => {
    // A fresh registry, so the month is not already registered by another test.
    jest.isolateModules(() => {
      const charts = require('openalgo-charts') as typeof import('openalgo-charts')
      const own = require('./intervals') as typeof import('./intervals')
      expect(charts.isKnownInterval('M')).toBe(false)
      expect(own.widgetIntervals(['1m', 'D', 'W', 'M', 'bogus'])).toEqual(['1m', 'D', 'W', 'M'])
      expect(charts.isKnownInterval('M')).toBe(true)
      expect(charts.resolveInterval('M').bucketing).toEqual({
        mode: 'calendar',
        unit: 'month',
        count: 1,
      })
    })
    expect(widgetIntervals(['5m', ' 5m', 'D', 'D'])).toEqual(['5m', 'D'])
    expect(ensureInterval('3M')).toBe(true)
    expect(ensureInterval('2Q')).toBe(true)
    for (const bad of ['', ' ', '0M', 'X', '5x', 'M3']) expect(ensureInterval(bad)).toBe(false)
  })

  test('the default interval is the saved one, else 5m, else the first minute, else D', () => {
    const codes = ['1m', '5m', '15m', '1h', 'D']
    expect(pickInterval(codes, '15m')).toBe('15m')
    expect(pickInterval(codes, '2h')).toBe('5m')
    expect(pickInterval(codes, null)).toBe('5m')
    expect(pickInterval(['30s', '3m', '1m', '1h'], null)).toBe('3m')
    // frontend intervals.ts:131: no minute interval, then whatever exists, then D.
    expect(pickInterval(['1h', 'D'], null)).toBe('1h')
    expect(pickInterval([], null)).toBe('D')
    expect(pickInterval([], '5m')).toBe('D')
  })
})

describe('widget options and theme', () => {
  test('widget options', () => {
    const feed = { getBars: async () => [] }
    const store = storage()
    const o = widgetOptions(INIT, { scheme: 'dark', feed, storage: store })
    expect(o).toMatchObject({
      mobile: 'auto',
      persist: 'chart',
      drawingScope: 'instrument',
      lookbackBars: 500,
      loading: LOADING,
      typingNavigation: false,
      shortcutsEditor: false,
    })
    expect(o).toMatchObject({
      symbol: 'INFY',
      exchange: 'NSE',
      topbar: true,
      statusline: true,
      rail: true,
      indicators: true,
      bottombar: true,
      locale: 'en-IN',
      sessionShading: true,
      intervals: ['1m', '5m', '15m', '1h', 'D'],
      interval: '5m',
      theme: chartTheme('dark'),
    })
    expect(o.feed).toBe(feed)
    expect(o.storage).toBe(store)
    expect(
      o.sessionCalendar({ symbol: 'INFY', exchange: 'NSE' })?.sessionFrom(FRIDAY_1030),
    ).toEqual(new SessionCalendar(NSE).sessionFrom(FRIDAY_1030))
    expect(LOADING).toEqual({
      pollIntervalMs: 30_000,
      refreshOnBarClose: true,
      refreshOnGap: true,
      refreshWindowBars: 5,
      pageSize: 500,
      maxEmptyPages: 4,
      maxBars: 20_000,
      // Design 7.5's history timeout; the library's own default is 15 s.
      timeoutMs: 30_000,
    })
    expect(Object.isFrozen(LOADING)).toBe(true)
  })

  test("the user's saved interval opens the chart, when the server still offers it", async () => {
    const base = { scheme: 'dark' as const, feed: { getBars: async () => [] }, storage: storage() }
    expect(widgetOptions(INIT, { ...base, saved: '15m' }).interval).toBe('15m')
    expect(widgetOptions(INIT, { ...base, saved: '2h' }).interval).toBe('5m')

    const state = (raw: string | null) => storage({ getItem: async () => raw })
    const asked: string[] = []
    const spy = storage({
      getItem: async (key) => {
        asked.push(key)
        return JSON.stringify({ version: 1, symbol: 'TCS', interval: '15m' })
      },
    })
    await expect(savedInterval(spy)).resolves.toBe('15m')
    expect(asked).toEqual(['oac-widget:chart:state'])
    await expect(savedInterval(state(null))).resolves.toBeNull()
    await expect(savedInterval(state('{not json'))).resolves.toBeNull()
    await expect(savedInterval(state('{"interval":5}'))).resolves.toBeNull()
    const refused = storage({
      getItem: async () => {
        throw new Error('storage get refused (400)')
      },
    })
    await expect(savedInterval(refused)).resolves.toBeNull()
    await expect(savedInterval({ ...storage(), getItem: undefined })).resolves.toBeNull()
  })

  test('BUY is green and SELL red in both schemes', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const theme = chartTheme(scheme)
      const base = scheme === 'dark' ? darkTheme : lightTheme
      const trade = tokens.trade[scheme]
      expect(theme).toMatchObject({
        buy: '#00a63e',
        upColor: '#00a63e',
        wickUpColor: '#00a63e',
        lastPriceUp: '#00a63e',
        sell: '#e7000b',
        downColor: '#e7000b',
        wickDownColor: '#e7000b',
        lastPriceDown: '#e7000b',
        profit: trade.profit,
        loss: trade.loss,
        background: tokens[scheme].background,
        axisText: tokens[scheme].mutedForeground,
        grid: tokens[scheme].muted,
      })
      // Everything else is the library's palette for that scheme.
      expect(theme.crosshair).toBe(base.crosshair)
      expect(theme.lineColor).toBe(base.lineColor)
    }
    expect(tokens.trade.dark.buy).toBe('#00a63e')
    expect(tokens.trade.light.sell).toBe('#e7000b')
  })

  /** A widget with the page's options and an empty history, outside ChartDom. */
  function openWidget() {
    const container = document.createElement('div')
    document.body.append(container)
    const feed = { getBars: async () => [] }
    const w = createWidget(
      container,
      widgetOptions(INIT, { scheme: 'dark', feed, storage: storage() }),
    )
    return { w, container }
  }

  test("the widget's own Theme control keeps BUY green and SELL red", async () => {
    const { w, container } = openWidget()
    const seen: string[] = []
    const tick = () => new Promise((r) => setTimeout(r, 0))
    try {
      const stop = keepAppPalette(w)
      w.on('theme', (e) => seen.push(e.chartTheme.upColor))
      for (const name of ['light', 'dark'] as const) {
        seen.length = 0
        // What the topbar's Theme button and the mobile More sheet's theme row call.
        w.setTheme(name)
        await tick()
        expect(w.theme()).toBe(name)
        expect(w.chart.theme()).toMatchObject({
          upColor: '#00a63e',
          downColor: '#e7000b',
          wickUpColor: '#00a63e',
          wickDownColor: '#e7000b',
          buy: '#00a63e',
          sell: '#e7000b',
          background: tokens[name].background,
        })
        // The library's palette once, then the app's, which is not applied again.
        const lib = name === 'dark' ? darkTheme : lightTheme
        expect(seen).toEqual([lib.upColor, '#00a63e'])
      }
      // A palette chartTheme built stays as it is: one event, no second setTheme.
      seen.length = 0
      w.setTheme(chartTheme('light'))
      await tick()
      expect(seen).toEqual(['#00a63e'])
      // The app's own palette set in the same task, after the tap, is the one that stays.
      w.setTheme('light')
      w.setTheme(chartTheme('dark'))
      await tick()
      expect(w.chart.theme()).toMatchObject({
        background: tokens.dark.background,
        upColor: '#00a63e',
      })
      // Stopped, even with the app's palette already on its way back, the library's stays.
      w.setTheme('light')
      stop()
      await tick()
      expect(w.chart.theme().upColor).toBe(lightTheme.upColor)
      w.setTheme('dark')
      await tick()
      expect(w.chart.theme().upColor).toBe(darkTheme.upColor)
    } finally {
      w.destroy()
      container.remove()
    }
  })

  test('a chart destroyed right after its Theme control gets no palette', async () => {
    const { w, container } = openWidget()
    keepAppPalette(w)
    const setTheme = jest.spyOn(w, 'setTheme')
    w.setTheme('light')
    w.destroy()
    container.remove()
    await new Promise((r) => setTimeout(r, 0))
    expect(setTheme.mock.calls).toEqual([['light']])
  })
})

describe('feeds', () => {
  const history = [
    { timestamp: utc('2026-11-26T03:45:00Z'), open: 1, high: 2, low: 1, close: 2, oi: 7 },
  ]

  function bridged() {
    const sent: DomToNative[] = []
    const client = createDomClient(async (m) => {
      const msg = m as DomToNative
      sent.push(msg)
      if (msg.kind !== 'request') return ACCEPTED
      return ok(msg.path === '/api/v1/history' ? history : [])
    })
    return { sent, ...createChartFeeds(client) }
  }
  const window5m = {
    interval: '5m',
    from: utc('2026-11-26T03:45:00Z'),
    to: utc('2026-11-26T10:00:00Z'),
  }

  test('history the chart asks for goes over the bridge with the placeholder key', async () => {
    const { sent, live, cached } = bridged()
    const bars = await cached.getBars({ symbol: 'NIFTY26DECFUT', exchange: 'NFO', ...window5m })
    // The feed's socket is native's emulation, never a network socket.
    expect(sent.filter((m) => m.kind === 'socket')).toEqual([
      { v: 1, kind: 'socket', sid: expect.any(Number), op: 'open', url: DOM_WS_URL },
    ])
    const requests = () => sent.filter((m) => m.kind === 'request')
    expect(requests()).toEqual([
      {
        v: 1,
        kind: 'request',
        rid: expect.any(Number),
        method: 'POST',
        path: '/api/v1/history',
        body: {
          apikey: NATIVE_KEY,
          symbol: 'NIFTY26DECFUT',
          exchange: 'NFO',
          interval: '5m',
          start_date: '2026-11-26',
          end_date: '2026-11-26',
        },
      },
    ])
    // A derivative keeps its open interest; a cash instrument's placeholder column is dropped.
    expect(bars[0]?.oi).toBe(7)
    const cash = await cached.getBars({ symbol: 'INFY', exchange: 'NSE', ...window5m })
    expect(cash[0]?.oi).toBeUndefined()

    // The widget's feed is the warm-load cache over the live feed, which keeps its socket.
    expect(cached).toBeInstanceOf(BarCache)
    expect(cached.source).toBe(live)
    expect(typeof cached.subscribeBars).toBe('function')

    await cached.searchSymbols?.({ query: 'INF' })
    expect(requests().at(-1)).toMatchObject({
      kind: 'request',
      path: '/api/v1/search',
      body: { apikey: NATIVE_KEY, query: 'INF' },
    })
    live.close()
  })
})

describe('calendars', () => {
  test('an index uses its exchange calendar', () => {
    const calendars = sessionCalendarOf({ NSE, CRYPTO })
    const nse = calendars({ symbol: 'NIFTY', exchange: 'NSE_INDEX' })
    expect(nse).not.toBeNull()
    expect(calendars({ symbol: 'INFY', exchange: 'NSE' })).toBe(nse)
    expect(nse?.sessionFrom(FRIDAY_1030)).toEqual({
      date: '2026-11-27',
      open: utc('2026-11-27T03:45:00Z'),
      close: utc('2026-11-27T10:00:00Z'),
    })
    // NSE's 15-minute pre-open is part of its calendar.
    const before = nse?.phaseSpans?.(utc('2026-11-27T03:30:00Z'), utc('2026-11-27T03:45:00Z'))
    expect(before?.map((s) => s.phase)).toEqual(['pre'])
    // CRYPTO trades round the clock in UTC, every day.
    const crypto = calendars({ symbol: 'BTCUSD', exchange: 'CRYPTO' })
    const sunday = utc('2026-11-29T12:00:00Z')
    expect(crypto?.sessionFrom(sunday)?.open).toBeLessThanOrEqual(sunday)
    expect(calendars({ symbol: 'SPX', exchange: 'GLOBAL_INDEX' })).toBeNull()
    expect(calendars({ symbol: 'GOLD', exchange: 'MCX' })).toBeNull()
  })

  test('a replaced calendar reaches the source the widget already holds', () => {
    const calendars = sessionCalendarOf({ NSE })
    const nse = calendars({ symbol: 'INFY', exchange: 'NSE' })
    calendars.replace({ NSE: { ...NSE, exceptions: { '2026-11-27': [] } } })
    expect(calendars({ symbol: 'INFY', exchange: 'NSE' })).toBe(nse)
    // Closed that Friday: the next session is Monday's.
    expect(nse?.sessionFrom(FRIDAY_1030)?.date).toBe('2026-11-30')
    // A spec the library refuses leaves that exchange without hours, not the page broken.
    calendars.replace({ NSE: { ...NSE, timezone: 'Not/AZone' }, CRYPTO })
    expect(calendars({ symbol: 'INFY', exchange: 'NSE' })).toBeNull()
    expect(nse?.sessionFrom(FRIDAY_1030)).toBeNull()
    expect(calendars({ symbol: 'BTCUSD', exchange: 'CRYPTO' })).not.toBeNull()
  })
})

describe('ChartDom', () => {
  type Answer = (m: DomToNative) => DomReply | Promise<DomReply> | undefined
  type Win = typeof window & {
    ReactNativeWebView?: { postMessage: jest.Mock }
    _domRefProxy?: { deliver?: unknown }
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const win = window as Win

  const isHistory = (m: DomToNative) => m.kind === 'request' && m.path === '/api/v1/history'
  function standard(m: DomToNative): DomReply {
    if (m.kind === 'storage') {
      if (m.op === 'entries') return { status: 200, body: [] }
      if (m.op === 'get') return { status: 200, body: null }
      return { status: 204, body: null }
    }
    if (m.kind === 'request') return ok(isHistory(m) ? recentBars() : [])
    return ACCEPTED
  }

  /** Runs `code` as expo's wrapper does with injectJavaScript: a script in the page. */
  function inject(code: string) {
    const script = document.createElement('script')
    script.textContent = code
    document.body.append(script)
    script.remove()
  }

  const mounted: Array<() => Promise<void>> = []

  async function mountChart(o: { answer?: Answer; scheme?: 'dark' | 'light' } = {}) {
    const sent: DomToNative[] = []
    const atLoaded: { handle: boolean; registered: boolean }[] = []
    const bridge = async (m: JSONValue): Promise<JSONValue> => {
      const msg = m as DomToNative
      sent.push(msg)
      if (msg.kind === 'event' && msg.name === 'loaded') {
        atLoaded.push({
          handle: typeof win._domRefProxy?.deliver === 'function',
          registered: (win.ReactNativeWebView?.postMessage.mock.calls.length ?? 0) > 0,
        })
      }
      return (await o.answer?.(msg)) ?? standard(msg)
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = (scheme: 'dark' | 'light') =>
      act(async () => {
        root.render(createElement(ChartDom, { scheme, bridge }))
      })
    await render(o.scheme ?? 'dark')
    let gone = false
    const unmount = async () => {
      if (gone) return
      gone = true
      await act(async () => root.unmount())
      container.remove()
    }
    mounted.push(unmount)
    const events = () => sent.flatMap((m) => (m.kind === 'event' ? [m] : []))
    return {
      container,
      sent,
      atLoaded,
      events,
      ready: () => events().find((e) => e.name === 'ready') as { info: ChartReady } | undefined,
      errors: () => events().flatMap((e) => (e.name === 'error' ? [e.message] : [])),
      push: (topic: string, payload: JSONValue) =>
        inject(
          `window._domRefProxy.deliver(${JSON.stringify([{ kind: 'push', topic, payload }])})`,
        ),
      rerender: render,
      unmount,
    }
  }

  async function waitFor(check: () => unknown, ms = 4000): Promise<void> {
    const until = Date.now() + ms
    while (!check()) {
      if (Date.now() > until) throw new Error('waitFor timed out')
      await act(() => new Promise((r) => setTimeout(r, 10)))
    }
  }

  beforeAll(() => {
    win.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    // The page runs inside the WebView: expo's hook takes its native path, which registers the
    // handle with this bridge from an effect.
    win.ReactNativeWebView = { postMessage: jest.fn() }
    // An enforcing browser refuses the CSP probe's image with a violation.
    jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(() => {
      queueMicrotask(() =>
        document.dispatchEvent(new Event('securitypolicyviolation', { bubbles: true })),
      )
    })
  })
  afterEach(async () => {
    for (const unmount of mounted.splice(0)) await unmount()
    jest.restoreAllMocks()
    delete win.ReactNativeWebView
    delete win._domRefProxy
  })

  test('the root fills the viewport and owns every touch', () => {
    const html = renderToStaticMarkup(
      createElement(ChartDom, { scheme: 'dark', bridge: jest.fn() }),
    )
    expect(html).toBe(
      '<div style="position:fixed;inset:0;overflow:hidden;touch-action:none;user-select:none"></div>',
    )
  })

  test('the page posts loaded after its handle registers, and marks its bundle', async () => {
    const page = await mountChart()
    expect(page.events().map((e) => e.name)).toEqual(['loaded'])
    expect(page.atLoaded).toEqual([{ handle: true, registered: true }])
    expect(document.title).toBe(DOM_BUNDLE)
    expect(DOM_BUNDLE).toBe('oa-dom:chart')
  })

  test('the chart opens on the route instrument at the saved interval and is ready', async () => {
    const page = await mountChart({
      answer: (m) =>
        m.kind === 'storage' && m.op === 'get'
          ? { status: 200, body: JSON.stringify({ version: 1, interval: '15m' }) }
          : undefined,
    })
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(page.ready)
    expect(page.ready()?.info).toEqual({ bars: 3, indicators: 112, mobile: false, csp: true })
    const history = page.sent.find(isHistory)
    expect(history).toMatchObject({
      body: { apikey: NATIVE_KEY, symbol: 'INFY', exchange: 'NSE', interval: '15m' },
    })
    expect(page.errors()).toEqual([])
  })

  test('an empty history is ready with bars 0; a history 400 sends error with its message', async () => {
    const empty = await mountChart({ answer: (m) => (isHistory(m) ? ok([]) : undefined) })
    empty.push(CHART_TOPICS.init, INIT)
    await waitFor(empty.ready)
    expect(empty.ready()?.info.bars).toBe(0)
    await empty.unmount()

    const refused = await mountChart({
      answer: (m) =>
        isHistory(m)
          ? { status: 400, body: { status: 'error', message: 'Bad interval' } }
          : undefined,
    })
    refused.push(CHART_TOPICS.init, INIT)
    await waitFor(() => refused.errors().length > 0)
    // The library keeps only the status (openalgo-rest.ts:170, preflight conflict 24).
    expect(refused.errors()).toEqual(['openalgo-charts: history request failed (400)'])
    expect(refused.ready()).toBeUndefined()
  })

  test('after a failed load, the refocus redraw loads again', async () => {
    let fail = true
    const page = await mountChart({
      answer: (m) =>
        isHistory(m) && fail ? { status: 504, body: { status: 'error' } } : undefined,
    })
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(() => page.errors().length > 0)
    const loads = () => page.sent.filter(isHistory).length
    const failed = loads()

    fail = false
    page.push(CHART_TOPICS.redraw, null)
    await waitFor(() => loads() > failed)
    await act(() => new Promise((r) => setTimeout(r, 50)))
    const recovered = loads()
    // A chart that is not in error is left alone.
    page.push(CHART_TOPICS.redraw, null)
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(loads()).toBe(recovered)
  })

  test('a chart whose refresh failed refreshes again on the refocus redraw', async () => {
    const page = await mountChart()
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(page.ready)
    // A tail refresh that timed out while hidden leaves the bars shown and the status 'stale'.
    const real = DataLoadingController.prototype.getState
    let stale = false
    jest.spyOn(DataLoadingController.prototype, 'getState').mockImplementation(function (
      this: DataLoadingController,
    ) {
      const state = real.call(this)
      return stale ? { ...state, status: 'stale' } : state
    })
    const refresh = jest.spyOn(DataLoadingController.prototype, 'refresh')
    stale = true
    page.push(CHART_TOPICS.redraw, null)
    stale = false
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('a calendars push reaches the chart for its instrument', async () => {
    const applied = jest.spyOn(Chart.prototype, 'setSessionCalendar')
    const page = await mountChart()
    page.push(CHART_TOPICS.init, { ...INIT, inst: { exchange: 'NSE_INDEX', symbol: 'NIFTY' } })
    await waitFor(page.ready)
    const first = applied.mock.calls.at(-1)?.[0]
    expect(first?.sessionFrom(FRIDAY_1030)?.date).toBe('2026-11-27')

    page.push(CHART_TOPICS.calendars, { NSE: { ...NSE, exceptions: { '2026-11-27': [] } } })
    const last = applied.mock.calls.at(-1)?.[0]
    expect(applied.mock.calls.length).toBeGreaterThan(1)
    expect(last).toBe(first)
    expect(last?.sessionFrom(FRIDAY_1030)?.date).toBe('2026-11-30')
  })

  test('a calendars push that comes while the widget is being built is the one it opens with', async () => {
    const applied = jest.spyOn(Chart.prototype, 'setSessionCalendar')
    const page = await mountChart()
    page.push(CHART_TOPICS.init, INIT)
    // The page is still reading the saved state: there is no widget yet.
    page.push(CHART_TOPICS.calendars, { NSE: { ...NSE, exceptions: { '2026-11-27': [] } } })
    await waitFor(page.ready)
    expect(applied.mock.calls.at(-1)?.[0]?.sessionFrom(FRIDAY_1030)?.date).toBe('2026-11-30')
  })

  test('a new scheme restyles the open chart', async () => {
    const applied = jest.spyOn(Chart.prototype, 'setSessionCalendar')
    const page = await mountChart({ scheme: 'dark' })
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(page.ready)
    const chart = applied.mock.contexts[0] as Chart
    expect(chart.theme()).toMatchObject({ background: tokens.dark.background, buy: '#00a63e' })
    await page.rerender('light')
    expect(chart.theme()).toMatchObject({ background: tokens.light.background, sell: '#e7000b' })
  })

  test("the chart's own Theme button keeps the app's BUY and SELL colours", async () => {
    const applied = jest.spyOn(Chart.prototype, 'setSessionCalendar')
    const page = await mountChart({ scheme: 'dark' })
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(page.ready)
    const chart = applied.mock.contexts[0] as Chart
    const button = page.container.querySelector<HTMLButtonElement>('.oac-topbar__theme')
    expect(button).not.toBeNull()
    for (const scheme of ['light', 'dark'] as const) {
      await act(async () => button?.click())
      expect(chart.theme()).toMatchObject({
        background: tokens[scheme].background,
        upColor: '#00a63e',
        downColor: '#e7000b',
        buy: '#00a63e',
        sell: '#e7000b',
      })
    }
    // The app's scheme still wins when it changes.
    await page.rerender('light')
    expect(chart.theme()).toMatchObject({ background: tokens.light.background, upColor: '#00a63e' })
    expect(page.errors()).toEqual([])
  })

  test('captures and exports say the page cannot save files', async () => {
    const urls = URL as { createObjectURL?: unknown }
    urls.createObjectURL = jest.fn()
    const applied = jest.spyOn(Chart.prototype, 'setSessionCalendar')
    const page = await mountChart()
    page.push(CHART_TOPICS.init, INIT)
    await waitFor(page.ready)
    // Blob downloads (SVG, CSV) see no object URLs; the PNG capture gets no image.
    expect(urls.createObjectURL).toBeUndefined()
    expect((applied.mock.contexts[0] as Chart).takeScreenshot()).toBeNull()
  })

  test('links go to native; errors and rejections in the page are reported', async () => {
    const page = await mountChart()
    const a = document.createElement('a')
    a.href = 'https://openalgo.in/discord'
    document.body.append(a)
    a.click()
    a.remove()
    expect(page.events().find((e) => e.name === 'link')).toMatchObject({
      url: 'https://openalgo.in/discord',
    })

    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new Error('lost') })
    window.dispatchEvent(rejection)
    expect(page.errors()).toEqual(['lost'])
  })

  test("a push that throws out of deliver, inside expo's injected script, is reported", async () => {
    const page = await mountChart()
    // jsdom would print the uncaught error; the page's own listener runs first.
    const quiet = (e: Event) => e.preventDefault()
    window.addEventListener('error', quiet)
    try {
      page.push(CHART_TOPICS.init, { inst: null })
    } finally {
      window.removeEventListener('error', quiet)
    }
    expect(page.errors()).toEqual(['openalgo-mobile: chart.init is not a ChartInit'])
  })
})
