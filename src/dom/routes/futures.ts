// The Strategy Builder's futures picker, answered on the phone: GET /scalping/api/futures
// (blueprints/scalping.py:513-565 at c8b2896), the futures contracts of an underlying on a
// derivative exchange, nearest first. The server reads its symbol table; the phone reads the
// stored master, and with none, /expiry's futures dates and /symbol for each of the nearest three.
import { ApiError } from '~/core/http/errors'
import { SymbolSchema } from '~/market/instruments/meta'
import { expiryInstantMs, toDdmmmyy } from '~/market/options/expiry'
import { type RouteDeps, type RouteOptions, routeError } from './deps'

/** scalping.py VALID_LEG_EXCHANGES. */
export const LEG_EXCHANGES = ['NFO', 'BFO', 'MCX', 'CDS'] as const
/** The contracts read one by one when no master is stored: the picker's nearest. */
const UNLISTED_READS = 3

export type FuturesContract = {
  symbol: string
  /** As the symbol table holds it: DD-MMM-YY. */
  expiry: string
  lotsize: number
  tick_size: number | null
}

const isLegExchange = (ex: string) => (LEG_EXCHANGES as readonly string[]).includes(ex)

/**
 * parse_expiry's order: by date, a stable sort, an expiry no format reads last. The master's and
 * /symbol's DD-MMM-YY is the form read here (the cut-off is the same for every row).
 */
const byExpiry = (contracts: FuturesContract[]) => {
  const at = (c: FuturesContract) => expiryInstantMs(c.expiry, 'NFO') ?? Number.POSITIVE_INFINITY
  return [...contracts].sort((a, b) => at(a) - at(b))
}

/** /symbol of one contract; null when the server does not list it (its 404). */
async function listed(
  symbol: string,
  exchange: string,
  fallbackExpiry: string,
  d: RouteDeps,
  o: RouteOptions,
): Promise<FuturesContract | null> {
  try {
    const s = await d.api.call('symbol', { symbol, exchange }, SymbolSchema, { signal: o.signal })
    return {
      symbol: s.symbol,
      expiry: s.expiry || fallbackExpiry,
      lotsize: s.lotsize ?? 0,
      tick_size: s.tick_size ?? null,
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

/**
 * `underlying` and `exchange` trimmed and upper-cased; no underlying, or an exchange outside
 * LEG_EXCHANGES, is the route's 400. The FUT rows named `underlying`, by expiry.
 */
export async function futuresContracts(
  underlying: string,
  exchange: string,
  d: RouteDeps,
  o: RouteOptions = {},
): Promise<{ status: 'success'; data: FuturesContract[] }> {
  const u = underlying.trim().toUpperCase()
  const ex = exchange.trim().toUpperCase()
  if (!u) throw routeError(400, 'underlying is required')
  if (!isLegExchange(ex)) throw routeError(400, `Invalid exchange: ${ex}`)

  const rows = await d.master.futures(ex)
  if (rows) {
    const named = rows.filter((r) => r.itype === 'FUT' && r.name === u)
    const data = named.map((r) => ({
      symbol: r.symbol,
      expiry: r.expiry,
      lotsize: r.lotsize,
      tick_size: r.tick,
    }))
    return { status: 'success', data: byExpiry(data) }
  }

  const nearest = (await d.options.expiries(ex, u, 'futures')).slice(0, UNLISTED_READS)
  const read = await Promise.all(
    nearest.map((e) => {
      const code = toDdmmmyy(e)
      return code === null ? null : listed(`${u}${code}FUT`, ex, e, d, o)
    }),
  )
  return { status: 'success', data: byExpiry(read.filter((c) => c !== null)) }
}
