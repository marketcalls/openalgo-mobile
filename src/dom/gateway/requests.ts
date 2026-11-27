// A DOM page's HTTP requests (design 7.7). The page's fetch reaches native as a DomRequest, and
// only the routes a page is given are answered; anything else is a JSON 403 and nothing is sent.
// A route reads the fields it needs from the page's body, so the page's `apikey` placeholder
// never travels: the HTTP client adds the real key. Errors reach the page as the server's error
// envelope with the app's own copy, never as a 401: web code would redirect to /login. A page
// has at most MAX_DOM_INFLIGHT requests in flight, so a buggy or hostile page cannot crowd the
// app's own read lane.
import type { z } from 'zod'
import { ApiError, type ApiErrorKind, userMessage } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import type { DomReply, DomRequest, JSONValue } from '~/dom/bridge/protocol'

export type Route = {
  method: 'GET' | 'POST'
  /** Matched exactly: no prefix, case folding or trailing slash. */
  path: string
  handle(r: DomRequest, signal: AbortSignal): Promise<DomReply>
}

export const REFUSED_COPY = 'This request is not allowed in the app.'
export const TOO_MANY_COPY = 'Too many requests at once. Try again.'
/**
 * The requests one page may have in flight at once, those waiting for `whenActive` among them;
 * one more is answered 429 at once and sends nothing. Raise it only by constant.
 */
export const MAX_DOM_INFLIGHT = 8

export const ok = (data: JSONValue): DomReply => ({
  status: 200,
  body: { status: 'success', data },
})
export const refused = (): DomReply => ({
  status: 403,
  body: { status: 'error', message: REFUSED_COPY },
})
const tooMany = (): DomReply => ({
  status: 429,
  body: { status: 'error', code: 'TOO_MANY', message: TOO_MANY_COPY },
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
export function untilActive(whenActive: () => Promise<void>, signal: AbortSignal): Promise<void> {
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

/** What a log line may say of an error: its name, never its message (it could carry anything). */
const errorName = (e: unknown) => (e instanceof Error ? e.name : typeof e)

/**
 * The request handler for DomHost; make one per page, since the in-flight cap counts this
 * router's requests. `whenActive` (resolved while the screen is shown, else at its next focus)
 * gates every request, so a hidden chart's 30 s history tail stops (design 7.5). A path no route
 * has is refused at once, without the wait, and so is a request past MAX_DOM_INFLIGHT (429). A
 * request the page aborts rejects, which DomHost takes as given up.
 *
 * `slotKey` names the requests that go as one (identical ones waiting through one hidden period,
 * which the caller coalesces): they hold one slot between them, from the first one's arrival to
 * the last one's end, so a page on Auto behind another screen is never refused its newest tick
 * (conflict 17 counted each). Null for a request that goes on its own, as every order write does.
 */
export function createRequestRouter(
  routes: readonly Route[],
  o: { whenActive?: () => Promise<void>; slotKey?: (r: DomRequest) => string | null } = {},
): (r: DomRequest, signal: AbortSignal) => Promise<DomReply> {
  let inflight = 0
  /** The requests sharing a slot, by their key. */
  const sharing = new Map<string, number>()
  const release = (key: string | null) => {
    if (key === null) {
      inflight--
      return
    }
    const left = (sharing.get(key) ?? 1) - 1
    if (left > 0) {
      sharing.set(key, left)
      return
    }
    sharing.delete(key)
    inflight--
  }
  return async (r, signal) => {
    const route = routes.find((x) => x.method === r.method && x.path === r.path)
    if (!route) return refused()
    const key = o.slotKey?.(r) ?? null
    const joins = key !== null && sharing.has(key)
    if (!joins && inflight >= MAX_DOM_INFLIGHT) return tooMany()
    if (!joins) inflight++
    if (key !== null) sharing.set(key, (sharing.get(key) ?? 0) + 1)
    try {
      await untilActive(o.whenActive ?? (async () => {}), signal)
      return await route.handle(r, signal)
    } catch (e) {
      if (signal.aborted) throw e
      // An ApiError is an outcome the HTTP client classified (and logs); anything else is a bug.
      if (!(e instanceof ApiError)) log.warn('dom', `a route failed: ${errorName(e)}`)
      return fromApiError(e)
    } finally {
      release(key)
    }
  }
}
