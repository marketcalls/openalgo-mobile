// /api/v1/optionchain for a DOM page (design 7.8): the server's reply as it came, except that a
// page asking `with_greeks` always gets the Greeks. A server from 2.0.2.0 prices them itself
// (option_chain_service.py:656-745 at openalgo.ref). Before it, the request goes without the
// Greeks fields, and the phone attaches what _attach_chain_greeks would: each priced leg's
// implied_volatility, delta, gamma, theta and vega from withGreeksChain at the chain's own
// forward, with forward_price, expiry_ts (derived from the expiry when absent) and
// greeks_included. The reply is built from the server's body, so a leg keeps every field as sent
// (an ltp of null stays null).
import type { Api } from '~/core/http/api'
import { ENDPOINTS } from '~/core/http/endpoints'
import { ApiError, isRecord } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import type { JSONValue } from '~/dom/bridge/protocol'
import { chainForward, type LegGreeks, withGreeksChain } from '~/market/options/black76'
import { expiryInstantMs, optionsExchangeOf, serverYears } from '~/market/options/expiry'
import { OptionChainSchema } from '~/market/options/schemas'
import { type Route, refused } from './requests'
import { PassThroughSchema, pageBody } from './toolAllowlist'

/** The request fields only the Greeks use (restx_api/data_schemas.py:200-205): an older server
 *  refuses both as unknown. */
const GREEKS_FIELDS: ReadonlySet<string> = new Set(['with_greeks', 'interest_rate'])

type Reply = Record<string, unknown>

/** A leg with its Greeks, or as it came when it has none (the server leaves the fields out). */
function withLeg(leg: unknown, g: LegGreeks | null | undefined): unknown {
  if (!g || !isRecord(leg)) return leg
  const { iv, delta, gamma, theta, vega } = g
  return { ...leg, implied_volatility: iv, delta, gamma, theta, vega }
}

/** The interest rate in percent the page asked for, as the server's schema accepts it. */
const rateOf = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined

/**
 * `reply` with the chain's Greeks priced at `nowMs` (the server's clock). A new object: the reply
 * may be shared with another caller of the same read (the scheduler's dedupe).
 */
function withPhoneGreeks(reply: Reply, page: Reply, nowMs: number): JSONValue {
  const parsed = OptionChainSchema.safeParse(reply)
  if (!parsed.success) {
    log.warn('dom', 'optionchain reply unreadable: its Greeks were not priced')
    throw new ApiError({ kind: 'Server', status: 200, endpoint: 'optionchain' })
  }
  const c = parsed.data
  const exchange = typeof page.exchange === 'string' ? page.exchange : ''
  const derived = expiryInstantMs(c.expiry_date, optionsExchangeOf(exchange))
  const expiryMs = typeof c.expiry_ts === 'number' ? c.expiry_ts * 1000 : derived
  const forward = chainForward(c.chain, c.atm_strike, c.underlying_ltp)
  // No expiry instant, or an expired chain: no leg is priced (the server skips them all).
  const years = expiryMs === null ? 0 : serverYears(expiryMs, nowMs).years
  const greeks = withGreeksChain(c.chain, { forward, years, ratePct: rateOf(page.interest_rate) })
  // the schema read `chain` as an array, row for row
  const rows = reply.chain as unknown[]
  return {
    ...reply,
    expiry_ts: expiryMs === null ? null : expiryMs / 1000,
    greeks_included: true,
    forward_price: forward,
    chain: rows.map((row, i) =>
      isRecord(row)
        ? { ...row, ce: withLeg(row.ce, greeks[i]?.ce), pe: withLeg(row.pe, greeks[i]?.pe) }
        : row,
    ),
  } as JSONValue
}

/**
 * `greeksOnServer`: whether the server prices `with_greeks` (gate optionchainGreeks). `now`: the
 * server's clock in epoch ms (Services.clock.now), which the phone's Greeks price at.
 */
export function createOptionChainRoute(d: {
  api: Pick<Api, 'call'>
  greeksOnServer: () => boolean
  now: () => number
}): Route {
  return {
    method: 'POST',
    path: ENDPOINTS.optionchain.path,
    async handle(r, signal) {
      const body = pageBody(r.body)
      if (body === null) return refused()
      const asked = body.with_greeks === true
      const onServer = d.greeksOnServer()
      const sent = onServer
        ? body
        : Object.fromEntries(Object.entries(body).filter(([k]) => !GREEKS_FIELDS.has(k)))
      const reply = await d.api.call('optionchain', sent, PassThroughSchema, { signal })
      if (!asked || (onServer && reply.greeks_included === true)) {
        return { status: 200, body: reply as JSONValue }
      }
      return { status: 200, body: withPhoneGreeks(reply, body, d.now()) }
    },
  }
}
