// Which option chain an instrument opens (design 17.2: "for any underlying that has options, and
// for derivatives, their underlying's chain"). The table knows the index underlyings and every
// derivative's; an NSE stock opens its chain when the symbol master lists options on it, or, with
// no master stored, when the day's one expiry read lists any (useOptionChainTarget).
import { useEffect, useState } from 'react'
import { log } from '~/core/log/logger'
import type { InstrumentMeta } from './instruments/meta'
import type { SymbolMaster } from './master/master'
import type { OptionsData } from './options/data'
import { useTrading } from './trading'

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
      // an NSE stock is useOptionChainTarget's to check
      return null
  }
}

/**
 * Whether NSE `symbol` has options on NFO: the symbol master's answer when one is stored, else
 * the IST day's expiry read (OptionsData caches it). A failed read offers no chain.
 */
export async function stockHasOptions(
  d: { master: Pick<SymbolMaster, 'hasOptions'>; options: Pick<OptionsData, 'expiries'> },
  symbol: string,
): Promise<boolean> {
  const listed = await d.master.hasOptions('NFO', symbol)
  if (listed !== null) return listed
  try {
    return (await d.options.expiries('NFO', symbol, 'options')).length > 0
  } catch (e) {
    log.warn('optionchain', `the option chain check for ${symbol} failed`, e)
    return false
  }
}

/**
 * `optionChainTarget`, and an NSE stock's own chain once `stockHasOptions` says it has one (null
 * until then). `meta` is undefined while the instrument is not known.
 */
export function useOptionChainTarget(
  meta: Pick<InstrumentMeta, 'exchange' | 'symbol' | 'name'> | undefined,
): { exchange: string; symbol: string } | null {
  const { master, options } = useTrading()
  const stock = meta?.exchange === 'NSE' ? meta.symbol : null
  const [checked, setChecked] = useState<{ symbol: string; has: boolean } | null>(null)
  useEffect(() => {
    if (stock === null) return
    let live = true
    void stockHasOptions({ master, options }, stock).then((has) => {
      if (live) setChecked({ symbol: stock, has })
    })
    return () => {
      live = false
    }
  }, [stock, master, options])
  if (!meta) return null
  if (stock === null) return optionChainTarget(meta)
  return checked?.symbol === stock && checked.has ? { exchange: 'NSE', symbol: stock } : null
}
