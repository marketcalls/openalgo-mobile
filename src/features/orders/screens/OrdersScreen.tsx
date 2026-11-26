// The Orders tab (design 7.6, 7.10, 17.3): Open (the default, working orders), All orders (newest
// first), Trades, and GTT while the server serves GTT for the broker in this mode, with the order
// book's statistics in the header (not on GTT, whose book they are not). A tap on an order opens
// its actions; Cancel all cancels every open order in the account. The books refresh on order
// events, after the app's own writes and from a poll while the tab is in front (the GTT book
// only on demand, design 12); while the broker is blocked they show what was last read, dimmed.
// The broker banner is the tabs layout's (ruling 9).
import { type Href, useLocalSearchParams, useRouter } from 'expo-router'
import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { GttList, useGttWrites } from '~/features/gtt'
import { type BookName, useBookPolling, useOrderbook, useTradebook } from '~/market/books/queries'
import {
  isWorking,
  type OrderRow as Order,
  type OrderStats,
  type TradeRow as Trade,
} from '~/market/books/schemas'
import { DroppedNote } from '~/market/components/DroppedNote'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { OutcomeLine } from '~/market/components/OutcomeLine'
import { SemiAutoBanner, SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import { StaleNote } from '~/market/components/StaleNote'
import { useGttSupport } from '~/market/gtt/queries'
import { chartHref, depthHref, modifyHref } from '~/market/links'
import { onOrder, useScopesOut } from '~/market/orders/pending'
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

type Segment = 'open' | 'all' | 'trades' | 'gtt'

const SEGMENTS: readonly { id: Segment; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'all', label: 'All orders' },
  { id: 'trades', label: 'Trades' },
  { id: 'gtt', label: 'GTT' },
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
  // A link may name the segment (`ordersHref`): the ticket's result opens All orders, where a
  // filled or rejected order shows, which Open would leave out.
  const param = useLocalSearchParams<{ segment?: string }>().segment
  useEffect(() => {
    const linked = SEGMENTS.find((x) => x.id === param)
    if (!linked) return
    setSegment(linked.id)
    setExpanded(null)
  }, [param])
  const book = useOrderbook()
  const writes = useOrderWrites()
  const gtt = useGttWrites()
  // GTT shows only while it is served for the broker in this mode; a link to it, or the segment
  // left on when that changes, shows Open meanwhile.
  const gttShown = useGttSupport().state === 'yes'
  const shown: Segment = segment === 'gtt' && !gttShown ? 'open' : segment
  // The notices of the shown segment's writes: one outcome line and one Semi-Auto banner (ruling 29).
  const notices = shown === 'gtt' ? gtt : writes
  useBookPolling(true, BOOKS)
  const open = book.data?.orders.filter(isWorking).length ?? 0
  // A write still out on an order (a modify or a cancel): cancel all waits for its outcome too.
  const anyOrderOut = [...useScopesOut(useTrading())].some((x) => x.startsWith('order:'))

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]} testID="orders-screen">
      {notices.liveSurprise !== null ? (
        <View style={styles.notice}>
          <LiveSurpriseNotice text={notices.liveSurprise} onDismiss={notices.dismissLiveSurprise} />
        </View>
      ) : null}
      {notices.semiBlocked !== null ? (
        <SemiAutoBlockedBanner message={notices.semiBlocked} />
      ) : (
        <SemiAutoBanner />
      )}
      {notices.outcome !== null ? (
        <OutcomeLine outcome={notices.outcome} onDismiss={notices.dismissOutcome} />
      ) : null}
      <View style={styles.segments}>
        {SEGMENTS.filter((s) => s.id !== 'gtt' || gttShown).map((s) => (
          <SegmentTab
            key={s.id}
            id={s.id}
            label={s.label}
            on={shown === s.id}
            onPress={() => {
              setSegment(s.id)
              setExpanded(null)
            }}
          />
        ))}
      </View>
      {shown === 'gtt' ? null : (
        <View style={styles.header}>
          <Text variant="caption" tone="muted" testID="orders-stats" style={styles.stats}>
            {statsText(book.data?.stats)}
          </Text>
          <Button
            testID="orders-cancel-all"
            title={`Cancel all (${open})`}
            variant="destructive"
            disabled={open === 0 || blocked || writes.busy || anyOrderOut}
            onPress={() => writes.cancelAll(open)}
          />
        </View>
      )}
      {shown === 'gtt' ? (
        <GttList writes={gtt} />
      ) : shown === 'trades' ? (
        <Trades />
      ) : (
        <Orders
          q={book}
          segment={shown}
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
  const trading = useTrading()
  const blocked = useBrokerBlocked()
  // A write still out on an order (a modify sheet's that went, or this tab's cancel) holds its
  // Modify and Cancel until its outcome is known, whichever screen sent it.
  const out = useScopesOut(trading)
  const { q, writes } = p
  const data = q.data
  const rows = useMemo(() => {
    const all = data?.orders ?? []
    return newestFirst(p.segment === 'open' ? all.filter(isWorking) : all, (r) => r.placedAt)
  }, [data, p.segment])
  const go = (href: string) => router.push(href as Href)

  const render = (r: Order) => {
    const meta = knownMeta(trading.instruments, r.exchange, r.symbol)
    const open = p.expanded === r.orderid
    const pending = out.has(onOrder(r.orderid))
    return (
      <OrderRow row={r} meta={meta} expanded={open} onPress={() => p.onToggle(r.orderid)}>
        {open ? (
          <OrderActions
            working={isWorking(r)}
            pending={pending}
            writesDisabled={blocked || writes.busy || pending}
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
      extra={`${p.expanded}|${blocked}|${writes.busy}|${[...out].join(',')}`}
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
  notice: { paddingHorizontal: 16, paddingTop: 8 },
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
