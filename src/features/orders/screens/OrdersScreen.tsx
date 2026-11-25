// The Orders tab (design 7.6, 7.10): Open (the default, working orders), All orders (newest first)
// and Trades, with the order book's statistics in the header. A tap on an order opens its actions;
// Cancel all cancels every open order in the account. The books refresh on order events, after the
// app's own writes and from a poll while the tab is in front; while the broker is blocked they
// show what was last read, dimmed. The broker banner is the tabs layout's (ruling 9).
import { type Href, useRouter } from 'expo-router'
import { type ReactElement, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { type BookName, useBookPolling, useOrderbook, useTradebook } from '~/market/books/queries'
import {
  isWorking,
  type OrderRow as Order,
  type OrderStats,
  type TradeRow as Trade,
} from '~/market/books/schemas'
import { DroppedNote } from '~/market/components/DroppedNote'
import { SemiAutoBanner, SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import { StaleNote } from '~/market/components/StaleNote'
import { chartHref, depthHref, modifyHref } from '~/market/links'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { OrderActions } from '../components/OrderActions'
import { knownMeta, OrderRow, orderSummary, timeText } from '../components/OrderRow'
import { TradeRow } from '../components/TradeRow'
import { NOT_READ, useOrderWrites } from '../hooks/useOrderWrites'

type Segment = 'open' | 'all' | 'trades'

const SEGMENTS: readonly { id: Segment; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'all', label: 'All orders' },
  { id: 'trades', label: 'Trades' },
]

/** The tab's own books, which its poll refreshes (ruling 11). */
const BOOKS: readonly BookName[] = ['orderbook', 'tradebook']

const count = (n: number | undefined) => (n === undefined ? '--' : fmtQty(n))

function statsText(s: OrderStats | undefined): string {
  return [
    `Open ${count(s?.total_open_orders)}`,
    `Completed ${count(s?.total_completed_orders)}`,
    `Rejected ${count(s?.total_rejected_orders)}`,
    `Buy ${count(s?.total_buy_orders)}`,
    `Sell ${count(s?.total_sell_orders)}`,
  ].join(' · ')
}

/** Newest first by `key`; rows that tie, or have none (last), keep the book's order. */
function newestFirst<T, K extends number | string>(
  rows: readonly T[],
  key: (r: T) => K | null,
): T[] {
  return rows
    .map((r, i) => ({ r, i, k: key(r) }))
    .sort((a, b) => {
      if (a.k === b.k) return a.i - b.i
      if (a.k === null) return 1
      if (b.k === null) return -1
      return a.k < b.k ? 1 : -1
    })
    .map((x) => x.r)
}

/** A trade's `HH:MM:SS`, which orders the day's trades; null when it has none. */
const tradeTime = (t: Trade) => {
  const s = timeText(t.timestamp)
  return s === '--' ? null : s
}

export function OrdersScreen() {
  const { c } = useTheme()
  const blocked = useBrokerBlocked()
  const [segment, setSegment] = useState<Segment>('open')
  const [expanded, setExpanded] = useState<string | null>(null)
  const book = useOrderbook()
  const writes = useOrderWrites()
  useBookPolling(true, BOOKS)
  const open = book.data?.orders.filter(isWorking).length ?? 0

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]} testID="orders-screen">
      {writes.semiBlocked !== null ? (
        <SemiAutoBlockedBanner message={writes.semiBlocked} />
      ) : (
        <SemiAutoBanner />
      )}
      <View style={styles.segments}>
        {SEGMENTS.map((s) => (
          <SegmentTab
            key={s.id}
            id={s.id}
            label={s.label}
            on={segment === s.id}
            onPress={() => {
              setSegment(s.id)
              setExpanded(null)
            }}
          />
        ))}
      </View>
      <View style={styles.header}>
        <Text variant="caption" tone="muted" testID="orders-stats" style={styles.stats}>
          {statsText(book.data?.stats)}
        </Text>
        <Button
          testID="orders-cancel-all"
          title={`Cancel all (${open})`}
          variant="destructive"
          disabled={open === 0 || blocked || writes.busy}
          onPress={() => writes.cancelAll(open)}
        />
      </View>
      {segment === 'trades' ? (
        <Trades />
      ) : (
        <Orders
          q={book}
          segment={segment}
          expanded={expanded}
          onToggle={(id) => setExpanded((e) => (e === id ? null : id))}
          writes={writes}
        />
      )}
    </View>
  )
}

