// A chain with the Greeks /optionchain with_greeks attaches (design 7.8, RF 4): a server from
// 2.0.2.0 prices them itself; a chain without them gets what option_chain_service.py would have
// added (get_option_chain :710-745 and _attach_chain_greeks :273-318 at c8b2896), priced on the
// phone at the server's clock.
import { chainForward, type LegGreeks, withGreeksChain } from './black76'
import { serverYears } from './expiry'
import { chainExpiryTs } from './live'
import type { ChainLeg, OptionChain } from './schemas'

/** A leg with its Greeks; as it is when it has none (the server leaves the fields out). */
function withLeg(leg: ChainLeg | null, g: LegGreeks | null | undefined): ChainLeg | null {
  if (!leg || !g) return leg
  const { iv, delta, gamma, theta, vega } = g
  return { ...leg, implied_volatility: iv, delta, gamma, theta, vega }
}

/**
 * `c` when its Greeks are included; else a copy with the forward from the chain's own ATM
 * parity, the expiry instant (the server's, else derived) and each leg's IV and Greeks at
 * `nowMs`, the server's clock. A leg that cannot be priced, and every leg of an expired chain or
 * one with no expiry instant, gets no Greek fields.
 */
export function ensureChainGreeks(
  c: OptionChain,
  o: { optionsExchange: string; nowMs: number },
): OptionChain {
  if (c.greeks_included === true) return c
  const expiryTs = chainExpiryTs(c, o.optionsExchange)
  const forward = chainForward(c.chain, c.atm_strike, c.underlying_ltp)
  const years = expiryTs === null ? 0 : serverYears(expiryTs * 1000, o.nowMs).years
  const greeks = withGreeksChain(c.chain, { forward, years })
  return {
    ...c,
    expiry_ts: expiryTs,
    forward_price: forward,
    greeks_included: true,
    chain: c.chain.map((row, i) => ({
      ...row,
      ce: withLeg(row.ce, greeks[i]?.ce),
      pe: withLeg(row.pe, greeks[i]?.pe),
    })),
  }
}
