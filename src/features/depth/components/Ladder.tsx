// The depth ladder: bids on the left and asks on the right, best first. Each level shows its
// price, orders and quantity (Kite's order) over a bar of its share of the side; a tap opens a LIMIT ticket.
import { Pressable, StyleSheet, View } from 'react-native'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import type { LadderRow, LadderSide } from '../model'

type Props = {
  bids: LadderRow[]
  asks: LadderRow[]
  /** The broker is blocked: levels open nothing. */
  disabled: boolean
  onLevel: (side: LadderSide, price: number) => void
}

export function Ladder(p: Props) {
  const { c } = useTheme()
  const positions = Array.from({ length: Math.max(p.bids.length, p.asks.length) }, (_, i) => i)
  return (
    <View testID="depth-ladder">
      <View style={[styles.row, styles.head, { borderBottomColor: c.border }]}>
        <Columns first="Bid" />
        <Columns first="Offer" />
      </View>
      {positions.map((i) => (
        <View key={i} style={styles.row}>
          <Level side="bid" index={i} row={p.bids[i]} disabled={p.disabled} onLevel={p.onLevel} />
          <Level side="ask" index={i} row={p.asks[i]} disabled={p.disabled} onLevel={p.onLevel} />
        </View>
      ))}
    </View>
  )
}

function Columns({ first }: { first: string }) {
  return (
    <View style={styles.cell}>
      <Text variant="caption" tone="muted" style={styles.price}>
        {first}
      </Text>
      <Text variant="caption" tone="muted" style={styles.orders}>
        Orders
      </Text>
      <Text variant="caption" tone="muted" style={styles.qty}>
        Qty
      </Text>
    </View>
  )
}

function Level(p: {
  side: LadderSide
  index: number
  row: LadderRow | undefined
  disabled: boolean
  onLevel: (side: LadderSide, price: number) => void
}) {
  const { trade } = useTheme()
  const { row, side } = p
  if (!row) return <View style={styles.cell} />
  const colour = side === 'bid' ? trade.buy : trade.sell
  return (
    <Pressable
      testID={`depth-${side}-${p.index}`}
      accessibilityRole="button"
      accessibilityLabel={`${side === 'bid' ? 'Sell' : 'Buy'} at ${fmtPrice(row.price)}`}
      accessibilityState={{ disabled: p.disabled }}
      disabled={p.disabled}
      onPress={() => p.onLevel(side, row.price)}
      style={styles.cell}
    >
      <View
        pointerEvents="none"
        style={[
          styles.bar,
          side === 'bid' ? styles.fromCentreLeft : styles.fromCentreRight,
          { width: `${row.share * 100}%`, backgroundColor: colour },
        ]}
      />
      <Text variant="mono" style={[styles.price, { color: colour }]}>
        {fmtPrice(row.price)}
      </Text>
      <Text variant="mono" tone="muted" style={styles.orders}>
        {row.orders === undefined ? '' : fmtQty(row.orders)}
      </Text>
      <Text variant="mono" style={styles.qty}>
        {fmtQty(row.quantity)}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  head: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 4 },
  cell: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  bar: { position: 'absolute', top: 2, bottom: 2, opacity: 0.15, borderRadius: 3 },
  // a bid's bar grows from the middle of the ladder leftwards, an ask's rightwards
  fromCentreLeft: { right: 0 },
  fromCentreRight: { left: 0 },
  price: { flex: 5, fontSize: 13 },
  qty: { flex: 4, fontSize: 13, textAlign: 'right' },
  orders: { flex: 3, fontSize: 13, textAlign: 'right' },
})
