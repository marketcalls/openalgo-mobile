// One position (design 7.11: dense, tabular numbers): the contract, product and net quantity,
// the average and live last price, and the P&L in profit or loss colour. Close (while open) and
// Chart sit under it.
import { StyleSheet, View } from 'react-native'
import type { LivePnl } from '~/market/books/livePnl'
import type { PositionRow as Row } from '~/market/books/schemas'
import { Button } from '~/ui/Button'
import { fmtPct, fmtPrice, fmtQty, fmtSigned, signOf } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

export const pnlTone = (n: number | undefined) =>
  signOf(n) > 0 ? 'profit' : signOf(n) < 0 ? 'loss' : 'default'

export function PositionRow(p: {
  row: Row
  live: LivePnl
  closeDisabled: boolean
  onClose: () => void
  onChart: () => void
}) {
  const { c } = useTheme()
  const { row: r, live } = p
  const id = `${r.exchange}-${r.symbol}-${r.product}`
  return (
    <View testID={`pos-row-${id}`} style={[styles.wrap, { borderBottomColor: c.border }]}>
      <View style={styles.line}>
        <Text style={styles.symbol} numberOfLines={1}>
          {r.symbol}
        </Text>
        <Text variant="caption" tone="muted">
          {`${r.exchange} · ${r.product}`}
        </Text>
        <View style={styles.spacer} />
        <Text variant="mono" tone={pnlTone(live.pnl)} testID={`pos-pnl-${id}`}>
          {fmtSigned(live.pnl)}
        </Text>
      </View>
      <View style={styles.line}>
        <Text variant="caption" tone="muted">
          Qty
        </Text>
        <Text variant="mono" testID={`pos-qty-${id}`}>
          {fmtQty(r.quantity)}
        </Text>
        <Text variant="caption" tone="muted">
          Avg
        </Text>
        <Text variant="mono">{fmtPrice(r.average_price)}</Text>
        <Text variant="caption" tone="muted">
          LTP
        </Text>
        <Text variant="mono" testID={`pos-ltp-${id}`}>
          {fmtPrice(live.ltp)}
        </Text>
        <View style={styles.spacer} />
        <Text variant="caption" tone={pnlTone(live.pnlPct)}>
          {fmtPct(live.pnlPct)}
        </Text>
      </View>
      <View style={styles.bar}>
        {r.quantity !== 0 ? (
          <View style={styles.slot}>
            <Button
              testID={`pos-close-${id}`}
              title="Close"
              variant="destructive"
              disabled={p.closeDisabled}
              onPress={p.onClose}
            />
          </View>
        ) : null}
        <View style={styles.slot}>
          <Button
            testID={`pos-chart-${id}`}
            title="Chart"
            variant="secondary"
            onPress={p.onChart}
          />
        </View>
      </View>
    </View>
  )
}

export const rowStyles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8, gap: 6 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  symbol: { fontWeight: '600', flexShrink: 1 },
  spacer: { flex: 1 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  slot: { flex: 1 },
})
const styles = rowStyles
