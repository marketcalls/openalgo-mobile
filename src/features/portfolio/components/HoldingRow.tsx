// One holding: the contract, quantity, the average (when the book gave it), live last price and
// P&L. Sell opens the ticket on a CNC market sell of the whole quantity; Chart opens the chart.
import { View } from 'react-native'
import type { LivePnl } from '~/market/books/livePnl'
import type { HoldingRow as Row } from '~/market/books/schemas'
import { Button } from '~/ui/Button'
import { fmtPct, fmtPrice, fmtQty, fmtSigned } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { pnlTone, rowStyles as styles } from './PositionRow'

export function HoldingRow(p: {
  row: Row
  live: LivePnl
  sellDisabled: boolean
  onSell: () => void
  onChart: () => void
}) {
  const { c } = useTheme()
  const { row: r, live } = p
  const id = `${r.exchange}-${r.symbol}`
  return (
    <View testID={`hold-row-${id}`} style={[styles.wrap, { borderBottomColor: c.border }]}>
      <View style={styles.line}>
        <Text style={styles.symbol} numberOfLines={1}>
          {r.symbol}
        </Text>
        <Text variant="caption" tone="muted">
          {r.exchange}
        </Text>
        <View style={styles.spacer} />
        <Text variant="mono" tone={pnlTone(live.pnl)} testID={`hold-pnl-${id}`}>
          {fmtSigned(live.pnl)}
        </Text>
      </View>
      <View style={styles.line}>
        <Text variant="caption" tone="muted">
          Qty
        </Text>
        <Text variant="mono" testID={`hold-qty-${id}`}>
          {fmtQty(r.quantity)}
        </Text>
        {r.average_price !== undefined ? (
          <>
            <Text variant="caption" tone="muted">
              Avg
            </Text>
            <Text variant="mono" testID={`hold-avg-${id}`}>
              {fmtPrice(r.average_price)}
            </Text>
          </>
        ) : null}
        <Text variant="caption" tone="muted">
          LTP
        </Text>
        <Text variant="mono" testID={`hold-ltp-${id}`}>
          {fmtPrice(live.ltp)}
        </Text>
        <View style={styles.spacer} />
        <Text variant="caption" tone={pnlTone(live.pnlPct)} testID={`hold-pct-${id}`}>
          {fmtPct(live.pnlPct)}
        </Text>
      </View>
      <View style={styles.bar}>
        <View style={styles.slot}>
          <Button
            testID={`hold-sell-${id}`}
            title="Sell"
            variant="sell"
            disabled={p.sellDisabled}
            onPress={p.onSell}
          />
        </View>
        <View style={styles.slot}>
          <Button
            testID={`hold-chart-${id}`}
            title="Chart"
            variant="secondary"
            onPress={p.onChart}
          />
        </View>
      </View>
    </View>
  )
}
