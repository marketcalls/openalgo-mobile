// Quote and market depth (design 7.5): the day's quote over a ladder of bids and asks. A level
// tap opens a LIMIT ticket at its price, BUY and SELL a MARKET one. Where the broker's feed sends
// deeper books (C8) a level switch appears, kept only while the feed bears it out (ruling 10). An
// index shows its quote alone; an expired or unknown contract shows only that, and takes no feed
// slot (ruling 8). A book that does not come is a read error, with a retry (design 7.11).
import { type Href, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from 'zustand'
import { DepthSchema } from '~/core/http/schemas'
import { type DepthLevels, depthRestToPatch, type Quote, quoteKey } from '~/core/realtime/protocol'
import { useLiveDepth, useLiveQuote } from '~/core/realtime/useLive'
import { useFeedStale, useQuote } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { StaleNote } from '~/market/components/StaleNote'
import {
  confirmLevels,
  depthChoices,
  downgradeKey,
  supportedDepth,
} from '~/market/instruments/depthSupport'
import { isQuoteOnly, usesLots } from '~/market/instruments/exchanges'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { chartHref, ticketHref } from '~/market/links'
import { useBroker, useBrokerBlocked } from '~/market/session'
import { type DepthDowngrades, useTrading } from '~/market/trading'
import type { TicketParams } from '~/market/types'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Change } from '~/ui/Change'
import { ErrorState } from '~/ui/ErrorState'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { Ladder } from '../components/Ladder'
import { CONFIRM_SETTLE_MS, LEVEL_TICKS, ladderRows, levelTicket, NO_BOOK_MS } from '../model'

const FIVE_ONLY = 'This broker sends 5 levels here.'
const NEEDS_LIVE = 'Deeper levels need the live feed'
/** The footer's own padding above and below its buttons, before the safe-area inset. */
const FOOTER_PAD = 12

type Key = { exchange: string; symbol: string }

export function DepthScreen({ exchange, symbol }: Key) {
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  const name = inst.meta?.name
  return (
    <View style={styles.fill} testID="depth-screen">
      <BrokerBanner />
      {refused || inst.unknown ? (
        <View style={styles.body}>
          <Title exchange={exchange} symbol={symbol} />
          <Badge testID="depth-unknown" label="Expired or unknown" tone="warning" />
        </View>
      ) : inst.loading ? (
        <Skeleton />
      ) : isQuoteOnly(exchange) ? (
        <QuoteOnly exchange={exchange} symbol={symbol} name={name} />
      ) : (
        <Depth exchange={exchange} symbol={symbol} name={name} />
      )}
    </View>
  )
}

/** An index: its quote and a chart, nothing to trade (mode 2, no book). */
function QuoteOnly(p: Key & { name?: string }) {
  const q = useLiveQuote(p.exchange, p.symbol, 2)
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Header {...p} q={q} />
    </ScrollView>
  )
}

