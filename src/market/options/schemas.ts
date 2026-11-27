// The option replies the tools and the Option Chain read (design 7.8): `/expiry` and
// `/optionchain` as services/option_chain_service.py builds it at openalgo.ref (:656-745). A
// 2.0.0.0 server (b7cdf2636) sends no quote identity, expiry instant, server clock or Greeks, so
// those are optional. Numbers that arrive as strings are read as numbers.
import { z } from 'zod'
import { num, optNum, str } from '~/core/http/coerce'
import { envelope } from '~/core/http/schemas'

/** services/expiry_service.py: DD-MMM-YY, sorted, today's kept. */
export const ExpirySchema = envelope(z.array(str))

/** A quote field the server fills with `ce_quote.get(field, 0)`: absent, null or unreadable is 0. */
const quote = optNum.catch(undefined).transform((v) => v ?? 0)
/** A Greek the server attaches only where it computed one; absent otherwise. */
const greek = optNum.catch(undefined)

const ChainLeg = z.object({
  symbol: str,
  label: str.catch(''),
  ltp: quote,
  bid: quote,
  ask: quote,
  bid_qty: quote,
  ask_qty: quote,
  open: quote,
  high: quote,
  low: quote,
  prev_close: quote,
  volume: quote,
  oi: quote,
  lotsize: quote,
  tick_size: quote,
  implied_volatility: greek,
  delta: greek,
  gamma: greek,
  theta: greek,
  vega: greek,
})

/** A strike's row: a side the server does not list (or cannot read) is null. */
const ChainRow = z.object({
  strike: num,
  ce: ChainLeg.nullish()
    .catch(null)
    .transform((l) => l ?? null),
  pe: ChainLeg.nullish()
    .catch(null)
    .transform((l) => l ?? null),
})

/** null where the server could not derive the value (`expiry_ts`, `forward_price`). */
const optNullable = z.null().or(optNum.catch(undefined))
/** A field only some servers send. */
const optStr = str.optional().catch(undefined)
const optBool = z.boolean().optional().catch(undefined)

export const OptionChainSchema = z.object({
  status: z.literal('success'),
  underlying: str,
  /** The quote identity the server priced the underlying from (2.0.2.0+). */
  underlying_symbol: optStr,
  underlying_exchange: optStr,
  underlying_ltp: num,
  underlying_prev_close: quote,
  /** DDMMMYY. */
  expiry_date: str,
  /** The expiry instant in epoch seconds, at the exchange's cut-off (2.0.2.0+). */
  expiry_ts: optNullable,
  /** The server's clock in epoch seconds (2.0.2.0+). */
  server_ts: optNum.catch(undefined),
  atm_strike: num,
  quotes_included: optBool,
  greeks_included: optBool,
  /** The forward the Greeks were priced at, when `with_greeks` gave them. */
  forward_price: optNullable,
  chain: z.array(ChainRow),
})

export type OptionChain = z.output<typeof OptionChainSchema>
export type ChainRow = z.output<typeof ChainRow>
export type ChainLeg = z.output<typeof ChainLeg>
