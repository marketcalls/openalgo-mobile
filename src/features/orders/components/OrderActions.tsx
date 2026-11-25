// An order row's actions, under the row once it is tapped: Modify and Cancel while the order is
// working (open, pending or trigger pending), and Depth and Chart for its contract.
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button } from '~/ui/Button'
import { Text } from '~/ui/Text'
import { ROW_OUT } from '../hooks/useOrderWrites'

export function OrderActions(p: {
  working: boolean
  /** A write on this order is still out, so its outcome is not known yet: the bar says so. */
  pending: boolean
  /** Blocked, or a write on this order or from the tab is out: Modify and Cancel wait. */
  writesDisabled: boolean
  onModify: () => void
  onCancel: () => void
  onDepth: () => void
  onChart: () => void
}) {
  return (
    <View style={styles.wrap}>
      {p.working && p.pending ? (
        <Text testID="order-pending" variant="caption" tone="muted" style={styles.note}>
          {ROW_OUT}
        </Text>
      ) : null}
      <View style={styles.bar}>
        {p.working ? (
          <>
            <Slot>
              <Button
                testID="order-modify"
                title="Modify"
                variant="secondary"
                disabled={p.writesDisabled}
                onPress={p.onModify}
              />
            </Slot>
            <Slot>
              <Button
                testID="order-cancel"
                title="Cancel"
                variant="destructive"
                disabled={p.writesDisabled}
                onPress={p.onCancel}
              />
            </Slot>
          </>
        ) : null}
        <Slot>
          <Button testID="order-depth" title="Depth" variant="secondary" onPress={p.onDepth} />
        </Slot>
        <Slot>
          <Button testID="order-chart" title="Chart" variant="secondary" onPress={p.onChart} />
        </Slot>
      </View>
    </View>
  )
}

const Slot = ({ children }: { children: ReactNode }) => <View style={styles.slot}>{children}</View>

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  note: { paddingHorizontal: 16 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  slot: { flex: 1 },
})
