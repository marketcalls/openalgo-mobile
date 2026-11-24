import { z } from 'zod'
import { optNum, str } from '~/core/http/coerce'
import { envelope, type Instrument } from '~/core/http/schemas'
import { isQuoteOnly, usesLots } from './exchanges'
import { resolveTick } from './tick'

/** `symbol {symbol, exchange}` (C1): the same fields a search row carries. */
export const SymbolSchema = envelope(
  z.object({
    symbol: str,
    exchange: str,
    name: str.nullish(),
    token: str.nullish(),
    expiry: str.nullish(),
    strike: optNum,
    lotsize: optNum,
    instrumenttype: str.nullish(),
    tick_size: optNum,
    freeze_qty: optNum,
  }),
)

export type InstrumentMeta = {
  exchange: string
  symbol: string
  name: string
  /** Units per lot; 1 when the server leaves it blank. */
  lotsize: number
  /** The tick prices snap to (0.05 for an index). */
  tick: number
  /** Largest order in units; 0 means unknown. */
  freezeQty: number
  instrumenttype: string
  expiry: string | null
  strike: number | null
  quoteOnly: boolean
  /** Quantity is in lots on this exchange. */
  lots: boolean
}

/** A `/symbol` result or a search row as metadata. Blanks follow the web's `Number(x) || n`. */
export function toMeta(row: Instrument): InstrumentMeta {
  const strike = Number(row.strike)
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    name: row.name || row.symbol,
    lotsize: Number(row.lotsize) || 1,
    tick: resolveTick(row.exchange, row.tick_size),
    freezeQty: Number(row.freeze_qty) || 0,
    instrumenttype: row.instrumenttype ?? '',
    expiry: row.expiry || null,
    // The server's "none" is -0.01.
    strike: strike > 0 ? strike : null,
    quoteOnly: isQuoteOnly(row.exchange),
    lots: usesLots(row.exchange),
  }
}
