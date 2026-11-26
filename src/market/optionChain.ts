// Which option chain an instrument opens (design 17.2: "for any underlying that has options, and
// for derivatives, their underlying's chain"). Without the symbol master the server cannot say
// which stocks have options, so this knows only the index underlyings; plan E's symbol-master
// check replaces it (and brings NSE stocks back).
import type { InstrumentMeta } from './instruments/meta'

/** The indices with listed options, by their index exchange. */
export const INDEX_OPTION_UNDERLYINGS = {
  NSE_INDEX: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'],
  BSE_INDEX: ['SENSEX', 'BANKEX', 'SENSEX50'],
} as const satisfies Record<string, readonly string[]>

type IndexExchange = keyof typeof INDEX_OPTION_UNDERLYINGS

const listed = (ex: IndexExchange, sym: string): boolean =>
  (INDEX_OPTION_UNDERLYINGS[ex] as readonly string[]).includes(sym)

/**
 * The underlying whose chain the instrument opens, or null when it has none here. A derivative
 * names its underlying in `name`: an NFO contract opens an NSE index's chain or else the stock's,
 * a BFO one only a BSE index's, and MCX, CDS and CRYPTO their own exchange's (design 7.8).
 */
export function optionChainTarget(
  meta: Pick<InstrumentMeta, 'exchange' | 'symbol' | 'name'>,
): { exchange: string; symbol: string } | null {
  const { exchange, symbol, name } = meta
  switch (exchange) {
    case 'NSE_INDEX':
    case 'BSE_INDEX':
      return listed(exchange, symbol) ? { exchange, symbol } : null
    case 'NFO':
      if (!name) return null
      return listed('NSE_INDEX', name)
        ? { exchange: 'NSE_INDEX', symbol: name }
        : { exchange: 'NSE', symbol: name }
    case 'BFO':
      return name && listed('BSE_INDEX', name) ? { exchange: 'BSE_INDEX', symbol: name } : null
    case 'MCX':
    case 'CDS':
    case 'CRYPTO':
      return name ? { exchange, symbol: name } : null
    default:
      // NSE stocks among them, until the symbol master can tell which have options
      return null
  }
}
