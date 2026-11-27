// Native-only zod schemas for the bridge (DomHost and the gateway). The types they produce live
// in protocol.ts, the one bridge file the DOM bundle may load.
import { z } from 'zod'
import {
  BRIDGE_VERSION,
  type ChartIntent,
  type DomToNative,
  MAX_SAVE_BASE64,
  type NativeToDom,
  SAVE_MIMES,
  TOOL_PAGE_IDS,
  TOOL_TOPICS,
  type ToolIntent,
  type ToolTopics,
} from './protocol'

export const MAX_PATH = 256
export const MAX_SOCKET_DATA = 65_536
export const MAX_KEY = 256
export const MAX_VALUE = 1_000_000
export const MAX_ORDERID = 64
export const MAX_MESSAGE = 500
export const MAX_URL = 2_048
export const MAX_DIRECTIVE = 64
export const MAX_ROUTE = 64
export const MAX_PAGE_ERROR = 200
/** The largest overflow a tool page reports: wider than any phone. */
export const MAX_OVERFLOW = 100_000

/** The topics native pushes to a tool page (the page spells the same values: dom/tools/pages.ts). */
export const TOOL_PUSH_TOPICS: ToolTopics = { ...TOOL_TOPICS, back: 'tool.back', top: 'tool.top' }

const price = z.number().finite().positive()
const inst = z.strictObject({
  exchange: z.string().regex(/^[A-Z_]{2,16}$/),
  symbol: z.string().min(1).max(64),
})
const orderid = z.string().min(1).max(MAX_ORDERID)

const json: z.ZodType<import('./protocol').JSONValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(json),
    z.record(z.string(), json.optional()),
  ]),
)

// A request body comes from the WebView, so it is bounded and walked iteratively: a recursive
// schema overflows the stack on a deep body and safeParse then throws instead of refusing.
const MAX_BODY_DEPTH = 8
const MAX_BODY_NODES = 1_000
function boundedJson(value: unknown): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]]
  let nodes = 0
  while (stack.length > 0) {
    const [cur, depth] = stack.pop() as [unknown, number]
    if (++nodes > MAX_BODY_NODES || depth > MAX_BODY_DEPTH) return false
    if (cur === null || typeof cur === 'string' || typeof cur === 'boolean') continue
    if (typeof cur === 'number') {
      if (!Number.isFinite(cur)) return false
      continue
    }
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push([item, depth + 1])
      continue
    }
    if (typeof cur === 'object') {
      const proto = Object.getPrototypeOf(cur)
      if (proto !== Object.prototype && proto !== null) return false
      for (const item of Object.values(cur as Record<string, unknown>)) {
        if (item !== undefined) stack.push([item, depth + 1])
      }
      continue
    }
    return false
  }
  return true
}
const requestBody = z.custom<import('./protocol').JSONValue>(boundedJson, 'body')

// A path stays on the API host: absolute, no scheme, no parent step, no empty segment, no backslash.
const path = z
  .string()
  .max(MAX_PATH)
  .refine(
    (p) => p.startsWith('/') && !p.includes('..') && !p.includes('//') && !p.includes('\\'),
    'path',
  )

export const ChartIntentSchema: z.ZodType<ChartIntent> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('trade'),
    inst,
    side: z.enum(['BUY', 'SELL']),
    lots: z.number().int().min(1).max(9999),
  }),
  z.strictObject({ type: z.literal('priceMenu'), inst, price }),
  z.strictObject({ type: z.literal('modify'), inst, orderid, price }),
  z.strictObject({ type: z.literal('cancel'), inst, orderid }),
  z.strictObject({ type: z.literal('close'), inst, product: z.enum(['MIS', 'CNC', 'NRML']) }),
  z.strictObject({ type: z.literal('depth'), inst }),
  z.strictObject({ type: z.literal('symbol'), inst }),
])

