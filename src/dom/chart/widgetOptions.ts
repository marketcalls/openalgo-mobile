// How the chart page builds its openalgo-charts widget: the phone chrome, the bridged feed and
// storage, the session calendar and the theme. The loading options are the web terminal's
// (terminal.ts:7897-7906, c8b2896) with a lower bar ceiling for a phone.
import type { DataFeed, DataLoadingOptions } from 'openalgo-charts'
import {
  type AsyncStorageLike,
  STATE_KEY,
  STORAGE_PREFIX,
  type WidgetOptions,
} from 'openalgo-charts/widget'
import type { ChartInit } from '~/dom/bridge/protocol'
import { type SessionCalendars, sessionCalendarOf } from './calendars'
import { pickInterval, widgetIntervals } from './intervals'
import { chartTheme } from './theme'

/** The widget's storage namespace: its keys are `oac-widget:chart:…`. */
const PERSIST = 'chart'

export const LOADING: Readonly<DataLoadingOptions> = Object.freeze({
  // A tail request every 30 s, one after each bar closes and one when the stream skips a bucket:
  // history is the only source of the forming bar's volume on a depth-only stream.
  pollIntervalMs: 30_000,
  refreshOnBarClose: true,
  refreshOnGap: true,
  refreshWindowBars: 5,
  pageSize: 500,
  maxEmptyPages: 4,
  // The terminal keeps 100,000 bars; a phone's WebView keeps fewer.
  maxBars: 20_000,
  // Native's history timeout (design 7.5). The library's own default is 15 s.
  timeoutMs: 30_000,
})

export type ChartWidgetOptions = WidgetOptions & { sessionCalendar: SessionCalendars }

/**
 * `saved` is the interval the widget's persisted state holds (`savedInterval`). The widget opens
 * on `interval` whenever it is set, so the user's own interval has to be the one passed here
 * (preflight conflict 4); one the server no longer offers gives way to the default.
 */
export function widgetOptions(
  init: ChartInit,
  o: {
    scheme: 'dark' | 'light'
    feed: DataFeed
    storage: AsyncStorageLike
    saved?: string | null
  },
): ChartWidgetOptions {
  const intervals = widgetIntervals(init.intervals)
  return {
    symbol: init.inst.symbol,
    exchange: init.inst.exchange,
    intervals,
    interval: pickInterval(intervals, o.saved ?? null),
    feed: o.feed,
    loading: LOADING,
    lookbackBars: 500,
    storage: o.storage,
    persist: PERSIST,
    drawingScope: 'instrument',
    mobile: 'auto',
    topbar: true,
    statusline: true,
    rail: true,
    indicators: true,
    bottombar: true,
    // A phone has no keyboard to type a symbol or rebind a chord with.
    typingNavigation: false,
    shortcutsEditor: false,
    locale: 'en-IN',
    sessionShading: true,
    sessionCalendar: sessionCalendarOf(init.calendars),
    theme: chartTheme(o.scheme),
  }
}

/** The interval the widget's saved state holds, or null when there is none or it cannot be read
 *  (the widget reports its own storage trouble once it loads). */
export async function savedInterval(storage: AsyncStorageLike): Promise<string | null> {
  try {
    const raw = await storage.getItem?.(`${STORAGE_PREFIX}${PERSIST}:${STATE_KEY}`)
    if (typeof raw !== 'string') return null
    const state: unknown = JSON.parse(raw)
    const interval = (state as { interval?: unknown } | null)?.interval
    return typeof interval === 'string' ? interval : null
  } catch {
    return null
  }
}
