// The chain's two reads (design 7.8, 12): the underlying's option expiries, once per IST day, and
// its chain at the chosen expiry and strike count. Both run only while the screen is active, so a
// hidden or backgrounded chain makes no call. The chain refreshes every 30 s while the live feed
// carries its prices, and at the polling rate (5 s home, 10 s tunnel) when it does not. Its key
// holds the expiry, so a reply for an expiry no longer chosen never renders (RF 3).
import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { gate } from '~/core/capabilities/gates'
import { pollNetwork } from '~/core/config/urlRules'
import { POLL_RATES } from '~/core/realtime/polling'
import { useServices } from '~/core/services/services'
import { CHAIN_REFRESH_LIVE_MS } from '~/market/options/live'
import type { OptionChain } from '~/market/options/schemas'
import { useTrading } from '~/market/trading'
import { type ChainTarget, optionChainQuery } from '../model'

export type OptionChainRead = {
  /** The listed expiries, DD-MMM-YY, nearest first; undefined until read. */
  expiries: string[] | undefined
  expiriesError: unknown
  /** The expiry shown: the one picked while it is listed, else the nearest. */
  expiry: string | null
  chain: OptionChain | undefined
  /** No chain yet for this underlying, expiry and count. */
  chainPending: boolean
  /** The first read failed (no chain to show). */
  chainError: unknown
  /** When the last refresh failed while an earlier chain stays on screen; null otherwise. */
  refreshFailedAt: number | null
  updatedAt: number
  /** Polling: how often the chain is read (the feed carries no prices). */
  pollMs: number
  retry(): void
}

export function useOptionChain(p: {
  target: ChainTarget
  picked: string | null
  count: number
  active: boolean
  live: boolean
}): OptionChainRead {
  const s = useServices()
  const { options } = useTrading()
  const caps = useSyncExternalStore(s.caps.subscribe, s.caps.get)
  const withGreeks = caps !== null && gate(caps, 'optionchainGreeks').on
  const pollMs = POLL_RATES.optionchain[pollNetwork(s.profile.get().restOrigin)]
  const { optionsExchange, underlying } = p.target

  const ex = useQuery({
    ...options.expiriesQuery(optionsExchange, underlying, 'options'),
    enabled: p.active,
  })
  const list = ex.data
  const expiry =
    list === undefined
      ? null
      : p.picked !== null && list.includes(p.picked)
        ? p.picked
        : (list[0] ?? null)

  const q = useQuery({
    ...optionChainQuery(options, s.profile.get().id, {
      target: p.target,
      expiry: expiry ?? '',
      count: p.count,
      withGreeks,
    }),
    enabled: p.active && expiry !== null,
    refetchInterval: p.live ? CHAIN_REFRESH_LIVE_MS : pollMs,
  })
  const shown = q.data !== undefined

  return {
    expiries: list,
    expiriesError: list === undefined ? ex.error : null,
    expiry,
    chain: q.data,
    chainPending: !shown && !q.isError,
    chainError: shown ? null : q.error,
    refreshFailedAt: shown && q.isError ? q.errorUpdatedAt : null,
    updatedAt: q.dataUpdatedAt,
    pollMs,
    retry: () => void (list === undefined ? ex.refetch() : q.refetch()),
  }
}
