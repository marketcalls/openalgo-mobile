// The depth panel (design 7.5): the level switch and its note, the ladder (or its read error, or
// a skeleton) and the day's total buy and sell quantities. It holds the one book subscription of
// its screen; a level tap reports a LIMIT ticket at its price.
import { Pressable, StyleSheet, View } from 'react-native'
import type { DepthLevels } from '~/core/realtime/protocol'
import type { TicketParams } from '~/market/types'
import { ErrorState } from '~/ui/ErrorState'
import { fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { useDepthBook } from '../hooks/useDepthBook'
import { levelTicket } from '../model'
import { Ladder } from './Ladder'

type Props = { exchange: string; symbol: string; onLevel: (t: TicketParams) => void }

export function DepthPanel({ exchange, symbol, onLevel }: Props) {
  const d = useDepthBook({ exchange, symbol })
  return (
    <View style={styles.panel}>
      {d.choices.length > 1 ? (
        <LevelSwitch choices={d.choices} value={d.levels} onChange={d.pick} />
      ) : null}
      {d.note ? (
        <Text testID="depth-levels-note" variant="caption" tone="muted">
          {d.note}
        </Text>
      ) : null}
      {d.failed ? (
        // outside the stale dimming: the retry must not look disabled
        <View testID="depth-error">
          <ErrorState error={d.failed.error} onRetry={d.failed.retry} />
        </View>
      ) : (
        <View style={{ opacity: d.stale ? 0.5 : 1 }}>
          {d.hasBook ? (
            <Ladder
              bids={d.rows.bids}
              asks={d.rows.asks}
              disabled={d.blocked}
              onLevel={(side, price) => onLevel(levelTicket(side, price, exchange, symbol))}
            />
          ) : (
            <Skeleton rows={5} />
          )}
          <View style={styles.totals}>
            <Total testID="depth-total-buy" label="Total buy qty" value={d.q?.totalBuyQty} />
            <Total testID="depth-total-sell" label="Total sell qty" value={d.q?.totalSellQty} />
          </View>
        </View>
      )}
    </View>
  )
}

function Total({ testID, label, value }: { testID: string; label: string; value?: number }) {
  return (
    <View style={styles.total}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" testID={testID}>
        {fmtQty(value)}
      </Text>
    </View>
  )
}

function LevelSwitch(p: {
  choices: DepthLevels[]
  value: DepthLevels
  onChange: (n: DepthLevels) => void
}) {
  const { c } = useTheme()
  return (
    <View style={styles.switchRow}>
      <Text variant="caption" tone="muted">
        Levels
      </Text>
      <View style={[styles.switch, { borderColor: c.border }]}>
        {p.choices.map((n) => {
          const on = n === p.value
          return (
            <Pressable
              key={n}
              testID={`depth-levels-${n}`}
              accessibilityRole="button"
              accessibilityLabel={`${n} levels`}
              accessibilityState={{ selected: on }}
              onPress={() => p.onChange(n)}
              style={[styles.segment, on && { backgroundColor: c.primary }]}
            >
              <Text style={{ color: on ? c.primaryForeground : c.foreground }}>{String(n)}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { gap: 16 },
  totals: { flexDirection: 'row', gap: 8, marginTop: 12 },
  total: { flex: 1, gap: 2 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switch: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segment: { minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
})
