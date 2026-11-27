// The chain's live feed (design 7.6, 7.8): while the screen is active and the feed is live, the
// underlying is held at mode 2 and every leg at Depth (mode 3, 5 levels): at most 103 symbols at
// 25 strikes a side. A chain with other legs (an expiry, count or underlying change) releases the
// old holds; a blur or a background releases them all. Rows read their own legs' ticks
// (StrikeRow); this hook gives what every row is priced at, re-read from the underlying's and
// the ATM pair's ticks at most once per FORWARD_THROTTLE_MS. Under polling the feed carries
// nothing: no holds, and the store's older ticks are not merged (the chain's own prices show).
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { quoteKey } from '~/core/realtime/protocol'
import { useServices } from '~/core/services/services'
import {
  type ChainPricing,
  FORWARD_THROTTLE_MS,
  livePricing,
  needsFutures,
  type QuoteOf,
  underlyingOf,
} from '~/market/options/live'
import type { OptionChain } from '~/market/options/schemas'
import { useTrading } from '~/market/trading'
import type { ChainTarget } from '../model'

const NONE: QuoteOf = () => undefined

export type ChainFeed = {
  /** The underlying's quote key; null where the feed has none (CRYPTO, a future not listed). */
  underlyingKey: string | null
  /** The store's quotes while the feed is live, else none. */
  quoteOf: QuoteOf
  pricing: ChainPricing | null
}

export function useChainFeed(p: {
  chain: OptionChain | undefined
  target: ChainTarget
  active: boolean
  live: boolean
}): ChainFeed {
  const s = useServices()
  const { options } = useTrading()
  const { chain, active, live } = p
  const { optionsExchange, underlying } = p.target
  const feeding = active && live

  // MCX and CDS before 2.0.2.0: the underlying is quoted as its near future
  const futures = useQuery({
    ...options.expiriesQuery(optionsExchange, underlying, 'futures'),
    enabled: active && chain !== undefined && needsFutures(chain, optionsExchange),
  })
  const und = chain ? underlyingOf(underlying, optionsExchange, chain, futures.data ?? []) : null
  const underlyingKey = und ? quoteKey(und.exchange, und.symbol) : null

  // One string per set of holds, so a refetch of the same legs holds nothing again.
  const legs = useMemo(() => {
    const out: string[] = []
    for (const r of chain?.chain ?? []) {
      if (r.ce) out.push(r.ce.symbol)
      if (r.pe) out.push(r.pe.symbol)
    }
    return out.join('\n')
  }, [chain])
  const underlyingHold = und ? `${und.exchange}\n${und.symbol}` : ''

  useEffect(() => {
    if (!feeding || legs === '') return
    const releases: (() => void)[] = []
    if (underlyingHold !== '') {
      const [exchange = '', symbol = ''] = underlyingHold.split('\n')
      releases.push(s.realtime.acquire({ exchange, symbol, mode: 2 }))
    }
    for (const symbol of legs.split('\n')) {
      releases.push(s.realtime.acquire({ exchange: optionsExchange, symbol, mode: 3, depth: 5 }))
    }
    return () => {
      for (const release of releases) release()
    }
  }, [feeding, legs, underlyingHold, optionsExchange, s.realtime])

  // The ticks the pricing reads: the underlying's and the ATM pair's.
  const atm = chain?.chain.find((r) => r.strike === chain.atm_strike)
  const watched = [
    underlyingKey,
    atm?.ce ? quoteKey(optionsExchange, atm.ce.symbol) : null,
    atm?.pe ? quoteKey(optionsExchange, atm.pe.symbol) : null,
  ]
    .filter((k): k is string => k !== null)
    .join('\n')
  const [beat, setBeat] = useState(0)
  useEffect(() => {
    if (!feeding || watched === '') return
    let last = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const fire = () => {
      timer = null
      last = Date.now()
      setBeat((n) => n + 1)
    }
    const onTick = () => {
      if (timer !== null) return
      const wait = last + FORWARD_THROTTLE_MS - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    }
    const offs = watched.split('\n').map((k) => s.store.subscribe(k, onTick))
    return () => {
      for (const off of offs) off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [feeding, watched, s.store])

  const quoteOf = useMemo<QuoteOf>(() => (live ? (k) => s.store.get(k) : NONE), [live, s.store])
  // `beat`, the throttled tick, re-reads the store's ticks. It is an argument, not only a listed
  // dependency: the React Compiler memoizes on what the callback reads and drops any other, which
  // left the ATM band, the ITM tint and the spot marker a tick behind the header's spot (OC-3).
  const pricing = useMemo(
    () =>
      pricedAt(beat, chain, quoteOf, {
        optionsExchange,
        underlyingKey: underlyingKey ?? '',
        clockOffsetMs: s.clock.offsetMs(),
      }),
    [chain, quoteOf, optionsExchange, underlyingKey, s.clock, beat],
  )
  return { underlyingKey, quoteOf, pricing }
}

/** `livePricing` at tick `_beat` (see the memo above). */
function pricedAt(
  _beat: number,
  chain: OptionChain | undefined,
  quoteOf: QuoteOf,
  o: Parameters<typeof livePricing>[2],
): ChainPricing | null {
  return chain ? livePricing(chain, quoteOf, o) : null
}
