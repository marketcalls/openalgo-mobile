// The one place that talks HTTP to the server (design 7.5). The key goes only in a POST
// body; logs carry only `id status ms`.
import type { z } from 'zod'
import { NGROK_HEADER } from '~/core/config/constants'
import { log } from '~/core/log/logger'
import {
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  type EndpointDef,
  type EndpointId,
  type Lane,
} from './endpoints'
import {
  ApiError,
  type ApiErrorInit,
  type BanForm,
  invalidSymbols,
  isRecord,
  unknownFields,
} from './errors'

export type RawResponse = { status: number; contentType: string; text: string; json?: unknown }

export type RequestOptions = { signal?: AbortSignal }

export type HttpClient = {
  /** POSTs `body` plus the key, classifies the reply, and parses a success with `schema`. */
  request<T>(
    id: EndpointId,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    o?: RequestOptions,
  ): Promise<T>
  /** A keyless GET. Throws only Network or IpBanned; any other reply comes back raw. */
  getPublic(path: string): Promise<RawResponse>
  /** POSTs `{}` with no key: an existing endpoint answers 400 JSON (S7). A ban throws. */
  probe(id: EndpointId): Promise<'present' | 'absent' | 'unknown'>
}

export type HttpClientDeps = {
  origin: string
  getKey: () => string
  fetch: typeof fetch
  /** Splits a 403 "Invalid openalgo apikey" on an endpoint that also checks the broker. */
  resolveAuth403: () => Promise<'key_invalid' | 'broker_logged_out'>
  /** Sees every endpoint response (request and probe) before it is classified. */
  onResponse?: (id: EndpointId, res: RawResponse) => void
}

const TAG = 'http'
const GET_HEADERS = { Accept: 'application/json', ...NGROK_HEADER }
// Flask refuses request.json without it, and the handlers turn that into a 500 (GC).
const POST_HEADERS = { ...GET_HEADERS, 'Content-Type': 'application/json' }
const ORDER_LANES: ReadonlySet<string> = new Set(['order', 'smart'])
const INVALID_KEY = 'Invalid openalgo apikey'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * What a request that got no reply rejects with: a dropped connection, a timeout or the
 * caller's abort. On an order lane the order may still have gone.
 */
export function noReplyError(id: EndpointId, lane: Lane = ENDPOINTS[id].lane): ApiError {
  const kind = ORDER_LANES.has(lane) ? 'MaybePlaced' : 'Network'
  return new ApiError({ kind, status: 0, endpoint: id })
}

/** A reply counts only if it is JSON with a string `status` (S6). */
const hasStatus = (json: unknown): json is Record<string, unknown> & { status: string } =>
  isRecord(json) && typeof json.status === 'string'

const isHtml = (raw: RawResponse) => raw.contentType.toLowerCase().includes('text/html')

function banFormOf(raw: RawResponse): BanForm | undefined {
  if (raw.status !== 403) return undefined
  if (
    raw.contentType.toLowerCase().includes('text/plain') &&
    raw.text.startsWith('Access Denied')
  ) {
    return 'text'
  }
  if (isRecord(raw.json) && raw.json.error === 'Access Denied' && !('status' in raw.json)) {
    return 'json'
  }
  return undefined
}

