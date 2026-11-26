// The depth book's logic, shared by the depth screen and the instrument sheet: the level choices
// and their downgrades, the live book, and the read error. Run it once per screen (it holds the
// feed subscription); a header reads the quote itself with `useQuote`.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { DepthSchema } from '~/core/http/schemas'
import { type DepthLevels, depthRestToPatch, type Quote, quoteKey } from '~/core/realtime/protocol'
import { useLiveDepth } from '~/core/realtime/useLive'
import { useFeedStale, useQuote } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import {
  confirmLevels,
  depthChoices,
  downgradeKey,
  supportedDepth,
} from '~/market/instruments/depthSupport'
import { useBroker, useBrokerBlocked } from '~/market/session'
import { type DepthDowngrades, useTrading } from '~/market/trading'
import { CONFIRM_SETTLE_MS, type LadderRow, LEVEL_TICKS, ladderRows, NO_BOOK_MS } from '../model'

export const FIVE_ONLY = 'This broker sends 5 levels here.'
export const NEEDS_LIVE = 'Deeper levels need the live feed'

export type DepthBookState = {
  levels: DepthLevels
  choices: DepthLevels[]
  pick(n: DepthLevels): void
  note: string | null
  rows: { bids: LadderRow[]; asks: LadderRow[] }
  q: Quote | undefined
  hasBook: boolean
  failed: { error: unknown; retry(): void } | null
  blocked: boolean
  stale: boolean
}

export function useDepthBook(p: { exchange: string; symbol: string }): DepthBookState {
  const { exchange, symbol } = p
  const active = useScreenActive()
  const blocked = useBrokerBlocked()
  const stale = useFeedStale()
  const broker = useBroker()
  const feedLive = useConnection((c) => c.feed === 'live')
  const { depthDowngrades } = useTrading()
  const downgraded = useStore(depthDowngrades, (st) => st.keys)
  const choices = depthChoices({ broker, exchange, live: feedLive, downgraded })
  const [picked, setPicked] = useState<DepthLevels>(5)
  // A choice the feed can no longer bear (it went down, or was downgraded) falls back to 5.
  const levels = choices.includes(picked) ? picked : 5
  const depth = useLiveDepth(exchange, symbol, levels)
  // The depth subscription's own ticks: no second quote consumer (ruling 10).
  const q = useQuote(quoteKey(exchange, symbol), active)
  const dkey = broker === null ? null : downgradeKey(broker, exchange)
  useLevelCheck({
    exchange,
    symbol,
    requested: levels,
    active,
    feedLive,
    q,
    dkey,
    downgrades: depthDowngrades,
  })
  const failed = useBookError({
    exchange,
    symbol,
    hasBook: depth !== undefined,
    active,
    feedLive,
    blocked,
  })
  const deeper = supportedDepth(broker, exchange).length > 1
  const note = !deeper
    ? null
    : dkey !== null && downgraded.has(dkey)
      ? FIVE_ONLY
      : feedLive
        ? null
        : NEEDS_LIVE
  return {
    levels,
    choices,
    pick: setPicked,
    note,
    rows: ladderRows(depth, levels),
    q,
    hasBook: depth !== undefined,
    failed,
    blocked,
    stale,
  }
}

/**
 * Ruling 10: once a deeper subscribe has settled, the feed's own facts decide whether the broker
 * really sends those levels here; if not, the broker and exchange drop to 5 for the session.
 * Every (re)subscribe starts a fresh check: a new choice, the screen coming back into view, or
 * the feed coming back live.
 */
