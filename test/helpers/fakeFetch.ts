export type ScriptedRequest = {
  method: string
  url: string
  /** Header names lowercased. */
  headers: Record<string, string>
  credentials: RequestCredentials | undefined
  /** The JSON-parsed body, the raw string when it does not parse, or undefined. */
  body: unknown
}

export type ScriptedReply = {
  status: number
  contentType?: string
  /** Extra response headers, such as `date`; names are matched case-insensitively. */
  headers?: Record<string, string>
  /** A string is sent as-is (default `text/plain`); anything else as JSON. */
  body: unknown
}

type Outcome = ScriptedReply | 'throw'
export type Route = Outcome | ((req: ScriptedRequest) => Outcome | Promise<Outcome>)

/**
 * A fetch that answers from `routes`, keyed `'POST /api/v1/<path>'` or `'GET <path>'`.
 * `'throw'` rejects like a dropped connection, as does an unknown route; aborting the
 * request's signal rejects with an AbortError, even while a route function is pending.
 */
export function scriptedFetch(
  routes: Record<string, Route>,
): typeof fetch & { calls: ScriptedRequest[] } {
  const calls: ScriptedRequest[] = []
  const fake = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const req: ScriptedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers: lowerKeys(init.headers),
      credentials: init.credentials,
      body: parseBody(init.body),
    }
    calls.push(req)
    const key = `${req.method} ${pathOf(url)}`
    const route = routes[key]
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal
      const abort = () => reject(abortError())
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      Promise.resolve()
        .then(() => (typeof route === 'function' ? route(req) : route))
        .then((out) => {
          if (out === undefined) throw new TypeError(`scriptedFetch: no route for ${key}`)
          if (out === 'throw') throw new TypeError('Network request failed')
          resolve(toResponse(out))
        })
        .catch(reject)
    })
  }
  return Object.assign(fake as typeof fetch, { calls })
}

function pathOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/)[0] || '/'
}

function lowerKeys(h: RequestInit['headers']): Record<string, string> {
  if (!h) return {}
  if (Array.isArray(h) || typeof (h as Headers).forEach === 'function') {
    throw new TypeError('scriptedFetch: pass headers as a plain object')
  }
  return Object.fromEntries(
    Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  )
}

function parseBody(body: RequestInit['body']): unknown {
  if (body === undefined || body === null) return undefined
  if (typeof body !== 'string') throw new TypeError('scriptedFetch: only string bodies')
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted.')
  e.name = 'AbortError'
  return e
}

function toResponse(r: ScriptedReply): Response {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
  const contentType =
    r.contentType ?? (typeof r.body === 'string' ? 'text/plain' : 'application/json')
  const res = {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase()
        if (n === 'content-type') return contentType
        const hit = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === n)
        return hit ? hit[1] : null
      },
    },
    text: async () => text,
  }
  return res as unknown as Response
}
