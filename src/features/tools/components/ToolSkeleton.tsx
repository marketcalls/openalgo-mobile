// What covers a tool page until it is ready (design 7.8): the shape of a tool screen on the
// theme's background, so opening one never flashes white or a spinner. Two control rows, a 2×2
// grid of figures, then the chart's block.
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { useTheme } from '~/ui/theme'

export function ToolSkeleton() {
  const { c } = useTheme()
  const { height } = useWindowDimensions()
  const block = { height: Math.min(500, 0.58 * height), backgroundColor: c.muted }
  return (
    <View
      testID="tool-skeleton"
      accessibilityLabel="Loading"
      style={[styles.wrap, { backgroundColor: c.background }]}
    >
      <View style={[styles.bar, { backgroundColor: c.muted }]} />
      <View style={[styles.bar, { backgroundColor: c.muted }]} />
      <View style={styles.grid}>
        {['a', 'b', 'c', 'd'].map((k) => (
          <View key={k} style={[styles.chip, { backgroundColor: c.muted }]} />
        ))}
      </View>
      <View style={[styles.block, block]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  bar: { height: 44, borderRadius: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexBasis: '47%', flexGrow: 1, height: 36, borderRadius: 6 },
  block: { borderRadius: 8 },
})