function useLevelCheck(p: {
  exchange: string
  symbol: string
  requested: DepthLevels
  /** The screen holds the subscription. */
  active: boolean
  feedLive: boolean
  q: Quote | undefined
  dkey: string | null
  /** The session's downgraded pairs, on `Trading`. */
  downgrades: DepthDowngrades
}) {
  const { realtime } = useServices()
  const { exchange, symbol, requested, feedLive, q, dkey, downgrades } = p
  const checking = p.active && feedLive && requested > 5
  const [check, setCheck] = useState<{ since: number; requested: DepthLevels } | null>(null)
  /** At most LEVEL_TICKS counts; `done` once the verdict is in. */
  const seen = useRef<{ last?: Quote; levels: readonly number[]; done: boolean }>({
    levels: [],
    done: false,
  })

  useEffect(() => {
    setCheck(null)
    if (!checking) return
    const t = setTimeout(() => {
      seen.current = { levels: [], done: false }
      setCheck({ since: Date.now(), requested })
    }, CONFIRM_SETTLE_MS)
    return () => clearTimeout(t)
  }, [checking, requested])

  useEffect(() => {
    if (!checking || check === null || check.requested !== requested || dkey === null) return
    const s = seen.current
    // The verdict is in: later ticks are neither kept nor judged until the next subscribe.
    if (s.done) return
    if (q && q !== s.last) {
      s.last = q
      // Only the socket's own depth ticks since the subscribe count, never a poll or an empty book.
      if (q.source === 'ws' && q.depth && q.depth.levels > 0 && q.ts >= check.since) {
        s.levels = [...s.levels, q.depth.levels]
      }
    }
    // confirmedDepth's levels part is the most levels any tick on the new wire entry carried,
    // the 5-level subscription's late ticks included. Once a tick since the window has shown more
    // than 5, that part is above 5, so a confirmedDepth of 5 or fewer can only be the ack's.
    const deeperSeen = s.levels.some((n) => n > 5)
    const { downgraded } = confirmLevels({
      requested,
      feedLive,
      wired: realtime.isLive(exchange, symbol),
      confirmedDepth: deeperSeen ? realtime.confirmedDepth(exchange, symbol) : undefined,
      wsLevels: s.levels,
    })
    if (downgraded) downgrades.getState().add(dkey)
    // Two ticks in: either both were 5 or fewer (a downgrade), or one was deeper, so
    // confirmedDepth was judged with it. Nothing a later tick brings changes that.
    s.done = downgraded || s.levels.length >= LEVEL_TICKS
  }, [checking, check, requested, dkey, q, feedLive, realtime, exchange, symbol, downgrades])
}

/**
 * Design 7.11: a book that does not come is a read error, with a retry. It has failed when the
 * price polls are failing (on this screen, the depth poll is the one running), or when, with the
 * feed not live, no book came within NO_BOOK_MS. "Try again" polls `/depth` once at once rather
 * than at the next interval; when that fails, its own error is the one shown. Nothing shows while
 * the broker is blocked: nothing may poll it then, and its banner says why.
 */
function useBookError(p: {
  exchange: string
  symbol: string
  hasBook: boolean
  active: boolean
  feedLive: boolean
  blocked: boolean
}): { error: unknown; retry: () => void } | null {
  const { api, store, polling } = useServices()
  const { exchange, symbol, hasBook, blocked } = p
  const pollFailing = useSyncExternalStore(polling.onHealth, () => polling.health() === 'failing')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [timedOut, setTimedOut] = useState(false)
  const waiting = p.active && !hasBook && !p.feedLive && !blocked

  // biome-ignore lint/correctness/useExhaustiveDependencies: each retry restarts the wait
  useEffect(() => {
    setTimedOut(false)
    if (!waiting) return
    const t = setTimeout(() => setTimedOut(true), NO_BOOK_MS)
    return () => clearTimeout(t)
  }, [waiting, attempt])

  const retry = useCallback(async () => {
    setBusy(true)
    setError(null)
    setAttempt((n) => n + 1)
    try {
      const data = await api.call('depth', { symbol, exchange }, DepthSchema)
      store.put(quoteKey(exchange, symbol), depthRestToPatch(data), 'poll')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }, [api, store, exchange, symbol])

  if (hasBook || blocked || busy) return null
  if (error === null && !pollFailing && !timedOut) return null
  return { error, retry: () => void retry() }
}
