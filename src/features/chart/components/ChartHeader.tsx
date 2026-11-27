// The chart's own header (the route shows none, so a pan never meets a back swipe): back, the
// instrument, its price and the day's change, and the facts that stand for a review before a
// one-tap order (design 7.10): the server's mode, and One-tap while it is on, with the product it
// sends here. The mode shows only once it is known (preflight conflict 7). Depth for anything
// tradeable.
import { Pressable, StyleSheet, View } from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import type { Inst } from '~/dom/bridge/protocol'
import { ModeBadge } from '~/market/components/ModeBadge'
import { defaultProduct, isQuoteOnly } from '~/market/instruments/exchanges'
import { Badge } from '~/ui/Badge'
import { Change } from '~/ui/Change'
import { fmtPrice } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const BACK: IconName = { ios: 'chevron.left', android: 'arrow_back' }

export function ChartHeader(p: {
  inst: Inst
  /** The live quote and the trading facts; off for an expired or unknown contract. */
  priced: boolean
  mode: 'live' | 'analyze' | 'unknown'
  oneTap: boolean
  onBack: () => void
  onDepth: () => void
}) {
  const { c } = useTheme()
  const { exchange, symbol } = p.inst
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable
          testID="chart-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={4}
          onPress={p.onBack}
          style={styles.back}
        >
          <Icon name={BACK} size={22} color={c.foreground} />
        </Pressable>
        <View style={styles.title}>
          <Text variant="heading" numberOfLines={1}>
            {symbol}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {exchange}
          </Text>
        </View>
        {p.priced ? <Price inst={p.inst} /> : null}
      </View>
      {p.priced ? (
        <View style={styles.facts}>
          {p.mode === 'unknown' ? null : <ModeBadge mode={p.mode} testID="chart-mode" />}
          {p.oneTap ? (
            <Badge
              testID="chart-onetap"
              label={isQuoteOnly(exchange) ? 'One-tap' : `One-tap · ${defaultProduct(exchange)}`}
              tone="warning"
            />
          ) : null}
          <View style={styles.fill} />
          {isQuoteOnly(exchange) ? null : (
            <Pressable
              testID="chart-depth"
              accessibilityRole="button"
              accessibilityLabel="Market depth"
              hitSlop={8}
              onPress={p.onDepth}
              style={[styles.depth, { borderColor: c.border }]}
            >
              <Text variant="caption" style={styles.depthLabel}>
                Depth
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  )
}

/** Its own component: a tick re-renders the price, not the screen. */
function Price({ inst }: { inst: Inst }) {
  const q = useLiveQuote(inst.exchange, inst.symbol, 2)
  return (
    <View style={styles.price}>
      <Text variant="mono" style={styles.ltp}>
        {fmtPrice(q?.ltp)}
      </Text>
      <Change change={q?.change} pct={q?.changePct} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 8, paddingBottom: 4, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  back: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, gap: 2 },
  price: { alignItems: 'flex-end', gap: 2, paddingRight: 8 },
  ltp: { fontVariant: ['tabular-nums'], fontWeight: '700' },
  facts: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  fill: { flex: 1 },
  depth: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  depthLabel: { fontWeight: '600' },
})