function Depth(p: Key & { name?: string }) {
  const { exchange, symbol } = p
  const router = useRouter()
  const active = useScreenActive()
  const blocked = useBrokerBlocked()
  const stale = useFeedStale()
  const broker = useBroker()
  const insets = useSafeAreaInsets()
  const feedLive = useConnection((c) => c.feed === 'live')
  const { depthDowngrades } = useTrading()
  const downgraded = useStore(depthDowngrades, (st) => st.keys)
  const choices = depthChoices({ broker, exchange, live: feedLive, downgraded })
  const [picked, setPicked] = useState<DepthLevels>(5)
  // A choice the feed can no longer bear (it went down, or was downgraded) falls back to 5.
  const levels = choices.includes(picked) ? picked : 5
  const depth = useLiveDepth(exchange, symbol, levels)
  // The header reads the depth subscription's own ticks: no second quote consumer (ruling 10).
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
  const rows = ladderRows(depth, levels)
  const open = (t: TicketParams) => router.push(ticketHref(t) as Href)
  const market = (action: TicketParams['action']) =>
    open({ exchange, symbol, action, pricetype: 'MARKET' })

  return (
    <>
      <ScrollView contentContainerStyle={styles.body}>
        <Header {...p} q={q} />
        {choices.length > 1 ? (
          <LevelSwitch choices={choices} value={levels} onChange={setPicked} />
        ) : null}
        {note ? (
          <Text testID="depth-levels-note" variant="caption" tone="muted">
            {note}
          </Text>
        ) : null}
        {failed ? (
          // outside the stale dimming: the retry must not look disabled
          <View testID="depth-error">
            <ErrorState error={failed.error} onRetry={failed.retry} />
          </View>
        ) : (
          <View style={{ opacity: stale ? 0.5 : 1 }}>
            {depth ? (
              <Ladder
                bids={rows.bids}
                asks={rows.asks}
                disabled={blocked}
                onLevel={(side, price) => open(levelTicket(side, price, exchange, symbol))}
              />
            ) : (
              <Skeleton rows={5} />
            )}
            <View style={styles.totals}>
              <Total testID="depth-total-buy" label="Total buy qty" value={q?.totalBuyQty} />
              <Total testID="depth-total-sell" label="Total sell qty" value={q?.totalSellQty} />
            </View>
          </View>
        )}
      </ScrollView>
      {/* The home indicator or gesture bar sits under the screen's bottom edge. */}
      <View
        testID="depth-footer"
        style={[styles.footer, { paddingBottom: FOOTER_PAD + insets.bottom }]}
      >
        <View style={styles.fill}>
          <Button
            testID="depth-buy"
            title="BUY"
            variant="buy"
            disabled={blocked}
            onPress={() => market('BUY')}
          />
        </View>
        <View style={styles.fill}>
          <Button
            testID="depth-sell"
            title="SELL"
            variant="sell"
            disabled={blocked}
            onPress={() => market('SELL')}
          />
        </View>
      </View>
    </>
  )
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

function Title({ exchange, symbol, name }: Key & { name?: string }) {
  return (
    <View style={styles.title}>
      <Text variant="heading" numberOfLines={1}>
        {symbol}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {name ? `${name} · ${exchange}` : exchange}
      </Text>
    </View>
  )
}

/** LTP and change, the day's range, prev close and volume, and OI where contracts trade in lots. */
function Header(p: Key & { name?: string; q: Quote | undefined }) {
  const { exchange, symbol, q } = p
  const router = useRouter()
  const stale = useFeedStale()
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Title {...p} />
        <Button
          testID="depth-chart"
          title="Chart"
          variant="secondary"
          onPress={() => router.push(chartHref(exchange, symbol) as Href)}
        />
      </View>
      <View style={{ opacity: stale ? 0.5 : 1 }}>
        <Text variant="title" testID="depth-ltp" style={styles.ltp}>
          {fmtPrice(q?.ltp)}
        </Text>
        <Change change={q?.change} pct={q?.changePct} testID="depth-change" />
        <View style={styles.stats}>
          <Stat testID="depth-open" label="Open" value={fmtPrice(q?.open)} />
          <Stat testID="depth-high" label="High" value={fmtPrice(q?.high)} />
          <Stat testID="depth-low" label="Low" value={fmtPrice(q?.low)} />
          <Stat testID="depth-prev-close" label="Prev close" value={fmtPrice(q?.close)} />
          <Stat testID="depth-volume" label="Volume" value={fmtQty(q?.volume)} />
          {usesLots(exchange) ? <Stat testID="depth-oi" label="OI" value={fmtQty(q?.oi)} /> : null}
        </View>
      </View>
      {stale && q ? <StaleNote at={q.ts} /> : null}
    </View>
  )
}

function Stat({ testID, label, value }: { testID: string; label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" testID={testID}>
        {value}
      </Text>
    </View>
  )
}

function Total({ testID, label, value }: { testID: string; label: string; value?: number }) {
  return (
    <View style={styles.total}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" testID={testID}>
        {fmtQty(value)}
      </Text>
    </View>
  )
}

function LevelSwitch(p: {
  choices: DepthLevels[]
  value: DepthLevels
  onChange: (n: DepthLevels) => void
}) {
  const { c } = useTheme()
  return (
    <View style={styles.switchRow}>
      <Text variant="caption" tone="muted">
        Levels
      </Text>
      <View style={[styles.switch, { borderColor: c.border }]}>
        {p.choices.map((n) => {
          const on = n === p.value
          return (
            <Pressable
              key={n}
              testID={`depth-levels-${n}`}
              accessibilityRole="button"
              accessibilityLabel={`${n} levels`}
              accessibilityState={{ selected: on }}
              onPress={() => p.onChange(n)}
              style={[styles.segment, on && { backgroundColor: c.primary }]}
            >
              <Text style={{ color: on ? c.primaryForeground : c.foreground }}>{String(n)}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 16 },
  header: { gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, minWidth: 0, gap: 2 },
  ltp: { fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, marginTop: 8 },
  stat: { width: '33%', gap: 2 },
  totals: { flexDirection: 'row', gap: 8, marginTop: 12 },
  total: { flex: 1, gap: 2 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switch: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segment: { minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: FOOTER_PAD },
})
