// The way the app calls /api/v1 (design 7.5): it adapts the body to what the server knows,
// sends it through the scheduler, and heals a read once when the server refuses an
// optional field (the only retry besides TanStack's).
import type { z } from 'zod'
import type { HttpClient, RequestOptions } from './client'
import { ENDPOINTS, type EndpointDef, type EndpointId } from './endpoints'
import { ApiError, isRecord } from './errors'
import type { Scheduler } from './scheduler'

/** Request fields an older server lacks. The capability store implements it. */
export type FieldGate = {
  /** The body without the fields this server is known to refuse. */
  adapt(id: EndpointId, body: Record<string, unknown>): Record<string, unknown>
  markUnsupported(id: EndpointId, field: string): void
}

export type Api = {
  call<T>(
    id: EndpointId,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    o?: RequestOptions,
  ): Promise<T>
}

/** `Api` plus the GET-only routes: a read-lane call that is shared per query and never self-heals. */
export type KeyedApi = Api & {
  get<T>(
    id: EndpointId,
    query: Record<string, string>,
    schema: z.ZodType<T>,
    o?: RequestOptions & { withKey?: boolean },
  ): Promise<T>
}

export type ApiDeps = {
  /** A fake that only sends POSTs may leave `get` out; `KeyedApi.get` then throws. */
  http: Pick<HttpClient, 'request'> & Partial<Pick<HttpClient, 'get'>>
  scheduler: Pick<Scheduler, 'run'>
  fields: FieldGate
}

/** JSON with object keys sorted at every depth, so equal bodies give equal strings. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    isRecord(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
}

/** The fields to drop when `e` is a read refusing only optional fields that were sent. */
function healable(def: EndpointDef, sent: Record<string, unknown>, e: unknown) {
  if (!(e instanceof ApiError) || e.kind !== 'Unsupported' || !e.unknownFields) return undefined
  if (def.lane !== 'read' && def.lane !== 'history') return undefined
  const optional = def.optional ?? []
  const all = e.unknownFields.every((f) => optional.includes(f) && f in sent)
  return all ? e.unknownFields : undefined
}

export function createApi({ http, scheduler, fields }: ApiDeps): KeyedApi {
  function send<T>(
    id: EndpointId,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    o?: RequestOptions,
  ): Promise<T> {
    return scheduler.run({
      endpoint: id,
      lane: ENDPOINTS[id].lane,
      // The body never holds the key: the client adds it. The scheduler skips orders, and a
      // fresh read is never shared.
      dedupeKey: o?.fresh ? undefined : `${id} ${stableJson(body)}`,
      // The caller's abort rejects only this call; the request itself aborts on the
      // scheduler's signal, once every caller sharing it has aborted.
      signal: o?.signal,
      exec: (signal) => http.request(id, body, schema, { ...o, signal }),
    })
  }

  return {
    get(id, query, schema, o) {
      const get = http.get
      if (!get) throw new Error('this client sends no GET routes')
      return scheduler.run({
        endpoint: id,
        lane: ENDPOINTS[id].lane,
        dedupeKey: o?.fresh ? undefined : `${id} ${stableJson(query)}`,
        signal: o?.signal,
        exec: (signal) => get(id, query, schema, { ...o, signal }),
      })
    },

    async call(id, body, schema, o) {
      const sent = fields.adapt(id, body)
      try {
        return await send(id, sent, schema, o)
      } catch (e) {
        const drop = healable(ENDPOINTS[id], sent, e)
        if (!drop) throw e
        for (const f of drop) fields.markUnsupported(id, f)
        const rest = Object.fromEntries(Object.entries(sent).filter(([k]) => !drop.includes(k)))
        return send(id, rest, schema, o)
      }
    },
  }
}
