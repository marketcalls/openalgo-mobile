// An order row's actions, under the row once it is tapped: Modify and Cancel while the order is
// working (open, pending or trigger pending), and Depth and Chart for its contract.
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button } from '~/ui/Button'

export function OrderActions(p: {
  working: boolean
  /** The broker is blocked, or another write is in flight: Modify and Cancel wait. */
  writesDisabled: boolean
  onModify: () => void
  onCancel: () => void
  onDepth: () => void
  onChart: () => void
}) {
  return (
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
  )
}

const Slot = ({ children }: { children: ReactNode }) => <View style={styles.slot}>{children}</View>

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  slot: { flex: 1 },
})
