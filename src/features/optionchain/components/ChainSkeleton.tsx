// What the ladder shows until its chain arrives (ux OC-7, G10): eleven rows in the ladder's own
// shape (two cells, the strike, two cells), so a first load or an expiry switch never flashes a
// spinner. The header above it stays usable.
import { StyleSheet, View } from 'react-native'
import { useTheme } from '~/ui/theme'
import { STRIKE_WIDTH } from './StrikeRow'

const ROWS = 11

export function ChainSkeleton({ height }: { height: number }) {
  const { c } = useTheme()
  const block = { backgroundColor: c.muted }
  return (
    <View testID="oc-skeleton" accessibilityLabel="Loading" style={styles.wrap}>
      {Array.from({ length: ROWS }, (_, i) => String(i)).map((n) => (
        <View
          key={n}
          testID={`oc-skeleton-row-${n}`}
          style={[styles.row, { height, borderBottomColor: c.border }]}
        >
          <View style={[styles.cell, block]} />
          <View style={[styles.cell, block]} />
          <View style={[styles.strike, block]} />
          <View style={[styles.cell, block]} />
          <View style={[styles.cell, block]} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cell: { flex: 1, height: 14, borderRadius: 4 },
  strike: { width: STRIKE_WIDTH - 16, height: 16, borderRadius: 4 },
})
