// What the on-device routes read (design 7.8): the option data and the symbol master the native
// screens share, /api/v1 for the searches, and the server's clock, which every Greek prices at;
// for plan F's long loads, the tool screen's life, focus and progress line, and OI Profile's
// previous-day OI cache. A reply the web route or its service makes itself (a refused body,
// "Could not determine spot price") is a RouteError carrying that route's status and body; a
// failed /api/v1 read is the HTTP client's ApiError, answered by plan D's fromApiError.
import type { z } from 'zod'
import type { Api } from '~/core/http/api'
import type { IntervalsSchema } from '~/market/chart/schemas'
import type { PrevOiCache } from '~/market/history/prevOi'
import type { SymbolMaster } from '~/market/master/master'
import type { OptionsData } from '~/market/options/data'

/** A long load's progress, for the tool screen's progress line. */
export type ToolProgress = { label: string; done: number; total: number }

export type RouteDeps = {
  options: OptionsData
  master: Pick<SymbolMaster, 'underlyingsNow' | 'strikes' | 'futures' | 'lotSizeLike'>
  api: Pick<Api, 'call'>
  /** The server's clock, epoch ms (Services.clock.now). */
  now: () => number
  /** Whether /optionchain prices the Greeks itself (2.0.2.0's `with_greeks`); else the phone does. */
  greeksOnServer: () => boolean
  /** Aborted when the tool screen goes or its page loads again: work a route keeps on after its
   *  reply (OI Profile's previous-day OI) stops with it. A route reads it when a request starts:
   *  the next load gets a new one. */
  lifetime: AbortSignal
  progress: (p: ToolProgress) => void
  /** Whether the tool screen is shown (design 7.5: a hidden one calls nothing). */
  active: () => boolean
  /** Resolves when the tool screen is shown (at once if it is); rejects when `s` aborts first. */
  untilActive: (s: AbortSignal) => Promise<void>
  /** The broker's intervals: one /intervals read per tool screen. */
  intervals: () => Promise<z.output<typeof IntervalsSchema>>
  /** OI Profile's previous-day OI of each leg, on the profile's storage. */
  prevOi: PrevOiCache
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
