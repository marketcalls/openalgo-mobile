// The last write's outcome on a tab (Orders, Portfolio), kept as a line until it is dismissed or
// the next write starts: the toast goes after a few seconds, and a check after an unknown outcome
// can end long after the trader looked away. A screen reader hears it through the toast that
// goes with it. When the way on is the order book, the line links there.
import { Pressable, StyleSheet, View } from 'react-native'
import { type Tone, useToneColors } from '~/ui/Badge'
import { Text } from '~/ui/Text'

export type WriteOutcome = {
  text: string
  tone: Tone
  /** The way on is the order book (a close or a cancel whose outcome is not settled). */
  orderbook?: boolean
}

export function OutcomeLine({
  outcome,
  onDismiss,
  onViewOrderbook,
}: {
  outcome: WriteOutcome
  onDismiss: () => void
  /** Absent on the Orders tab itself. */
  onViewOrderbook?: () => void
}) {
  const { bg, fg } = useToneColors(outcome.tone)
  return (
    <View testID="write-outcome" style={[styles.box, { backgroundColor: bg }]}>
      <Text testID="write-outcome-text" style={[styles.text, { color: fg }]}>
        {outcome.text}
      </Text>
      <View style={styles.actions}>
        {outcome.orderbook && onViewOrderbook ? (
          <Pressable
            testID="write-outcome-orderbook"
            accessibilityRole="button"
            onPress={onViewOrderbook}
            hitSlop={8}
          >
            <Text style={[styles.action, { color: fg }]}>View order book</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="write-outcome-dismiss"
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          hitSlop={8}
        >
          <Text style={[styles.action, { color: fg }]}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { gap: 8, marginHorizontal: 16, marginTop: 8, padding: 12, borderRadius: 8 },
  text: {},
  actions: { flexDirection: 'row', gap: 20 },
  action: { fontWeight: '700', textDecorationLine: 'underline' },
})
