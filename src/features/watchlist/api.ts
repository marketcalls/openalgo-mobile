// The watchlist's one REST call: a snapshot on each focus, so a row shows a price before the
// first tick. After that the socket (or the polling engine) keeps it current. The snapshot also
// finds the contracts the server does not list (RF 1).
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { ApiError } from '~/core/http/errors'
import { MultiQuotesSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { multiquoteToPatch, quoteKey } from '~/core/realtime/protocol'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import { isValidationRefusal } from '~/market/instruments/cache'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import {
  createList,
  type Reduced,
  setActive,
  type WatchItem,
  type Watchlists,
} from '~/market/watchlists/model'

/**
 * Seeds the tick store for `items` on each focus, unless the broker is blocked. Keys the server
 * itself refuses (an entry with its validation refusal, or a 400's `invalid_symbols`) join the
 * session's unknown set, which is returned, and are not asked for again until their refusal is
 * old or the set is cleared (the broker session turns active, or a new IST day). A seed of
 * several symbols that the server refuses every one of looks like its symbol table being
 * reloaded rather than a list of expired contracts, so those refusals are tentative: they stand
 * for minutes, not for the session. A broker failure entry marks nothing.
 */
export function useSeedQuotes(items: readonly WatchItem[]): { unknown: ReadonlySet<string> } {
  const { api, store } = useServices()
  const { instruments, unknown } = useTrading()
  const active = useScreenActive()
  const blocked = useBrokerBlocked()
  const keys = useStore(unknown, (st) => st.keys)
  // a clear moves it on, so the keys it forgot are asked for again
  const epoch = useStore(unknown, (st) => st.epoch)
  // a new array with the same symbols must not seed again
  const sig = items.map((i) => quoteKey(i.exchange, i.symbol)).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sig` stands for `items`
  useEffect(() => {
    if (!active || blocked) return
    // A new IST day forgets the refusals; the new epoch runs this again.
    if (unknown.getState().rollover()) return
    // Read here, not as a dependency: a key found unknown must not re-seed the rest.
    const todo = items.filter(
      (i) =>
        !unknown.getState().keys.has(quoteKey(i.exchange, i.symbol)) &&
        instruments.peek(i.exchange, i.symbol) !== 'unknown',
    )
    if (todo.length === 0) return
    let live = true
    // taken before the request: a tick that lands meanwhile is newer and wins
    const at = Date.now()
    // a reply from before a clear must not bring its refusals back
    const refuse = (ks: string[]) => {
      if (unknown.getState().epoch !== epoch) return
      const all = todo.length > 1 && todo.every((i) => ks.includes(quoteKey(i.exchange, i.symbol)))
      unknown.getState().add(ks, { tentative: all })
    }
    const symbols = todo.map((i) => ({ symbol: i.symbol, exchange: i.exchange }))
    api
      .call('multiquotes', { symbols }, MultiQuotesSchema)
      .then((results) => {
        const refused: string[] = []
        for (const r of results) {
          const k = quoteKey(r.exchange, r.symbol)
          if (isValidationRefusal(r.error)) refused.push(k)
          else if (r.data && live) store.seed(k, multiquoteToPatch(r.data), at)
        }
        refuse(refused)
      })
      .catch((e: unknown) => {
        const v = e instanceof ApiError && e.kind === 'Validation' ? e : undefined
        // the whole batch refused for some entries' exchange: those entries, by index, so one
        // item from a hand-edited or another server's backup does not blank every price
        const at = v?.refusedAt
          ?.map((i) => todo[i])
          .filter((i): i is WatchItem => i !== undefined)
          .map((i) => ({ exchange: i.exchange, symbol: i.symbol }))
        const refused = v?.invalidSymbols ?? (at?.length ? at : undefined)
        if (refused) refuse(refused.map((s) => quoteKey(s.exchange, s.symbol)))
        else log.warn('watchlist', 'could not seed quotes', e)
      })
    return () => {
      live = false
    }
  }, [active, blocked, api, store, instruments, unknown, sig, epoch])
  return { unknown: keys }
}

/** An id no list in `w` has. */
export function newListId(w: Watchlists, now: number = Date.now()): string {
  let n = now
  const taken = new Set(w.lists.map((l) => l.id))
  while (taken.has(`l${n.toString(36)}`)) n++
  return `l${n.toString(36)}`
}

/** Adds a list and shows it, in one save. */
export function createAndOpen(
  w: Watchlists,
  name: string,
  id: string,
): Reduced<'ok' | 'limit' | 'bad_name'> {
  const made = createList(w, name, id)
  if (made.result !== 'ok') return made
  return { next: setActive(made.next, id).next, result: 'ok' }
}
