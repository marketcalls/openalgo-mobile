// The Portfolio tab (design 7.6, 7.10): Positions (live P&L from the tick store, Close one and
// Close all), Holdings (statistics, live P&L, Sell and Chart) and Funds. The books refresh on
// order events, after the app's own writes and from a poll while the tab is in front; in polling
// mode (no live feed) positions are read every `POLL_RATES.positions`. While the broker is blocked
// they show what was last read, dimmed. The broker banner is the tabs layout's (ruling 9).
import { type Href, useRouter } from 'expo-router'
import { type ReactElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'
import { qk } from '~/core/query/keys'
import { POLL_RATES } from '~/core/realtime/polling'
import { quoteKey } from '~/core/realtime/protocol'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import { liveHoldingPnl, livePositionPnl, totals } from '~/market/books/livePnl'
import { type BookName, useBookPolling, useHoldings, usePositionbook } from '~/market/books/queries'
import type {
  HoldingRow as Holding,
  HoldingStats,
  PositionRow as Position,
} from '~/market/books/schemas'
import { useLiveLtps } from '~/market/books/useLiveLtps'
import { DroppedNote } from '~/market/components/DroppedNote'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { OutcomeLine } from '~/market/components/OutcomeLine'
import { SemiAutoBanner, SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import { StaleNote } from '~/market/components/StaleNote'
import { chartHref, ordersHref, ticketHref } from '~/market/links'
import { ALL_POSITIONS, isPositionScope, onPosition, useScopesOut } from '~/market/orders/pending'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { fmtPct, fmtPrice, fmtSigned } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { FundsView } from '../components/FundsView'
import { HoldingRow } from '../components/HoldingRow'
import { PositionRow, pnlTone } from '../components/PositionRow'
import { NOT_READ, usePositionWrites } from '../hooks/usePositionWrites'

type Segment = 'positions' | 'holdings' | 'funds'

const SEGMENTS: readonly { id: Segment; label: string }[] = [
  { id: 'positions', label: 'Positions' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'funds', label: 'Funds' },
]

/** The tab's own books, which its poll refreshes (ruling 11); funds poll on their own. */
const BOOKS: readonly BookName[] = ['positionbook', 'holdings']

/** In polling mode (no live feed) positions are read at `POLL_RATES.positions` (design 7.6). */
function usePositionsPoll(on: boolean) {
  const s = useServices()
  const pid = s.profile.get().id
  const feedLive = useSyncExternalStore(
    s.realtime.onStatus,
    () => s.realtime.status().state === 'live',
  )
  const poll = on && !feedLive
  useEffect(() => {
    if (!poll) return
    return s.polling.register(
      {
        kind: 'custom',
        intervalMs: () => POLL_RATES.positions,
        run: async () => {
          await s.queryClient.invalidateQueries({ queryKey: qk.positionbook(pid) })
        },
      },
      true,
    )
  }, [poll, s, pid])
}

const rowKey = (r: { exchange: string; symbol: string }) => quoteKey(r.exchange, r.symbol)

export function PortfolioScreen() {
  const { c } = useTheme()
  const blocked = useBrokerBlocked()
  const screenActive = useScreenActive()
  const trading = useTrading()
  const router = useRouter()
  const [segment, setSegment] = useState<Segment>('positions')
  const positions = usePositionbook()
  const holdings = useHoldings()
  const writes = usePositionWrites()
  // A close still out (its check included) holds its position's Close, and close all every one,
  // whichever screen sent it: a second close would be sized from the unclosed position.
  const out = useScopesOut(trading)
  const anyCloseOut = [...out].some(isPositionScope)
  const go = (href: string) => router.push(href as Href)
  useBookPolling(segment !== 'funds', BOOKS)
  usePositionsPoll(segment === 'positions' && screenActive && !blocked)

  // Open positions (or the holdings) whose contract the server knows: the keys the feed carries.
  const keys = useMemo(() => {
    const rows: readonly (Position | Holding)[] =
      (segment === 'positions'
        ? positions.data?.rows.filter((r) => r.quantity !== 0)
        : segment === 'holdings'
          ? holdings.data?.rows
          : undefined) ?? []
    return [
      ...new Set(
        rows
          .filter((r) => trading.instruments.peek(r.exchange, r.symbol) !== 'unknown')
          .map(rowKey),
      ),
    ]
  }, [segment, positions.data, holdings.data, trading.instruments])
  const ltps = useLiveLtps(keys, segment !== 'funds' && !blocked)

  const posLive = useMemo(
    () =>
      (positions.data?.rows ?? []).map((row) => ({
        row,
        live: livePositionPnl(row, row.quantity === 0 ? undefined : ltps[rowKey(row)]),
      })),
    [positions.data, ltps],
  )
  const holdLive = useMemo(
    () =>
      (holdings.data?.rows ?? []).map((row) => ({
        row,
        live: liveHoldingPnl(row, ltps[rowKey(row)]),
      })),
    [holdings.data, ltps],
  )
  const open = posLive.filter((p) => p.row.quantity !== 0).length
  const totalPnl = totals(posLive.map((p) => p.live))

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]} testID="portfolio-screen">
      {writes.liveSurprise !== null ? (
        <View style={styles.notice}>
          <LiveSurpriseNotice text={writes.liveSurprise} onDismiss={writes.dismissLiveSurprise} />
        </View>
      ) : null}
      {writes.semiBlocked !== null ? (
        <SemiAutoBlockedBanner message={writes.semiBlocked} />
      ) : (
        <SemiAutoBanner />
      )}
      {writes.outcome !== null ? (
        <OutcomeLine
          outcome={writes.outcome}
          onDismiss={writes.dismissOutcome}
          onViewOrderbook={() => go(ordersHref({ segment: 'all' }))}
        />
      ) : null}
      <View style={styles.segments}>
        {SEGMENTS.map((s) => (
          <Pressable
            key={s.id}
            testID={`pf-seg-${s.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === s.id }}
            onPress={() => setSegment(s.id)}
            style={[
              styles.segment,
              { borderBottomColor: segment === s.id ? c.primary : 'transparent' },
            ]}
          >
            <Text
              tone={segment === s.id ? 'default' : 'muted'}
              style={{ fontWeight: segment === s.id ? '700' : '400' }}
            >
              {s.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {segment === 'positions' ? (
        <>
          <View style={styles.header}>
            <View style={styles.stats}>
              <Text variant="caption" tone="muted">
                Total P&L
              </Text>
              <Text variant="heading" tone={pnlTone(totalPnl)} testID="pf-total-pnl">
                {positions.data === undefined ? '--' : fmtSigned(totalPnl)}
              </Text>
            </View>
            <Button
              testID="pf-close-all"
              title={`Close all (${open})`}
              variant="destructive"
              disabled={open === 0 || blocked || writes.busy || anyCloseOut}
              onPress={() => writes.closeAll(open)}
            />
          </View>
          <BookView
            q={positions}
            dropped={positions.data?.dropped ?? 0}
            rows={posLive}
            empty="No positions today"
            keyOf={(p) => `${p.row.exchange}-${p.row.symbol}-${p.row.product}`}
            extra={`${blocked}|${writes.busy}|${[...out].join(',')}`}
            render={({ row, live }) => (
              <PositionRow
                row={row}
                live={live}
                closeDisabled={
                  blocked || writes.busy || out.has(onPosition(row)) || out.has(ALL_POSITIONS)
                }
                onClose={() => writes.closeOne(row)}
                onChart={() => go(chartHref(row.exchange, row.symbol))}
              />
            )}
          />
        </>
      ) : segment === 'holdings' ? (
        <>
          <HoldStats stats={holdings.data?.stats} live={holdLive} />
          <BookView
            q={holdings}
            dropped={holdings.data?.dropped ?? 0}
            rows={holdLive}
            empty="No holdings"
            keyOf={(h) => `${h.row.exchange}-${h.row.symbol}`}
            extra={`${blocked}`}
            render={({ row, live }) => (
              <HoldingRow
                row={row}
                live={live}
                sellDisabled={blocked}
                onSell={() =>
                  go(
                    ticketHref({
                      exchange: row.exchange,
                      symbol: row.symbol,
                      action: 'SELL',
                      product: 'CNC',
                      pricetype: 'MARKET',
                      quantity: row.quantity,
                    }),
                  )
                }
                onChart={() => go(chartHref(row.exchange, row.symbol))}
              />
            )}
          />
        </>
      ) : (
        <FundsView />
      )}
    </View>
  )
}

/**
 * Current value, investment, P&L and P&L %. The book's statistics stand until a live price
 * changes a row; then the P&L is the rows' sum, and the value is the investment plus it.
 */
function HoldStats(p: {
  stats: HoldingStats | undefined
  live: readonly { live: { pnl: number | undefined; live: boolean } }[]
}) {
  const s = p.stats
  const anyLive = p.live.some((h) => h.live.live)
  const invested = s?.totalinvvalue
  const pnl = anyLive ? totals(p.live.map((h) => h.live)) : s?.totalprofitandloss
  const value = anyLive && invested !== undefined ? invested + (pnl ?? 0) : s?.totalholdingvalue
  const pct =
    anyLive && invested !== undefined && invested !== 0
      ? ((pnl ?? 0) / invested) * 100
      : s?.totalpnlpercentage
  const cell = (label: string, id: string, text: string, tone?: 'profit' | 'loss' | 'default') => (
    <View style={styles.statCell}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" tone={tone} testID={id}>
        {text}
      </Text>
    </View>
  )
  return (
    <View testID="hold-stats" style={styles.holdStats}>
      {cell('Current value', 'hold-stat-value', fmtPrice(value))}
      {cell('Investment', 'hold-stat-invested', fmtPrice(invested))}
      {cell('P&L', 'hold-stat-pnl', fmtSigned(pnl), pnlTone(pnl))}
      {cell('P&L %', 'hold-stat-pct', fmtPct(pct), pnlTone(pct))}
    </View>
  )
}

type BookQuery = {
  data: unknown
  error: unknown
  isError: boolean
  isRefetchError: boolean
  isRefetching: boolean
  dataUpdatedAt: number
  refetch: () => Promise<unknown>
}

/**
 * A book's rows, or why there are none. Once read, a book still shows while it cannot refresh
 * (blocked, or the last refetch failed), dimmed under "Last updated". Pulling refreshes it.
 */
function BookView<T>(p: {
  q: BookQuery
  dropped: number
  rows: readonly T[]
  empty: string
  keyOf: (row: T) => string
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
      <View testID="portfolio-list" style={[styles.fill, { opacity: stale ? 0.5 : 1 }]}>
        {p.rows.length === 0 ? (
          <EmptyState title={p.empty} />
        ) : (
          <FlatList
            data={p.rows}
            extraData={p.extra}
            keyExtractor={p.keyOf}
            renderItem={({ item }) => p.render(item)}
            refreshing={q.isRefetching}
            onRefresh={() => void q.refetch()}
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
  holdStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  statCell: { minWidth: '40%' },
})
