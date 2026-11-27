// The chain's two list pickers (ux G12): every listed expiry, and the strike count. Each is a
// bottom sheet over the screen, 48 dp rows, the chosen row marked.
import { Pressable, StyleSheet, View } from 'react-native'
import { STRIKE_COUNTS } from '~/market/options/live'
import { BottomSheet } from '~/ui/BottomSheet'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { daysTo, expiryLabel } from '../model'

type Row = { key: string; testID: string; label: string; detail?: string; selected: boolean }

function PickList(p: {
  testID: string
  title: string
  rows: Row[]
  onPick(key: string): void
  onClose(): void
}) {
  const { c } = useTheme()
  return (
    <View style={StyleSheet.absoluteFill}>
      <BottomSheet
        testID={p.testID}
        onClose={p.onClose}
        header={
          <Text variant="heading" style={styles.title}>
            {p.title}
          </Text>
        }
      >
        {p.rows.map((r) => (
          <Pressable
            key={r.key}
            testID={r.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: r.selected }}
            onPress={() => p.onPick(r.key)}
            style={[
              styles.row,
              { borderBottomColor: c.border },
              r.selected && { backgroundColor: c.accent },
            ]}
          >
            <Text style={[styles.label, r.selected && styles.bold]}>{r.label}</Text>
            {r.detail ? (
              <Text tone="muted" style={styles.detail}>
                {r.detail}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </BottomSheet>
    </View>
  )
}

/** Every listed expiry, nearest first: `02 Dec 26`, then how many days it is away. */
export function ExpiryPicker(p: {
  expiries: readonly string[]
  selected: string | null
  nowMs: number
  onPick(expiry: string): void
  onClose(): void
}) {
  const rows = p.expiries.map((e, i) => {
    const days = daysTo(e, p.nowMs)
    return {
      key: e,
      testID: `oc-expiry-row-${i}`,
      label: expiryLabel(e, true),
      detail: days === 0 ? 'Today' : days === null ? undefined : `${days}d`,
      selected: e === p.selected,
    }
  })
  return (
    <PickList
      testID="oc-expiry-sheet"
      title="Expiry"
      rows={rows}
      onPick={p.onPick}
      onClose={p.onClose}
    />
  )
}

/** The strikes shown each side of ATM. */
export function CountPicker(p: { count: number; onPick(count: number): void; onClose(): void }) {
  const rows = STRIKE_COUNTS.map((n) => ({
    key: String(n),
    testID: `oc-count-${n}`,
    label: `±${n} strikes`,
    selected: n === p.count,
  }))
  return (
    <PickList
      testID="oc-count-sheet"
      title="Strikes each side"
      rows={rows}
      onPick={(k) => p.onPick(Number(k))}
      onClose={p.onClose}
    />
  )
}

const styles = StyleSheet.create({
  title: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    minHeight: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { flex: 1, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700' },
  detail: { fontSize: 13, fontVariant: ['tabular-nums'] },
})
