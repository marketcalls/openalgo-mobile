// The bridge protocol between the native app and the WebView page. Both runtimes load this file,
// so it holds only types, constants and a dependency-free guard (no zod: the DOM bundle budget).
// The zod schemas that validate DOM-to-native traffic live in schemas.ts, native only.
import type { DOMImperativeFactory, DOMProps } from 'expo/dom'
import type { Ref } from 'react'

export type JSONValue =
  | boolean
  | number
  | string
  | null
  | JSONValue[]
  | { [k: string]: JSONValue | undefined }

export const BRIDGE_VERSION = 1 as const
/**
 * The API-key placeholder the DOM sends in place of a real key. Only the native gateway swaps it
 * for the real key, and only on allowlisted routes; the DOM never holds the key.
 */
export const NATIVE_KEY = '__native__'
/** The socket URL the DOM opens; the gateway emulates it. It never resolves on a network. */
export const DOM_WS_URL = 'wss://native.invalid/ws'
export const DOM_ORIGIN = 'https://native.invalid'

export type Inst = { exchange: string; symbol: string }

export type ChartIntent = { inst: Inst } & (
  | { type: 'trade'; side: 'BUY' | 'SELL'; lots: number }
  | { type: 'priceMenu'; price: number }
  | { type: 'modify'; orderid: string; price: number }
  | { type: 'cancel'; orderid: string }
  | { type: 'close'; product: 'MIS' | 'CNC' | 'NRML' }
  | { type: 'depth' }
  | { type: 'symbol' }
)

export type ChartReady = { bars: number; indicators: number; mobile: boolean; csp: boolean }

export type DomRequest = {
  v: typeof BRIDGE_VERSION
  kind: 'request'
  rid: number
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string>
  body?: JSONValue
}
export type DomAbort = { v: typeof BRIDGE_VERSION; kind: 'abort'; rid: number }
export type DomSocketMsg = { v: typeof BRIDGE_VERSION; kind: 'socket'; sid: number } & (
  | { op: 'open'; url: string }
  | { op: 'send'; data: string }
  | { op: 'close' }
)
export type DomStorageMsg = { v: typeof BRIDGE_VERSION; kind: 'storage' } & (
  | { op: 'entries'; prefix: string }
  | { op: 'get'; key: string }
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
)
export type DomIntentMsg = {
  v: typeof BRIDGE_VERSION
  kind: 'intent'
  intent: ChartIntent | ToolIntent
}
export type DomEvent = { v: typeof BRIDGE_VERSION; kind: 'event' } & (
  | { name: 'loaded' }
  | { name: 'ready'; info: ChartReady }
  | { name: 'toolReady'; info: ToolReady }
  /** A CSP violation the tool page saw: its effective directive, never the blocked URL. */
  | { name: 'violation'; directive: string }
  /**
   * `load`: the chart's first load failed, and the page cannot show it. Without it, the error is
   * the page's own (a window error or an unhandled rejection), which the page goes on after.
   */
  | { name: 'error'; message: string; load?: true }
  | { name: 'link'; url: string }
  /** The tool page's widest overflow past the viewport's right edge, in whole px (0: none). */
  | { name: 'layout'; overflow: number }
  /** The path a tool page shows (its MemoryRouter's), at most 64 characters. */
  | { name: 'route'; path: string }
  /** The tool page's answer to a `back` push: whether it closed something or went back itself. */
  | { name: 'back'; handled: boolean }
  /** A tool page's route failed to render and shows its fallback; at most 200 characters. */
  | { name: 'pageError'; message: string }
  /** The trader asked for the tool page to load again (its fallback's Reload tool). */
  | { name: 'reload' }
)
export type DomToNative =
  | DomRequest
  | DomAbort
  | DomSocketMsg
  | DomStorageMsg
  | DomIntentMsg
  | DomEvent

export type DomReply = { status: number; body: JSONValue }

export type NativeToDom =
  | { kind: 'socket'; sid: number; event: 'open' | 'close' }
  | { kind: 'socket'; sid: number; event: 'message'; data: string }
  | { kind: 'push'; topic: string; payload: JSONValue }