// A file name the app writes as it is: no path separator and no other character a file system or
// the share sheet could read as more than a name; '.' and '..' name directories.
const SAVE_NAME = /^[A-Za-z0-9._ -]{1,128}$/
// Padded base64. A single character class, so the check stays linear on a 4,000,000-character body.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export const ToolIntentSchema: z.ZodType<ToolIntent> = z.strictObject({
  type: z.literal('save'),
  name: z
    .string()
    .regex(SAVE_NAME)
    .refine((n) => n !== '.' && n !== '..', 'name'),
  mime: z.enum(SAVE_MIMES),
  base64: z
    .string()
    .max(MAX_SAVE_BASE64)
    .refine((b) => b.length % 4 === 0 && BASE64.test(b), 'base64'),
})

const v = z.literal(BRIDGE_VERSION)
const sid = z.number().int().min(0).max(999)
const rid = z.number().int().safe().min(0)

const socketMsg = z.discriminatedUnion('op', [
  z.strictObject({
    v,
    kind: z.literal('socket'),
    sid,
    op: z.literal('open'),
    url: z.string().max(MAX_URL),
  }),
  z.strictObject({
    v,
    kind: z.literal('socket'),
    sid,
    op: z.literal('send'),
    data: z.string().max(MAX_SOCKET_DATA),
  }),
  z.strictObject({ v, kind: z.literal('socket'), sid, op: z.literal('close') }),
])

const key = z.string().max(MAX_KEY)
const storageMsg = z.discriminatedUnion('op', [
  z.strictObject({ v, kind: z.literal('storage'), op: z.literal('entries'), prefix: key }),
  z.strictObject({ v, kind: z.literal('storage'), op: z.literal('get'), key }),
  z.strictObject({
    v,
    kind: z.literal('storage'),
    op: z.literal('set'),
    key,
    value: z.string().max(MAX_VALUE),
  }),
  z.strictObject({ v, kind: z.literal('storage'), op: z.literal('remove'), key }),
])

const eventMsg = z.discriminatedUnion('name', [
  z.strictObject({ v, kind: z.literal('event'), name: z.literal('loaded') }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('ready'),
    info: z.strictObject({
      bars: z.number().int().min(0),
      indicators: z.number().int().min(0),
      mobile: z.boolean(),
      csp: z.boolean(),
    }),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('error'),
    message: z.string().max(MAX_MESSAGE),
    load: z.literal(true).optional(),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('link'),
    url: z.string().max(MAX_URL),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('toolReady'),
    info: z.strictObject({ page: z.enum(TOOL_PAGE_IDS), csp: z.boolean(), webgl: z.boolean() }),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('violation'),
    directive: z.string().max(MAX_DIRECTIVE),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('layout'),
    overflow: z.number().int().min(0).max(MAX_OVERFLOW),
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('route'),
    path: z.string().max(MAX_ROUTE),
  }),
  z.strictObject({ v, kind: z.literal('event'), name: z.literal('back'), handled: z.boolean() }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('pageError'),
    message: z.string().max(MAX_PAGE_ERROR),
  }),
  z.strictObject({ v, kind: z.literal('event'), name: z.literal('reload') }),
])

export const DomToNativeSchema: z.ZodType<DomToNative> = z.discriminatedUnion('kind', [
  z.strictObject({
    v,
    kind: z.literal('request'),
    rid,
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    path,
    query: z.record(z.string(), z.string()).optional(),
    body: requestBody.optional(),
  }),
  z.strictObject({ v, kind: z.literal('abort'), rid }),
  socketMsg,
  storageMsg,
  z.strictObject({
    v,
    kind: z.literal('intent'),
    intent: z.union([ChartIntentSchema, ToolIntentSchema]),
  }),
  eventMsg,
])

export const NativeToDomBatchSchema: z.ZodType<NativeToDom[]> = z.array(
  z.union([
    z.strictObject({ kind: z.literal('socket'), sid, event: z.enum(['open', 'close']) }),
    z.strictObject({
      kind: z.literal('socket'),
      sid,
      event: z.literal('message'),
      data: z.string(),
    }),
    z.strictObject({ kind: z.literal('push'), topic: z.string(), payload: json }),
  ]),
)

/** Parses a WebView message and never throws: any exception becomes a refusal. */
export function parseDomToNative(
  raw: unknown,
): { success: true; data: DomToNative } | { success: false } {
  try {
    const r = DomToNativeSchema.safeParse(raw)
    return r.success ? { success: true, data: r.data } : { success: false }
  } catch {
    return { success: false }
  }
}
