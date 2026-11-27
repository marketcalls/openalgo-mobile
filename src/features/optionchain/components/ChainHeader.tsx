// The chain's fixed header (ux OC-1, Kite's quiet chrome): only the ladder below it scrolls.
// Row 1 (48 dp): back, the underlying (a tap opens the picker), its live price and change, and the
// server's mode. The price keeps its width on one line (shrinking to fit only as a last resort) and
// a long underlying ellipsizes first (G9). Then the connection badges when any is true (the mode is
// not among them: one badge per screen, G16) and, under polling, how often prices refresh. Row 2
// (44 dp): the two nearest expiries (they scroll when they do not fit), then More, the Price/Greeks
// switch and the strike count, always in view (OC-1). The Greeks view adds its five chips, and the
// column heads close the header.
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useQuoteFrom } from '~/core/realtime/useQuote'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { ModeBadge } from '~/market/components/ModeBadge'
import type { OptionChain } from '~/market/options/schemas'
import { fmtPct, fmtPrice, fmtSigned, signOf } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { StatusBadges } from '~/ui/StatusBadges'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import {
  type ChainTarget,
  type ChainView,
  expiryChip,
  expiryLabel,
  GREEK_LABEL,
  GREEKS,
  type Greek,
  type GreekPair,
  pollingNote,
} from '../model'
import { MAX_SCALE, STRIKE_WIDTH } from './StrikeRow'

const BACK: IconName = { ios: 'chevron.left', android: 'arrow_back' }
/** The expiries shown as chips; More lists them all. */
const CHIPS = 2

export function ChainHeader(p: {
  topInset: number
  target: ChainTarget
  chain: OptionChain | undefined
  underlyingKey: string | null
  feeding: boolean
  expiries: readonly string[] | undefined
  expiry: string | null
  nowMs: number
  count: number
  view: ChainView
  greeks: GreekPair
  pollMs: number
  onBack(): void
  onUnderlying(): void
  onExpiry(expiry: string): void
  onMoreExpiries(): void
  onCount(): void
  onView(view: ChainView): void
  onGreek(g: Greek): void
}) {
  const { c } = useTheme()
  const conn = useConnection()
  const polling = conn.feed === 'polling'
  const badges = conn.transport === 'http' || polling || conn.brokerSession === 'logged_out'
  const list = p.expiries ?? []
  const picked = p.expiry === null ? -1 : list.indexOf(p.expiry)
  return (
    <View style={{ paddingTop: p.topInset }}>
      <View style={styles.row1}>
        <Pressable
          testID="oc-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={p.onBack}
          style={styles.back}
        >
          <Icon name={BACK} size={22} color={c.foreground} />
        </Pressable>
        <Pressable
          testID="oc-underlying"
          accessibilityRole="button"
          accessibilityHint="Picks another underlying"
          onPress={p.onUnderlying}
          style={styles.underlying}
        >
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE} style={styles.big}>
            {`${p.target.underlying} ▾`}
          </Text>
        </Pressable>
        <Spot chain={p.chain} underlyingKey={p.underlyingKey} feeding={p.feeding} />
        {conn.analyzer === 'unknown' ? null : <ModeBadge mode={conn.analyzer} testID="oc-mode" />}
      </View>
      {badges ? (
        <View style={styles.badges}>
          <StatusBadges
            transport={conn.transport}
            feed={conn.feed}
            brokerSession={conn.brokerSession}
            analyzer={conn.analyzer}
            mode={false}
          />
        </View>
      ) : null}
      {polling ? (
        <Text testID="oc-polling-note" tone="muted" style={styles.note}>
          {pollingNote(p.pollMs)}
        </Text>
      ) : null}
      <View style={styles.row2}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          style={styles.fill}
        >
          {list.slice(0, CHIPS).map((e, i) => (
            <Chip
              key={e}
              testID={`oc-expiry-${i}`}
              label={expiryChip(e, p.nowMs)}
              selected={i === picked}
              onPress={() => p.onExpiry(e)}
            />
          ))}
        </ScrollView>
        {/* outside the scroll: the way to every expiry is always in view (OC-1) */}
        <Chip
          testID="oc-expiry"
          label={picked >= CHIPS && p.expiry !== null ? `${expiryLabel(p.expiry)} ▾` : 'More ▾'}
          selected={picked >= CHIPS}
          hint="Lists every expiry"
          onPress={p.onMoreExpiries}
        />
        <Chip
          testID="oc-greeks"
          label="Greeks"
          selected={p.view === 'greeks'}
          hint="Switches between prices and Greeks"
          onPress={() => p.onView(p.view === 'greeks' ? 'price' : 'greeks')}
        />
        <Chip
          testID="oc-count"
          label={`±${p.count}`}
          hint="Strikes each side"
          selected={false}
          onPress={p.onCount}
        />
      </View>
      {p.view === 'greeks' ? (
        <View style={styles.greekRow}>
          {GREEKS.map((g) => (
            <Chip
              key={g}
              testID={`oc-greek-${g}`}
              label={GREEK_LABEL[g]}
              selected={p.greeks.includes(g)}
              onPress={() => p.onGreek(g)}
            />
          ))}
        </View>
      ) : null}
      <ColumnHeads view={p.view} greeks={p.greeks} />
    </View>
  )
}

