// The Strategy Portfolio's web routes (blueprints/strategy_portfolio.py:24-127), answered from
// the phone's own store: nothing is sent to the server, which has no /api/v1 route for it. The
// checks and their copy are the blueprint's. Every refusal is `{status:'error', message}` with a
// 400 or 404, never 401 or 403, so the page shows the sentence rather than going to /login.
import type { DomReply, DomRequest, JSONValue } from '~/dom/bridge/protocol'
import { MAX_LEGS, PortfolioSavePayloadSchema, WATCHLISTS } from '~/market/strategies/schemas'
import { StrategyLimitError, type StrategyStore } from '~/market/strategies/store'
import type { Route } from './requests'

const BASE = '/api/strategy-portfolio'
/** `:id` of the item routes: digits only, at most 9 (the server's int converter, bounded). */
const ITEM = /^\/api\/strategy-portfolio\/(\d{1,9})$/

const fail = (status: 400 | 404, message: string): DomReply => ({
  status,
  body: { status: 'error', message },
})
const NOT_FOUND = fail(404, 'not found')
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
/** Python's `len` counts code points. */
const pyLen = (s: string) => [...s].length
const isWatchlist = (v: unknown): v is (typeof WATCHLISTS)[number] =>
  (WATCHLISTS as readonly unknown[]).includes(v)
const item = (e: unknown): DomReply => ({
  status: 200,
  body: { status: 'success', item: e as JSONValue },
})

/** The blueprint's `_validate_payload`, then the frontend's shapes; the first failure's copy. */
function parsePayload(body: unknown) {
  // `request.get_json(silent=True) or {}`: no body is an empty one.
  const data = body ?? {}
  if (!isRecord(data)) return { error: 'Invalid payload' }
  for (const field of ['name', 'watchlist', 'underlying', 'exchange']) {
    const v = data[field]
    if (typeof v !== 'string' || v.trim() === '') return { error: `'${field}' is required` }
  }
  if (!isWatchlist(data.watchlist)) {
    return { error: `watchlist must be one of [${WATCHLISTS.map((w) => `'${w}'`).join(', ')}]` }
  }
  if (!Array.isArray(data.legs) || data.legs.length === 0) {
    return { error: 'at least one leg is required' }
  }
  if (pyLen(data.name as string) > 120) return { error: 'name too long (max 120 chars)' }
  if (data.legs.length > MAX_LEGS) return { error: `too many legs (max ${MAX_LEGS})` }
  const r = PortfolioSavePayloadSchema.safeParse(data)
  return r.success ? { payload: r.data } : { error: 'Invalid payload' }
}

export function createPortfolioRoutes(store: StrategyStore): Route[] {
  const idOf = (r: DomRequest) => Number(ITEM.exec(r.path)?.[1])
  /** A save's reply: the item, or the phone's own refusal. */
  const saving = async (r: DomRequest, id?: number): Promise<DomReply> => {
    const p = parsePayload(r.body)
    if (!p.payload) return fail(400, p.error ?? 'Invalid payload')
    try {
      const saved = await store.save(p.payload, id)
      return saved ? item(saved) : NOT_FOUND
    } catch (e) {
      if (e instanceof StrategyLimitError) return fail(400, e.message)
      throw e
    }
  }
  return [
    {
      method: 'GET',
      path: BASE,
      async handle(r) {
        const w = r.query?.watchlist
        // `if watchlist and watchlist not in WATCHLISTS`: an empty one filters nothing.
        if (w && !isWatchlist(w)) return fail(400, 'invalid watchlist')
        const items = await store.list(isWatchlist(w) ? w : undefined)
        return { status: 200, body: { status: 'success', items: items as JSONValue } }
      },
    },
    {
      method: 'GET',
      path: `${BASE}/:id`,
      match: ITEM,
      async handle(r) {
        const found = await store.get(idOf(r))
        return found ? item(found) : NOT_FOUND
      },
    },
    { method: 'POST', path: BASE, handle: (r) => saving(r) },
    { method: 'PUT', path: `${BASE}/:id`, match: ITEM, handle: (r) => saving(r, idOf(r)) },
    {
      method: 'DELETE',
      path: `${BASE}/:id`,
      match: ITEM,
      async handle(r) {
        return (await store.remove(idOf(r)))
          ? { status: 200, body: { status: 'success' } }
          : NOT_FOUND
      },
    },
  ]
}
