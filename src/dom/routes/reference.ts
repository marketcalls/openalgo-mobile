// The underlying a series route charts and quotes, as strategy_builder_reference_service.py:21-67
// (at c8b2896) resolves it for the strategy charts, and the straddle and IV chart services alike:
// the chain's own pair when a 2.0.2.0 server names one, else an index on its index exchange, a
// stock on NSE or BSE, a no-spot venue's near-month future, or CRYPTO's perpetual.
import { SearchSchema } from '~/core/http/schemas'
import { byCharCode } from '~/market/master/db'
import { extractUnderlying } from '~/market/master/underlying'
import { toDdmmmyy } from '~/market/options/expiry'
import type { RouteDeps } from './deps'

/** NSE_INDEX_SYMBOLS. oi_profile_service.py:60-68 defines a shorter set but never uses it. */
export const NSE_INDEX = [
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'NIFTYIT',
  'NIFTYPHARMA',
  'NIFTYBANK',
] as const
export const BSE_INDEX = ['SENSEX', 'BANKEX', 'SENSEX50'] as const
/** option_symbol_service.py NO_SPOT_EXCHANGES: no tradable spot, so the near future prices it. */
export const NO_SPOT = ['MCX', 'CDS', 'BCD', 'NCDEX', 'NCO'] as const

const has = (list: readonly string[], v: string) => list.includes(v)

/** get_quote_exchange: the exchange an underlying is quoted and charted on. */
export function quoteExchange(base: string, exchange: string): string {
  const upper = exchange.toUpperCase()
  if (has(NSE_INDEX, base)) return 'NSE_INDEX'
  if (has(BSE_INDEX, base)) return 'BSE_INDEX'
  if (upper === 'NFO') return 'NSE'
  if (upper === 'BFO') return 'BSE'
  return upper
}

type Listing = {
  symbol: string
  exchange: string
  name: string
  type: string
  underlying: string | null
}

/**
 * fno_search_symbols(query, exchange, instrumenttype=PERPFUT, limit=1)
 * (database/token_db_enhanced.py:697-848): a PERPFUT row whose symbol or name holds `query`, the
 * first by exact underlying, then underlying prefix, then symbol prefix, then symbol.
 */
function perpetual(rows: readonly Listing[], query: string): Listing | null {
  const key = (r: Listing) =>
    [
      r.underlying === query,
      r.underlying?.startsWith(query),
      r.symbol.toUpperCase().startsWith(query),
    ]
      .map((first) => (first ? '0' : '1'))
      .join('') + r.symbol
  const hits = rows.filter(
    (r) =>
      r.type.toUpperCase() === 'PERPFUT' &&
      (r.symbol.toUpperCase().includes(query) || r.name.toUpperCase().includes(query)),
  )
  return hits.sort((a, b) => byCharCode(key(a), key(b)))[0] ?? null
}

/** CRYPTO's `${base}USDFUT` perpetual: from the master when one is stored, else the search. */
async function cryptoPerpetual(base: string, venue: string, d: RouteDeps): Promise<Listing | null> {
  const query = `${base}USDFUT`
  const master = await d.master.futures(venue)
  if (master) {
    return perpetual(
      master.map((r) => ({ ...r, type: r.itype })),
      query,
    )
  }
  const rows = await d.api.call('search', { query, exchange: venue }, SearchSchema)
  return perpetual(
    rows.map((r) => ({
      symbol: r.symbol,
      exchange: r.exchange,
      name: r.name ?? '',
      type: r.instrumenttype ?? '',
      underlying: extractUnderlying(r.symbol, r.exchange),
    })),
    query,
  )
}

/**
 * resolve_strategy_builder_reference: the pair `given` (the chain's underlying_symbol and
 * underlying_exchange) when both are there; else CRYPTO's perpetual, a no-spot venue's near
 * future (the first `/expiry` futures date) or `base` on its quote exchange. null when the venue
 * needs a future or a perpetual it does not list (RF 4).
 */
export async function resolveReference(
  base: string,
  exchange: string,
  d: RouteDeps,
  given?: { symbol?: string; exchange?: string },
): Promise<{ symbol: string; exchange: string } | null> {
  const u = base.trim().toUpperCase()
  const venue = exchange.trim().toUpperCase()
  if (given?.symbol && given.exchange) {
    return {
      symbol: given.symbol.trim().toUpperCase(),
      exchange: given.exchange.trim().toUpperCase(),
    }
  }
  if (venue === 'CRYPTO') {
    const p = await cryptoPerpetual(u, venue, d)
    return p
      ? {
          symbol: p.symbol.trim().toUpperCase(),
          exchange: (p.exchange || venue).trim().toUpperCase(),
        }
      : null
  }
  if (has(NO_SPOT, venue)) {
    const [near] = await d.options.expiries(venue, u, 'futures')
    const code = near === undefined ? null : toDdmmmyy(near)
    return code === null ? null : { symbol: `${u}${code}FUT`, exchange: venue }
  }
  return { symbol: u, exchange: quoteExchange(u, venue) }
}
