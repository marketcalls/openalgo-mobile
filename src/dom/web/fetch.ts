// The page's fetch, answered by native over the bridge (design 7.7). Only the app's own paths are
// bridged: a relative URL or one on DOM_ORIGIN. Relative URLs resolve against DOM_ORIGIN, never
// the page's location, which is a file:// URL in a release build (preflight conflict 14).
// Anything else rejects as a network error would, and nothing crosses the bridge.
import { DOM_ORIGIN, type DomReply, type DomRequest, type JSONValue } from '~/dom/bridge/protocol'
import { type DomClient, isOk, nextRid } from './client'

/** What the bridged fetch resolves with: the part of `Response` the page's code reads. */
export type BridgedResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  clone(): BridgedResponse
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

type RequestLike = { url: string; method?: string; signal?: AbortSignal | null; body?: unknown }

/** A Request passed as the input; a string or URL is not one. A Request's url is absolute: one
 *  made from a relative path resolved it against the file:// page, so it is refused below. */
const requestOf = (input: RequestInfo | URL): RequestLike | null =>
  typeof input === 'object' && !(input instanceof URL) ? input : null

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

function toRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rid: number,
): DomRequest {
  const req = requestOf(input)
  const href = req ? req.url : String(input)
  let url: URL
  try {
    url = new URL(href, DOM_ORIGIN)
  } catch {
    throw new TypeError('openalgo-mobile: not a URL')
  }
  if (url.origin !== DOM_ORIGIN) throw new TypeError('openalgo-mobile: only app paths are fetched')

  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    throw new TypeError('openalgo-mobile: only GET and POST are fetched')
  }
  const out: DomRequest = { v: 1, kind: 'request', rid, method, path: url.pathname }
  if (url.search !== '') out.query = Object.fromEntries(url.searchParams)

  if (init?.body === undefined && req?.body != null) {
    throw new TypeError('openalgo-mobile: pass the body in init')
  }
  const body = init?.body
  if (body != null) {
    if (method === 'GET') throw new TypeError('openalgo-mobile: a GET has no body')
    if (typeof body !== 'string') throw new TypeError('openalgo-mobile: the body must be JSON text')
    try {
      out.body = JSON.parse(body)
    } catch {
      throw new TypeError('openalgo-mobile: the body must be JSON text')
    }
  }
  return out
}

/** A copy of a JSON body: what a clone reads, so changing one body leaves the other as it was. */
const copyOf = (body: JSONValue): JSONValue => JSON.parse(JSON.stringify(body))

// The bridge delivers the body already parsed. json() hands it over as it is and text() writes it
// out only when asked, so a large history reply on the chart-open path is never stringified only
// to be parsed again.
function toResponse(reply: DomReply): BridgedResponse {
  const { status, body } = reply
  return {
    ok: isOk(reply),
    status,
    statusText: STATUS_TEXT[status] ?? '',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => toResponse({ status, body: copyOf(body) }),
  }
}

export function createBridgedFetch(client: DomClient): typeof fetch {
  async function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? requestOf(input)?.signal
    if (signal?.aborted) throw abortError()
    const rid = nextRid()
    const request = toRequest(input, init, rid)

    // An abort rejects at once, here; native is told so it can drop the call.
    const reply = await new Promise<DomReply>((resolve, reject) => {
      const onAbort = () => {
        reject(abortError())
        client.call({ v: 1, kind: 'abort', rid }).catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      client.call(request).then(
        (r) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(r)
        },
        () => {
          signal?.removeEventListener('abort', onAbort)
          reject(new TypeError('openalgo-mobile: the bridge did not answer'))
        },
      )
    })
    return toResponse(reply) as unknown as Response
  }
  return bridgedFetch as typeof fetch
}
