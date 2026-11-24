// Quote and market depth (design 7.5): the day's quote over a ladder of bids and asks. A level
// tap opens a LIMIT ticket at its price, BUY and SELL a MARKET one. Where the broker's feed sends
// deeper books (C8) a level switch appears, kept only while the feed bears it out (ruling 10). An
// index shows its quote alone; an expired or unknown contract shows only that, and takes no feed
// slot (ruling 8).
import { type Href, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useStore } from 'zustand'
import { type DepthLevels, type Quote, quoteKey } from '~/core/realtime/protocol'
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
import type { TicketParams } from '~/market/types'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Change } from '~/ui/Change'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { Ladder } from '../components/Ladder'
import { CONFIRM_SETTLE_MS, depthDowngrades, ladderRows, levelTicket } from '../model'

const FIVE_ONLY = 'This broker sends 5 levels here.'
const NEEDS_LIVE = 'Deeper levels need the live feed'

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
  const feedLive = useConnection((c) => c.feed === 'live')
  const downgraded = useStore(depthDowngrades, (st) => st.keys)
  const choices = depthChoices({ broker, exchange, live: feedLive, downgraded })
  const [picked, setPicked] = useState<DepthLevels>(5)
  // A choice the feed can no longer bear (it went down, or was downgraded) falls back to 5.
  const levels = choices.includes(picked) ? picked : 5
  const depth = useLiveDepth(exchange, symbol, levels)
  // The header reads the depth subscription's own ticks: no second quote consumer (ruling 10).
  const q = useQuote(quoteKey(exchange, symbol), active)
  const dkey = broker === null ? null : downgradeKey(broker, exchange)
  useLevelCheck({ exchange, symbol, requested: levels, active, feedLive, q, dkey })

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
      </ScrollView>
      <View style={styles.footer}>
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
}) {
  const { realtime } = useServices()
  const { exchange, symbol, requested, feedLive, q, dkey } = p
  const checking = p.active && feedLive && requested > 5
  const [check, setCheck] = useState<{ since: number; requested: DepthLevels } | null>(null)
  const seen = useRef<{ last?: Quote; levels: number[] }>({ levels: [] })

  useEffect(() => {
    setCheck(null)
    if (!checking) return
    const t = setTimeout(() => {
      seen.current = { levels: [] }
      setCheck({ since: Date.now(), requested })
    }, CONFIRM_SETTLE_MS)
    return () => clearTimeout(t)
  }, [checking, requested])

  useEffect(() => {
    if (!checking || check === null || check.requested !== requested || dkey === null) return
    const s = seen.current
    if (q && q !== s.last) {
      s.last = q
      // Only the socket's own depth ticks since the subscribe count, never a poll or an empty book.
      if (q.source === 'ws' && q.depth && q.depth.levels > 0 && q.ts >= check.since) {
        s.levels.push(q.depth.levels)
      }
    }
    const { downgraded } = confirmLevels({
      requested,
      feedLive,
      wired: realtime.isLive(exchange, symbol),
      confirmedDepth: realtime.confirmedDepth(exchange, symbol),
      wsLevels: s.levels,
    })
    if (downgraded) depthDowngrades.getState().add(dkey)
  }, [checking, check, requested, dkey, q, feedLive, realtime, exchange, symbol])
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
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
})
