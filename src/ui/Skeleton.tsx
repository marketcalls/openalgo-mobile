import { StyleSheet, View } from 'react-native'
import { useTheme } from './theme'

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { c } = useTheme()
  return (
    <View testID="skeleton" accessibilityLabel="Loading" style={styles.wrap}>
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <View key={key} style={[styles.row, { backgroundColor: c.muted }]} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 12, padding: 16 },
  row: { height: 44, borderRadius: 8 },
})
