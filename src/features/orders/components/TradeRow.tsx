// One tradebook row: the contract, the side in its colour, the quantity (in lots when the
// instrument is known), the average price, product, value and time. A field the row could not
// read shows `--`.
import { View } from 'react-native'
import type { TradeRow as Row } from '~/market/books/schemas'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { pxText, qtyText, rowStyles as styles, timeText } from './OrderRow'

export function TradeRow({ row: r, meta }: { row: Row; meta: InstrumentMeta | undefined }) {
  const { c, trade } = useTheme()
  return (
    <View
      testID={`trade-row-${r.orderid}`}
      style={[styles.wrap, styles.row, { borderBottomColor: c.border }]}
    >
      <View style={styles.line}>
        <Text style={styles.symbol} numberOfLines={1}>
          {r.symbol}
        </Text>
        <Text variant="caption" tone="muted">
          {r.exchange}
        </Text>
        <View style={styles.spacer} />
        <Text variant="caption" tone="muted">
          {timeText(r.timestamp)}
        </Text>
      </View>
      <View style={styles.line}>
        <Text
          variant="caption"
          style={[styles.side, { color: r.action === 'BUY' ? trade.buy : trade.sell }]}
        >
          {r.action}
        </Text>
        <Text variant="mono">{qtyText(r.quantity, meta)}</Text>
        <Text variant="mono">{`@ ${pxText(r.average_price, meta)}`}</Text>
        <Text variant="caption" tone="muted">
          {r.product || '--'}
        </Text>
        <View style={styles.spacer} />
        <Text variant="mono" tone="muted">
          {r.trade_value === undefined ? '--' : `₹${pxText(r.trade_value, undefined)}`}
        </Text>
      </View>
    </View>
  )
}