/** The underlying's live LTP (its own tick), else the chain's, with the day's change. */
function Spot(p: {
  chain: OptionChain | undefined
  underlyingKey: string | null
  feeding: boolean
}) {
  const { store } = useServices()
  const q = useQuoteFrom(store, p.underlyingKey ?? '', p.feeding && p.underlyingKey !== null)
  const tick = p.feeding && p.underlyingKey !== null ? q : undefined
  const ltp = tick?.ltp ?? p.chain?.underlying_ltp
  const prev = p.chain?.underlying_prev_close ?? 0
  const change = tick?.change ?? (ltp !== undefined && prev > 0 ? ltp - prev : undefined)
  const pct =
    tick?.changePct ?? (change !== undefined && prev > 0 ? (change / prev) * 100 : undefined)
  const sign = signOf(change)
  const tone = sign > 0 ? 'profit' : sign < 0 ? 'loss' : 'muted'
  return (
    <View style={styles.spot}>
      <Text
        testID="oc-spot-ltp"
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={MAX_SCALE}
        style={styles.big}
      >
        {fmtPrice(ltp)}
      </Text>
      <Text
        testID="oc-spot-change"
        tone={tone}
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={MAX_SCALE}
        style={styles.change}
      >
        {`${fmtSigned(change)} (${fmtPct(pct)})`}
      </Text>
    </View>
  )
}

function ColumnHeads(p: { view: ChainView; greeks: GreekPair }) {
  const { c } = useTheme()
  const [outer, inner] =
    p.view === 'price' ? ['OI', 'LTP'] : [GREEK_LABEL[p.greeks[0]], GREEK_LABEL[p.greeks[1]]]
  const head = (label: string) => (
    <Text tone="muted" maxFontSizeMultiplier={MAX_SCALE} style={styles.head}>
      {label}
    </Text>
  )
  return (
    <View testID="oc-colhead" style={[styles.colhead, { borderBottomColor: c.border }]}>
      <View style={styles.side}>
        {head(outer)}
        {head(inner)}
      </View>
      <View style={styles.strike}>
        <Text tone="muted" maxFontSizeMultiplier={MAX_SCALE} style={[styles.head, styles.center]}>
          Strike
        </Text>
      </View>
      <View style={styles.side}>
        {head(inner)}
        {head(outer)}
      </View>
    </View>
  )
}

function Chip(p: {
  testID: string
  label: string
  selected: boolean
  hint?: string
  onPress(): void
}) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityHint={p.hint}
      accessibilityState={{ selected: p.selected }}
      hitSlop={6}
      onPress={p.onPress}
      style={[
        styles.chip,
        { borderColor: c.border },
        p.selected && { backgroundColor: c.primary, borderColor: c.primary },
      ]}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={MAX_SCALE}
        style={[styles.chipText, p.selected && { color: c.primaryForeground }]}
      >
        {p.label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row1: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 12 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  underlying: { flexShrink: 1, minHeight: 44, justifyContent: 'center', paddingRight: 8 },
  big: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // its own width, at the row's end: the underlying, not the price, gives way (G9)
  spot: { marginLeft: 'auto', flexShrink: 0, alignItems: 'flex-end', paddingRight: 8 },
  change: { fontSize: 12, fontVariant: ['tabular-nums'] },
  badges: { paddingHorizontal: 12, paddingBottom: 4 },
  note: { fontSize: 12, paddingHorizontal: 12, paddingBottom: 4 },
  row2: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 12 },
  fill: { flex: 1 },
  chipRow: { alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 6 },
  greekRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  chipText: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  colhead: {
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  side: { flex: 1, flexDirection: 'row', minWidth: 0 },
  strike: { width: STRIKE_WIDTH },
  head: { flex: 1, fontSize: 12, fontWeight: '600', textAlign: 'right', paddingHorizontal: 6 },
  center: { textAlign: 'center' },
})
