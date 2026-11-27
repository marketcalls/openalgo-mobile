// The body of the five tool routes, read as each web route reads it before calling its service:
// blueprints/oitracker.py:44-61 (and :96-113), ivsmile.py:43-62, gex.py:43-62 and
// gamma_density.py:47-66 at openalgo.ref. Each field is trimmed and cut to the route's length,
// every other field (the page's `apikey` among them) is dropped, and the same patterns apply
// (preflight conflict 23).
import { z } from 'zod'
import { isRecord } from '~/core/http/errors'
import { routeError } from './deps'

export const REQUIRED_COPY = 'underlying, exchange, and expiry_date are required'
export const FORMAT_COPY = 'Invalid input format'
export const EXPIRY_COPY = 'Invalid expiry_date format. Expected DDMMMYY'
/** The routes' `except Exception` reply, which a field that is not a string reaches. */
export const FAILED_COPY = 'An error occurred processing your request'

/** `data.get(name, "").strip()[:max]`. */
const field = (max: number) =>
  z
    .string()
    .default('')
    .transform((s) => s.trim().slice(0, max))

/** The route's checks in its order: all three present, then the two patterns, then the expiry. */
function problem(q: { underlying: string; exchange: string; expiry_date: string }) {
  if (!q.underlying || !q.exchange || !q.expiry_date) return REQUIRED_COPY
  if (!/^[A-Z0-9]+$/.test(q.underlying) || !/^[A-Z0-9_]+$/.test(q.exchange)) return FORMAT_COPY
  if (!/^\d{2}[A-Z]{3}\d{2}$/.test(q.expiry_date)) return EXPIRY_COPY
  return null
}

/**
 * A tool query: underlying ^[A-Z0-9]+$ and exchange ^[A-Z0-9_]+$ (each at most 20 characters
 * once trimmed), expiry_date DDMMMYY. A failed check is a custom issue holding the web's message;
 * a field that is not a string fails as a type.
 */
export const ToolQuerySchema = z
  .object({ underlying: field(20), exchange: field(20), expiry_date: field(10) })
  .superRefine((q, ctx) => {
    const message = problem(q)
    if (message) ctx.addIssue({ code: 'custom', message })
  })

export type ToolQuery = z.output<typeof ToolQuerySchema>

/**
 * The page's body as a ToolQuery, or the web route's refusal: 400 with its message, or 500 for a
 * value its `.strip()` raises on. No body reads as `{}` (`request.get_json(silent=True) or {}`).
 */
export function parseToolQuery(body: unknown): ToolQuery {
  if (body !== undefined && body !== null && !isRecord(body)) throw routeError(500, FAILED_COPY)
  const r = ToolQuerySchema.safeParse(body ?? {})
  if (r.success) return r.data
  const refused = r.error.issues.every((i) => i.code === 'custom')
  const message = r.error.issues[0]?.message
  throw refused && message ? routeError(400, message) : routeError(500, FAILED_COPY)
}
