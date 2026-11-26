import { Pressable, StyleSheet, View } from 'react-native'
import type { Instrument } from '~/core/http/schemas'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import { Badge } from '~/ui/Badge'
import { Icon, type IconName } from '~/ui/Icon'
import { ListRow } from '~/ui/ListRow'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const OPEN: IconName = { ios: 'chevron.right', android: 'chevron_right' }

/** The line under the symbol: name, exchange, then expiry and strike when it is a contract. */
export function describe(row: Instrument): string {
  const parts: string[] = []
  if (row.name) parts.push(row.name)
  parts.push(row.exchange)
  if (row.expiry) parts.push(row.expiry)
  if (row.strike != null && row.strike > 0) parts.push(String(row.strike))
  return parts.join(' · ')
}

export function ResultRow({
  row,
  added,
  onPress,
  onOpen,
}: {
  row: Instrument
  /** Add mode: the symbol is already in the list. */
  added?: boolean
  onPress: () => void
  /** Add mode: a trailing button opens the instrument sheet instead of adding. */
  onOpen?: () => void
}) {
  const { c } = useTheme()
  const id = `${row.exchange}-${row.symbol}`
  return (
    <ListRow
      testID={`search-row-${id}`}
      title={row.symbol}
      subtitle={describe(row)}
      onPress={onPress}
      right={
        <View style={styles.right}>
          {isQuoteOnly(row.exchange) ? <Badge label="Quote only" tone="neutral" /> : null}
          {added ? (
            <Text testID={`search-added-${id}`} accessibilityLabel="In this list">
              ✓
            </Text>
          ) : null}
          {onOpen ? (
            <Pressable
              testID={`search-open-${id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${row.symbol}`}
              onPress={onOpen}
              hitSlop={8}
              style={styles.open}
            >
              <Icon name={OPEN} size={16} color={c.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      }
    />
  )
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  open: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
})
