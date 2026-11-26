// Edit mode's controls for one row: move it up or down within its group, move it to another
// group, or remove it. `EditButton` is the 44 pt control the group headers and the list sheet use too.
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import { Icon, type IconName } from '~/ui/Icon'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const REGROUP: IconName = { ios: 'folder', android: 'drive_file_move' }

export function EditControls(p: {
  /** `EX-SYM`, the row's testID suffix. */
  id: string
  symbol: string
  first: boolean
  last: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  /** Offers to move the row to a group; absent while the list has no group. */
  onRegroup?: () => void
}) {
  return (
    <View style={styles.row}>
      <EditButton
        testID={`wl-up-${p.id}`}
        glyph="↑"
        label={`Move ${p.symbol} up`}
        disabled={p.first}
        onPress={p.onUp}
      />
      <EditButton
        testID={`wl-down-${p.id}`}
        glyph="↓"
        label={`Move ${p.symbol} down`}
        disabled={p.last}
        onPress={p.onDown}
      />
      {p.onRegroup ? (
        <EditButton
          testID={`wl-regroup-${p.id}`}
          icon={REGROUP}
          label={`Move ${p.symbol} to a group`}
          onPress={p.onRegroup}
        />
      ) : null}
      <EditButton
        testID={`wl-remove-${p.id}`}
        glyph="✕"
        label={`Remove ${p.symbol}`}
        danger
        onPress={p.onRemove}
      />
    </View>
  )
}

/** A square control showing a glyph or an icon, labelled for screen readers. */
export function EditButton(p: {
  testID: string
  label: string
  glyph?: string
  icon?: IconName
  disabled?: boolean
  danger?: boolean
  style?: ViewStyle
  onPress: () => void
}) {
  const { c } = useTheme()
  const color = p.danger ? c.destructive : c.foreground
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: p.disabled === true }}
      disabled={p.disabled}
      onPress={p.onPress}
      style={[styles.control, p.style, p.disabled && styles.off]}
    >
      {p.icon ? (
        <Icon name={p.icon} size={18} color={color} />
      ) : (
        <Text style={[styles.glyph, { color }]}>{p.glyph}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 18, fontWeight: '600' },
  off: { opacity: 0.3 },
})
