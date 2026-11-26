// A DOM page's HTTP requests (design 7.7). The page's fetch reaches native as a DomRequest, and
// only the routes a page is given are answered; anything else is a JSON 403 and nothing is sent.
// A route reads the fields it needs from the page's body, so the page's `apikey` placeholder
// never travels: the HTTP client adds the real key. Errors reach the page as the server's error
// envelope with the app's own copy, never as a 401: web code would redirect to /login.
import type { z } from 'zod'
import { ApiError, type ApiErrorKind, userMessage } from '~/core/http/errors'
import type { DomReply, DomRequest, JSONValue } from '~/dom/bridge/protocol'

export type Route = {
  method: 'GET' | 'POST'
  /** Matched exactly: no prefix, case folding or trailing slash. */
  path: string
  handle(r: DomRequest, signal: AbortSignal): Promise<DomReply>
}

export const REFUSED_COPY = 'This request is not allowed in the app.'

export const ok = (data: JSONValue): DomReply => ({
  status: 200,
  body: { status: 'success', data },
})
export const refused = (): DomReply => ({
  status: 403,
  body: { status: 'error', message: REFUSED_COPY },
})

const STATUS: Record<ApiErrorKind, number> = {
  RateLimited: 429,
  Validation: 400,
  Unsupported: 404,
  KeyInvalid: 403,
  BrokerLoggedOut: 403,
  IpBanned: 403,
  SemiAutoBlocked: 403,
  MaybePlaced: 502,
  Server: 502,
  Network: 502,
}
/** What an error that is not an ApiError shows: nothing of its own text reaches the page. */
const FAILED = userMessage(new ApiError({ kind: 'Server', status: 0, endpoint: 'dom' }))

/** The reply for an error a route met: its status by kind, never 401, and its user message. */
export function fromApiError(e: unknown): DomReply {
  const status = e instanceof ApiError ? STATUS[e.kind] : 502
  const message = e instanceof ApiError ? userMessage(e) : FAILED
  return { status, body: { status: 'error', message } }
}

/**
 * The fields `schema` names, read from a page's body, or null when one is missing or wrong.
 * `schema` is a plain z.object, so every other field, `apikey` among them, is dropped rather than
 * refused (preflight conflict 16).
 */
export function pickFields<S extends z.ZodType>(body: unknown, schema: S): z.output<S> | null {
  const r = schema.safeParse(body)
  return r.success ? r.data : null
}

const abortError = () =>
  Object.assign(new Error('The page aborted the request.'), { name: 'AbortError' })

/** Resolves once `whenActive` does; rejects at once when `signal` aborts first. */
function untilActive(whenActive: () => Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    whenActive()
      .finally(() => signal.removeEventListener('abort', onAbort))
      .then(resolve, reject)
  })
}

/**
 * The request handler for DomHost. `whenActive` (resolved while the screen is shown, else at its
 * next focus) gates every request, so a hidden chart's 30 s history tail stops (design 7.5).
 * A refusal answers at once. A request the page aborts rejects, which DomHost takes as given up.
 */
export function createRequestRouter(
  routes: readonly Route[],
  o: { whenActive?: () => Promise<void> } = {},
): (r: DomRequest, signal: AbortSignal) => Promise<DomReply> {
  return async (r, signal) => {
    const route = routes.find((x) => x.method === r.method && x.path === r.path)
    if (!route) return refused()
    try {
      await untilActive(o.whenActive ?? (async () => {}), signal)
      return await route.handle(r, signal)
    } catch (e) {
      if (signal.aborted) throw e
      return fromApiError(e)
    }
  }
}
