// Native-only zod schemas for the bridge (DomHost and the gateway). The types they produce live
// in protocol.ts, the one bridge file the DOM bundle may load.
import { z } from 'zod'
import type { ChartIntent, DomToNative, NativeToDom } from './protocol'

const MAX_PATH = 256
const MAX_SOCKET_DATA = 65_536
const MAX_KEY = 256
const MAX_VALUE = 1_000_000
const MAX_ORDERID = 64
const MAX_MESSAGE = 500
const MAX_URL = 2_048

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

const v = z.literal(1)
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
  }),
  z.strictObject({
    v,
    kind: z.literal('event'),
    name: z.literal('link'),
    url: z.string().max(MAX_URL),
  }),
])

export const DomToNativeSchema: z.ZodType<DomToNative> = z.discriminatedUnion('kind', [
  z.strictObject({
    v,
    kind: z.literal('request'),
    rid,
    method: z.enum(['GET', 'POST']),
    path,
    query: z.record(z.string(), z.string()).optional(),
    body: json.optional(),
  }),
  z.strictObject({ v, kind: z.literal('abort'), rid }),
  socketMsg,
  storageMsg,
  z.strictObject({ v, kind: z.literal('intent'), intent: ChartIntentSchema }),
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