export type ChartMeta = {
  exchange: string
  symbol: string
  tick: number
  lotsize: number
  lots: boolean
  quoteOnly: boolean
  freezeQty: number
}
export type CalendarSpecJson = {
  timezone: string
  sessions: string[]
  exceptions: Record<string, string[]>
  preMarketMinutes?: number
}
export type ChartInit = {
  inst: Inst
  intervals: string[]
  calendars: Record<string, CalendarSpecJson>
  meta: ChartMeta | null
  ltp: number | null
  polling: boolean
}
export type ChartOrder = {
  id: string
  side: 'BUY' | 'SELL'
  type: string
  qty: number
  price: number
  trigger: number | null
}
export type ChartPosition = { product: 'MIS' | 'CNC' | 'NRML'; net: number; avg: number }

export const CHART_TOPICS = {
  init: 'chart.init',
  meta: 'chart.meta',
  calendars: 'chart.calendars',
  orders: 'chart.orders',
  positions: 'chart.positions',
  redraw: 'chart.redraw',
} as const

/** The rare prop; everything else reaches the page as pushes. */
export type ChartDomProps = { scheme: 'dark' | 'light' }

/** The web tool pages the app hosts (design 7.8), by the web frontend's tool ids. */
export const TOOL_PAGE_IDS = [
  'oitracker',
  'oirange',
  'maxpain',
  'ivsmile',
  'gex',
  'gammadensity',
  'portfolio-backtester',
  'sip-backtester',
  'portfolio-analyzer',
  'sector-rotation',
] as const
export type ToolPageId = (typeof TOOL_PAGE_IDS)[number]
/** The web's broker store (`/api/broker/capabilities`); market/brokers' BrokerCaps is this shape. */
export type BrokerCapsJson = {
  broker_name: string
  broker_type: 'IN_stock' | 'crypto'
  supported_exchanges: string[]
  leverage_config: boolean
}
export type ToolSeed = { broker: string | null; capabilities: BrokerCapsJson }
export type ToolInit = { page: ToolPageId; seed: ToolSeed }
export const TOOL_TOPICS = { init: 'tool.init' } as const
/**
 * Every topic native pushes to a tool page: init, then back (answered by a `back` event) and top
 * (scroll to the top). ChartDom loads this file, so only `init` is a value here; the others are
 * spelled where they are used, typed by this (dom/bridge/schemas.ts for native, dom/tools for the
 * page), so the two sides cannot drift.
 */
export type ToolTopics = typeof TOOL_TOPICS & {
  readonly back: 'tool.back'
  readonly top: 'tool.top'
}
export type ToolDomProps = { scheme: 'dark' | 'light'; page: ToolPageId; reduceMotion: boolean }

/** What a tool page may save to the phone: a Sector Rotation PNG, a CSV, the tearsheet's HTML. */
export const SAVE_MIMES = ['image/png', 'text/csv', 'text/html'] as const
/** The longest file a save carries, as base64: 3,000,000 bytes. */
export const MAX_SAVE_BASE64 = 4_000_000
/** A page's file download, handed to native (the WebView cannot save one). `name` is
 *  ^[A-Za-z0-9._ -]{1,128}$. */
export type ToolIntent = {
  type: 'save'
  name: string
  mime: (typeof SAVE_MIMES)[number]
  base64: string
}
/** The body native answers a download with once it has saved the file itself: the page's own
 *  save of it (a blob link) is then dropped. Here, not in dom/web, so the gateway can import it. */
export const OPENED_IN_APP = '<!-- oa:opened-in-app -->'
export type ToolReady = { page: ToolPageId; csp: boolean; webgl: boolean }

// Declared here (type-only imports) so DOM entries can type their props.
export interface DomHandle extends DOMImperativeFactory {
  deliver: (batch: JSONValue) => void
}
export type DomEntryProps = {
  bridge: (msg: JSONValue) => Promise<JSONValue>
  dom?: DOMProps
  ref?: Ref<DomHandle>
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isSid = (x: unknown): x is number =>
  Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 999

function isOne(x: unknown): x is NativeToDom {
  if (!isObj(x)) return false
  if (x.kind === 'push') {
    return typeof x.topic === 'string' && x.payload !== undefined && Object.keys(x).length === 3
  }
  if (x.kind !== 'socket' || !isSid(x.sid)) return false
  if (x.event === 'open' || x.event === 'close') return Object.keys(x).length === 3
  return x.event === 'message' && typeof x.data === 'string' && Object.keys(x).length === 4
}

/** The DOM client's check of what the native side delivered, without a schema library. */
export function isNativeToDomBatch(x: unknown): x is NativeToDom[] {
  return Array.isArray(x) && x.every(isOne)
}
