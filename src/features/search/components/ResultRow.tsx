import { StyleSheet, View } from 'react-native'
import type { Instrument } from '~/core/http/schemas'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import { Badge } from '~/ui/Badge'
import { ListRow } from '~/ui/ListRow'
import { Text } from '~/ui/Text'

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
}: {
  row: Instrument
  /** Add mode: the symbol is already in the list. */
  added?: boolean
  onPress: () => void
}) {
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
        </View>
      }
    />
  )
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
