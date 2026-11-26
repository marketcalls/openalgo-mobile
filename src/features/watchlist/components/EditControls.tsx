// Edit mode's controls for one row: move it up or down, or remove it.
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

export function EditControls(p: {
  /** `EX-SYM`, the row's testID suffix. */
  id: string
  symbol: string
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  return (
    <View style={styles.row}>
      <Control
        testID={`wl-up-${p.id}`}
        glyph="↑"
        label={`Move ${p.symbol} up`}
        disabled={p.first}
        onPress={p.onUp}
      />
      <Control
        testID={`wl-down-${p.id}`}
        glyph="↓"
        label={`Move ${p.symbol} down`}
        disabled={p.last}
        onPress={p.onDown}
      />
      <Control
        testID={`wl-remove-${p.id}`}
        glyph="✕"
        label={`Remove ${p.symbol}`}
        danger
        onPress={p.onRemove}
      />
    </View>
  )
}

function Control(p: {
  testID: string
  glyph: string
  label: string
  disabled?: boolean
  danger?: boolean
  onPress: () => void
}) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: p.disabled === true }}
      disabled={p.disabled}
      onPress={p.onPress}
      style={[styles.control, p.disabled && styles.off]}
    >
      <Text style={[styles.glyph, { color: p.danger ? c.destructive : c.foreground }]}>
        {p.glyph}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 18, fontWeight: '600' },
  off: { opacity: 0.3 },
})
