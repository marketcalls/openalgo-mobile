// The watchlist's one REST call: a snapshot on each focus, so a row shows a price before the
// first tick. After that the socket (or the polling engine) keeps it current.
import { useEffect } from 'react'
import { MultiQuotesSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { multiquoteToPatch, quoteKey } from '~/core/realtime/protocol'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import type { WatchItem } from '~/market/watchlists/model'

export function useSeedQuotes(items: readonly WatchItem[]): void {
  const { api, store } = useServices()
  const active = useScreenActive()
  // a new array with the same symbols must not seed again
  const sig = items.map((i) => quoteKey(i.exchange, i.symbol)).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sig` stands for `items`
  useEffect(() => {
    if (!active || items.length === 0) return
    let live = true
    // taken before the request: a tick that lands meanwhile is newer and wins
    const at = Date.now()
    const symbols = items.map((i) => ({ symbol: i.symbol, exchange: i.exchange }))
    api
      .call('multiquotes', { symbols }, MultiQuotesSchema)
      .then((results) => {
        if (!live) return
        for (const r of results) {
          if (r.data) store.seed(quoteKey(r.exchange, r.symbol), multiquoteToPatch(r.data), at)
        }
      })
      .catch((e) => log.warn('watchlist', 'could not seed quotes', e))
    return () => {
      live = false
    }
  }, [active, api, store, sig])
}
