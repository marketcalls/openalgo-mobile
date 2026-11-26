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

export const BRIDGE_VERSION = 1
/** The prop name expo/dom reserves for the native bridge function. */
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
  v: 1
  kind: 'request'
  rid: number
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: JSONValue
}
export type DomAbort = { v: 1; kind: 'abort'; rid: number }
export type DomSocketMsg = { v: 1; kind: 'socket'; sid: number } & (
  | { op: 'open'; url: string }
  | { op: 'send'; data: string }
  | { op: 'close' }
)
export type DomStorageMsg = { v: 1; kind: 'storage' } & (
  | { op: 'entries'; prefix: string }
  | { op: 'get'; key: string }
  | { op: 'set'; key: string; value: string }
  | { op: 'remove'; key: string }
)
export type DomIntentMsg = { v: 1; kind: 'intent'; intent: ChartIntent }
export type DomEvent = { v: 1; kind: 'event' } & (
  | { name: 'loaded' }
  | { name: 'ready'; info: ChartReady }
  | { name: 'error'; message: string }
  | { name: 'link'; url: string }
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