/** The server's `message` as one line; a dict of field errors reads `field: reason; …`. */
function messageOf(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined
  const m = json.message
  if (typeof m === 'string') return m
  if (!isRecord(m)) return undefined
  return Object.entries(m)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : JSON.stringify(v)}`)
    .join('; ')
}

export function createHttpClient(d: HttpClientDeps): HttpClient {
  const base = d.origin.replace(/\/+$/, '')

  async function exchange(
    label: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RawResponse> {
    const started = Date.now()
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    const forward = () => ctrl.abort()
    if (signal?.aborted) ctrl.abort()
    else signal?.addEventListener('abort', forward, { once: true })
    try {
      const res = await d.fetch(base + path, { ...init, credentials: 'omit', signal: ctrl.signal })
      const text = await res.text()
      const contentType = res.headers.get('content-type') ?? ''
      log.info(TAG, `${label} ${res.status} ${Date.now() - started}ms`)
      return { status: res.status, contentType, text, json: parseJson(text) }
    } catch (e) {
      log.info(TAG, `${label} ${timedOut ? 'timeout' : 'failed'} ${Date.now() - started}ms`)
      throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  /** The classification table (first match wins); null means a success to parse. */
  async function failureOf(
    id: EndpointId,
    def: EndpointDef,
    raw: RawResponse,
  ): Promise<ApiError | null> {
    const s = raw.status
    const ok = s >= 200 && s < 300
    const orderLane = ORDER_LANES.has(def.lane)
    const serverMessage = messageOf(raw.json)
    const fail = (kind: ApiErrorInit['kind'], extra: Partial<ApiErrorInit> = {}) =>
      new ApiError({ kind, status: s, endpoint: id, serverMessage, ...extra })

    const banForm = banFormOf(raw)
    if (banForm) return fail('IpBanned', { banForm })
    if (s === 429) return fail('RateLimited')
    if (!hasStatus(raw.json)) {
      if (ok && def.expect !== 'json') return null
      if ((s === 200 || s === 404) && isHtml(raw)) return fail('Unsupported')
      // A proxy's page (nginx 502/504, Cloudflare 520/524) or a crash page: the order may have
      // reached the broker. 501 and 503 mean the request was never forwarded.
      if (orderLane && s >= 500 && s !== 501 && s !== 503) return fail('MaybePlaced')
      return fail('Server')
    }
    if (s === 403 && serverMessage?.includes('Semi-Auto')) return fail('SemiAutoBlocked')
    if (s === 403 && serverMessage === INVALID_KEY) {
      if (def.keyOnly) return fail('KeyInvalid')
      let split: 'key_invalid' | 'broker_logged_out'
      try {
        split = await d.resolveAuth403()
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'IpBanned') return e
        // The key check got no answer: the 403 stands (status 403), so it is never retried.
        log.warn(TAG, `${id} 403: the key check failed`)
        return fail('Server')
      }
      return fail(split === 'key_invalid' ? 'KeyInvalid' : 'BrokerLoggedOut')
    }
    const unknown = s === 400 ? unknownFields(raw.json) : undefined
    if (unknown || s === 404 || s === 501) return fail('Unsupported', { unknownFields: unknown })
    if ((s >= 400 && s < 500) || (ok && raw.json.status === 'error')) {
      return fail('Validation', s === 400 ? { invalidSymbols: invalidSymbols(raw.json) } : {})
    }
    if (s === 502 && orderLane) return fail('MaybePlaced')
    if (!ok) return fail('Server')
    return null
  }

  return {
    async request(id, body, schema, o) {
      const def = ENDPOINTS[id]
      if (def.method !== 'POST') {
        throw new Error(`${id} is a GET route, which takes the key in its URL; the app sends none`)
      }
      const payload = JSON.stringify({ ...body, apikey: d.getKey() })
      let raw: RawResponse
      try {
        raw = await exchange(
          id,
          def.path,
          { method: 'POST', headers: POST_HEADERS, body: payload },
          def.timeoutMs,
          o?.signal,
        )
      } catch {
        throw noReplyError(id, def.lane)
      }
      d.onResponse?.(id, raw)
      const failure = await failureOf(id, def, raw)
      if (failure) throw failure
      const parsed = schema.safeParse(def.expect === 'json' ? raw.json : raw.text)
      if (parsed.success) return parsed.data
      const paths = new Set(
        parsed.error.issues.map((i) => i.path.map(String).join('.') || '(root)'),
      )
      log.warn(TAG, `${id} schema mismatch at ${[...paths].join(', ')}`)
      throw new ApiError({ kind: 'Server', status: raw.status, endpoint: id })
    },

    async getPublic(path) {
      let raw: RawResponse
      try {
        raw = await exchange(
          path,
          path,
          { method: 'GET', headers: GET_HEADERS },
          DEFAULT_TIMEOUT_MS,
        )
      } catch {
        throw new ApiError({ kind: 'Network', status: 0, endpoint: path })
      }
      const banForm = banFormOf(raw)
      if (banForm) {
        throw new ApiError({ kind: 'IpBanned', status: raw.status, endpoint: path, banForm })
      }
      return raw
    },

    async probe(id) {
      let raw: RawResponse
      try {
        raw = await exchange(
          `probe ${id}`,
          ENDPOINTS[id].path,
          { method: 'POST', headers: POST_HEADERS, body: '{}' },
          DEFAULT_TIMEOUT_MS,
        )
      } catch {
        return 'unknown'
      }
      d.onResponse?.(id, raw)
      const banForm = banFormOf(raw)
      if (banForm) {
        throw new ApiError({ kind: 'IpBanned', status: raw.status, endpoint: id, banForm })
      }
      if (raw.status === 404) return 'absent'
      if (raw.status === 400 && hasStatus(raw.json)) return 'present'
      if (raw.status === 200 && !hasStatus(raw.json) && isHtml(raw)) return 'absent'
      return 'unknown'
    },
  }
}
