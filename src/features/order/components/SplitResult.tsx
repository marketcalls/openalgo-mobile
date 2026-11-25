// A split order's result (design 7.10): each child order the server made, in its own row, and
// how many went through. A failed child is reported, never sent again from here.
import { StyleSheet, View } from 'react-native'
import type { SplitReply } from '~/market/orders/schemas'
import { Badge } from '~/ui/Badge'
import { fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'

export type SplitPlaced = Extract<SplitReply, { kind: 'split' }>

export function SplitResult({ reply }: { reply: SplitPlaced }) {
  const placed = reply.children.filter((c) => c.ok).length
  return (
    <View style={styles.wrap}>
      <Text variant="heading" testID="split-summary">
        {`${placed} of ${reply.children.length} placed`}
      </Text>
      {reply.children.map((c) => (
        <View key={c.n} testID={`split-child-${c.n}`} style={styles.row}>
          <Text variant="mono" style={styles.num}>{`#${c.n}`}</Text>
          <Text variant="mono" style={styles.qty}>
            {fmtQty(c.qty)}
          </Text>
          <View style={styles.status}>
            <Badge label={c.ok ? 'Placed' : 'Failed'} tone={c.ok ? 'neutral' : 'danger'} />
            {c.ok ? (
              c.orderid ? (
                <Text variant="caption" tone="muted">
                  {c.orderid}
                </Text>
              ) : null
            ) : (
              <Text variant="caption" tone="loss">
                {c.message ?? 'Not placed'}
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  num: { width: 36 },
  qty: { width: 72, textAlign: 'right' },
  status: { flex: 1, minWidth: 0, gap: 2, alignItems: 'flex-start' },
})