function SegmentTab(p: { id: Segment; label: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={`orders-seg-${p.id}`}
      accessibilityRole="tab"
      accessibilityState={{ selected: p.on }}
      onPress={p.onPress}
      style={[styles.segment, { borderBottomColor: p.on ? c.primary : 'transparent' }]}
    >
      <Text tone={p.on ? 'default' : 'muted'} style={{ fontWeight: p.on ? '700' : '400' }}>
        {p.label}
      </Text>
    </Pressable>
  )
}

function Orders(p: {
  q: ReturnType<typeof useOrderbook>
  segment: 'open' | 'all'
  expanded: string | null
  onToggle: (orderid: string) => void
  writes: ReturnType<typeof useOrderWrites>
}) {
  const router = useRouter()
  const { instruments } = useTrading()
  const blocked = useBrokerBlocked()
  const { q, writes } = p
  const data = q.data
  const rows = useMemo(() => {
    const all = data?.orders ?? []
    return newestFirst(p.segment === 'open' ? all.filter(isWorking) : all, (r) => r.placedAt)
  }, [data, p.segment])
  const go = (href: string) => router.push(href as Href)

  const render = (r: Order) => {
    const meta = knownMeta(instruments, r.exchange, r.symbol)
    const open = p.expanded === r.orderid
    return (
      <OrderRow row={r} meta={meta} expanded={open} onPress={() => p.onToggle(r.orderid)}>
        {open ? (
          <OrderActions
            working={isWorking(r)}
            writesDisabled={blocked || writes.busy}
            onModify={() => go(modifyHref(r.orderid))}
            onCancel={() => writes.cancel(r, orderSummary(r, meta))}
            onDepth={() => go(depthHref(r.exchange, r.symbol))}
            onChart={() => go(chartHref(r.exchange, r.symbol))}
          />
        ) : null}
      </OrderRow>
    )
  }

  return (
    <BookView
      q={q}
      dropped={data?.dropped ?? 0}
      rows={rows}
      empty={p.segment === 'open' ? 'No open orders' : 'No orders today'}
      keyOf={(r) => r.orderid}
      render={render}
      extra={`${p.expanded}|${blocked}|${writes.busy}`}
    />
  )
}

function Trades() {
  const { instruments } = useTrading()
  const q = useTradebook()
  const data = q.data
  const rows = useMemo(() => newestFirst(data?.rows ?? [], tradeTime), [data])
  return (
    <BookView
      q={q}
      dropped={data?.dropped ?? 0}
      rows={rows}
      empty="No trades today"
      keyOf={(r, i) => `${r.orderid}-${i}`}
      render={(r) => <TradeRow row={r} meta={knownMeta(instruments, r.exchange, r.symbol)} />}
    />
  )
}

type BookQuery = {
  data: unknown
  error: unknown
  isError: boolean
  isRefetchError: boolean
  dataUpdatedAt: number
  refetch: () => Promise<unknown>
}

/**
 * A book's rows, or why there are none. Once read, a book still shows while it cannot refresh
 * (blocked, or the last refetch failed), dimmed under "Last updated".
 */
function BookView<T>(p: {
  q: BookQuery
  dropped: number
  rows: readonly T[]
  empty: string
  keyOf: (row: T, index: number) => string
  render: (row: T) => ReactElement
  extra?: string
}) {
  const blocked = useBrokerBlocked()
  const { q } = p
  if (q.data === undefined) {
    if (blocked) return <EmptyState title={NOT_READ} />
    if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    return <Skeleton />
  }
  const stale = blocked || q.isRefetchError
  return (
    <View style={styles.fill}>
      <DroppedNote dropped={p.dropped} />
      {stale ? <StaleNote at={q.dataUpdatedAt} /> : null}
      <View testID="orders-list" style={[styles.fill, { opacity: stale ? 0.5 : 1 }]}>
        {p.rows.length === 0 ? (
          <EmptyState title={p.empty} />
        ) : (
          <FlatList
            data={p.rows}
            extraData={p.extra}
            keyExtractor={p.keyOf}
            renderItem={({ item }) => p.render(item)}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  segments: { flexDirection: 'row', paddingHorizontal: 8 },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  stats: { flex: 1 },
})
