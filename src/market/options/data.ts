// The option data the tools and the Option Chain share (design 7.8): expiries from /expiry, read
// once per IST day; the futures price as services/oi_tracker_service.py:24-117 finds it; and the
// chain, whose `server_ts` sets the server clock that every Greek prices at.
import type { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import type { RequestOptions } from '~/core/http/client'
import { QuotesSchema } from '~/core/http/schemas'
import type { ServerClock } from '~/core/http/serverClock'
import { log } from '~/core/log/logger'
import { qk } from '~/core/query/keys'
import { istDate } from '~/core/realtime/marketHours'
import { toDdmmmyy } from './expiry'
import { ExpirySchema, type OptionChain, OptionChainSchema } from './schemas'

export type ChainQuery = {
  underlying: string
  exchange: string
  /** DDMMMYY. */
  expiry_date: string
  strike_count: number
  /** Sent only when true, so a request without Greeks has no such field (an older server's body). */
  with_greeks?: boolean
}

export type OptionsData = {
  /** The listed expiries, DD-MMM-YY, nearest first; one read per IST day. */
  expiries(exchange: string, underlying: string, type: 'options' | 'futures'): Promise<string[]>
  /**
   * The futures price the OI tools show: the future of `expiry` (DDMMMYY) when one is listed,
   * else the nearest, quoted as `U + DDMMMYY + 'FUT'`; null when none is listed or its quote
   * fails. CRYPTO: `chainLtp`, since the chain already quotes the perpetual.
   */
  futuresPrice(
    underlying: string,
    exchange: string,
    expiry: string,
    chainLtp: number,
  ): Promise<number | null>
  chain(q: ChainQuery, o?: RequestOptions): Promise<OptionChain>
}

const TAG = 'options'
/** utils/constants.py CRYPTO_EXCHANGES. */
const CRYPTO_EXCHANGES: ReadonlySet<string> = new Set(['CRYPTO'])

export function createOptionsData(d: {
  api: Pick<Api, 'call'>
  queryClient: QueryClient
  pid: string
  clock: ServerClock
}): OptionsData {
  const { api, queryClient, pid, clock } = d
  /** The IST day on the server's clock; `deviceMs` is a time on the phone's. */
  const serverDay = (deviceMs: number) => istDate(deviceMs + clock.offsetMs())

  const expiries: OptionsData['expiries'] = (exchange, underlying, type) =>
    queryClient.fetchQuery({
      queryKey: qk.expiry(pid, exchange, underlying, type),
      queryFn: () =>
        api.call('expiry', { symbol: underlying, exchange, instrumenttype: type }, ExpirySchema),
      // the server drops an expiry at its own midnight: fresh until the server's IST day moves on
      staleTime: (q) =>
        serverDay(q.state.dataUpdatedAt) === istDate(clock.now()) ? Number.POSITIVE_INFINITY : 0,
      gcTime: Number.POSITIVE_INFINITY,
    })

  return {
    expiries,

    async futuresPrice(underlying, exchange, expiry, chainLtp) {
      if (CRYPTO_EXCHANGES.has(exchange.toUpperCase())) return chainLtp
      try {
        const futures = await expiries(exchange, underlying, 'futures')
        const wanted = toDdmmmyy(expiry)
        const pick = futures.find((f) => wanted !== null && toDdmmmyy(f) === wanted) ?? futures[0]
        const code = pick === undefined ? null : toDdmmmyy(pick)
        if (code === null) return null
        const q = await api.call(
          'quotes',
          { symbol: `${underlying}${code}FUT`, exchange },
          QuotesSchema,
        )
        return q.ltp ?? null
      } catch (e) {
        log.warn(TAG, `futures price for ${underlying} on ${exchange} not read`, e)
        return null
      }
    },

    async chain(q, o) {
      const body = {
        underlying: q.underlying,
        exchange: q.exchange,
        expiry_date: q.expiry_date,
        strike_count: q.strike_count,
        ...(q.with_greeks ? { with_greeks: true } : {}),
      }
      const c = await api.call('optionchain', body, OptionChainSchema, o)
      // The phone's own time of the reply: the clock's reading less the offset it applies.
      if (c.server_ts !== undefined) clock.noteServerTs(c.server_ts, clock.now() - clock.offsetMs())
      return c
    },
  }
}
