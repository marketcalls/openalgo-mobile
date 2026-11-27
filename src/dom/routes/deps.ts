// What the on-device routes read (design 7.8): the option data and the symbol master the native
// screens share, /api/v1 for the searches, and the server's clock, which every Greek prices at.
// A reply the web route or its service makes itself (a refused body, "Could not determine spot
// price") is a RouteError carrying that route's status and body; a failed /api/v1 read is the
// HTTP client's ApiError, answered by plan D's fromApiError.
import type { Api } from '~/core/http/api'
import type { SymbolMaster } from '~/market/master/master'
import type { OptionsData } from '~/market/options/data'

export type RouteDeps = {
  options: OptionsData
  master: Pick<SymbolMaster, 'underlyingsNow'>
  api: Pick<Api, 'call'>
  /** The server's clock, epoch ms (Services.clock.now). */
  now: () => number
}

/** The page's request signal: an aborted page request drops its /api/v1 reads. */
export type RouteOptions = { signal?: AbortSignal }

export type RouteErrorBody = { status: 'error'; message: string }

/** A reply the web route makes without the server: its status and its `{status, message}`. */
export class RouteError extends Error {
  readonly status: number
  readonly body: RouteErrorBody

  constructor(status: number, body: RouteErrorBody) {
    super(`${status}: ${body.message}`)
    this.name = 'RouteError'
    this.status = status
    this.body = body
  }
}

export const routeError = (status: number, message: string) =>
  new RouteError(status, { status: 'error', message })

/** iv_smile_service.py:53-54 and gex_service.py:56-57: the chain priced no underlying. */
export const NO_SPOT = 'Could not determine spot price'
