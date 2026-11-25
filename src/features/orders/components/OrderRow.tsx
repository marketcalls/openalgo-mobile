// One order-book row (design 7.11: dense, tabular numbers): the contract, the side in its colour,
// the quantity (in lots when the instrument is known), type, price or trigger, product, status and
// time. A field the row could not read shows `--` (Review Focus 4). A tap opens its actions.
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { isWorking, type OrderRow as Row } from '~/market/books/schemas'
import type { InstrumentCache } from '~/market/instruments/cache'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { fmtTick } from '~/market/instruments/tick'
import { Badge, type Tone } from '~/ui/Badge'
import { fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

/** What today's metadata cache knows of the contract; it never asks the server for a row. */
export function knownMeta(
  instruments: Pick<InstrumentCache, 'peek'>,
  exchange: string,
  symbol: string,
): InstrumentMeta | undefined {
  const m = instruments.peek(exchange, symbol)
  return m === undefined || m === 'unknown' ? undefined : m
}

/** "2L (130)" for whole lots of a contract known to trade in lots, else the units. */
export function qtyText(qty: number, meta: InstrumentMeta | undefined): string {
  const lots = meta?.lots ? qty / meta.lotsize : Number.NaN
  return Number.isInteger(lots) ? `${fmtQty(lots)}L (${fmtQty(qty)})` : fmtQty(qty)
}

/** A price at the instrument's tick (two decimals when unknown); `--` when the row had none. */
export const pxText = (n: number | undefined, meta: InstrumentMeta | undefined) =>
  n === undefined ? '--' : fmtTick(n, meta?.tick, n)

/** C9: SL-M carries only the trigger, SL the price and the trigger, the rest the price. */
export function orderPriceText(r: Row, meta: InstrumentMeta | undefined): string {
  if (r.pricetype === 'SL-M') return `trg ${pxText(r.trigger_price, meta)}`
  if (r.pricetype === 'SL') return `${pxText(r.price, meta)} / trg ${pxText(r.trigger_price, meta)}`
  return pxText(r.price, meta)
}

/** The ticket's one-line form (C9 Summary): `BUY LIMIT 1 YESBANK @ 16.50 · MIS`. */
export function orderSummary(r: Row, meta: InstrumentMeta | undefined): string {
  const px = (n: number | undefined) => pxText(n, meta)
  const at =
    r.pricetype === 'LIMIT'
      ? ` @ ${px(r.price)}`
      : r.pricetype === 'SL'
        ? ` @ ${px(r.price)} trigger ${px(r.trigger_price)}`
        : r.pricetype === 'SL-M'
          ? ` @ ${px(r.trigger_price)}`
          : ''
  return `${r.action} ${r.pricetype || '--'} ${qtyText(r.quantity, meta)} ${r.symbol}${at} · ${r.product || '--'}`
}

/** `HH:MM:SS` from any of the books' timestamp forms; `--` when it holds no time. */
export function timeText(ts: string): string {
  const m = /(\d{1,2}):(\d{2}):(\d{2})/.exec(ts)
  return m ? `${(m[1] ?? '').padStart(2, '0')}:${m[2]}:${m[3]}` : '--'
}

const statusLabel = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : '--')

const statusTone = (r: Row): Tone =>
  isWorking(r) ? 'warning' : r.status === 'rejected' ? 'danger' : 'neutral'

export function OrderRow(p: {
  row: Row
  meta: InstrumentMeta | undefined
  expanded: boolean
  onPress: () => void
  /** The actions, under the row while it is expanded. */
  children?: ReactNode
}) {
  const { row: r, meta } = p
  const { c, trade } = useTheme()
  const id = r.orderid
  return (
    <View style={[styles.wrap, { borderBottomColor: c.border }]}>
      <Pressable
        testID={`order-row-${id}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: p.expanded }}
        onPress={p.onPress}
        style={styles.row}
      >
        <View style={styles.line}>
          <Text style={styles.symbol} numberOfLines={1}>
            {r.symbol}
          </Text>
          <Text variant="caption" tone="muted">
            {r.exchange}
          </Text>
          <View style={styles.spacer} />
          <Badge testID={`order-status-${id}`} label={statusLabel(r.status)} tone={statusTone(r)} />
        </View>
        <View style={styles.line}>
          <Text
            testID={`order-side-${id}`}
            variant="caption"
            style={[styles.side, { color: r.action === 'BUY' ? trade.buy : trade.sell }]}
          >
            {r.action}
          </Text>
          <Text variant="mono" testID={`order-qty-${id}`}>
            {qtyText(r.quantity, meta)}
          </Text>
          <Text variant="caption" tone="muted">
            {r.pricetype || '--'}
          </Text>
          <Text variant="mono" testID={`order-price-${id}`}>
            {orderPriceText(r, meta)}
          </Text>
          <Text variant="caption" tone="muted">
            {r.product || '--'}
          </Text>
          <View style={styles.spacer} />
          <Text variant="caption" tone="muted" testID={`order-time-${id}`}>
            {timeText(r.timestamp)}
          </Text>
        </View>
      </Pressable>
      {p.children}
    </View>
  )
}

export const rowStyles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { fontWeight: '600', flexShrink: 1 },
  side: { fontWeight: '700' },
  spacer: { flex: 1 },
})

const styles = rowStyles
