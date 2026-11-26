// One GTT of the GTT book (design 17.3, 7.11: dense, tabular numbers): the contract, Single or
// OCO, the status, the triggers, each leg in its side's colour, and for an active GTT the live
// price. A GTT that is over (cancelled, expired, rejected, deleted) is dimmed. A tap on a GTT that
// can still change opens its actions.
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import type { GttLeg, GttRow as Row } from '~/market/gtt/schemas'
import { fmtTick } from '~/market/instruments/tick'
import { useIsUnknown } from '~/market/instruments/useInstrument'
import type { OrderMeta } from '~/market/orders/outcome'
import { type Tone, useToneColors } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { fmtQty, signOf } from '~/ui/format'
import { Price } from '~/ui/Price'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { GTT_ROW_OUT } from '../hooks/useGttWrites'

/** A GTT that is over: it can no longer fire or change. */
const OVER = new Set(['cancelled', 'expired', 'rejected', 'deleted'])

/** Modify replaces an active GTT; Cancel takes an active or a disabled one. */
const canModify = (r: Row) => r.status === 'active'
const canCancel = (r: Row) => r.status === 'active' || r.status === 'disabled'

const statusTone = (status: string): Tone => (status === 'triggered' ? 'analyze' : 'neutral')

const px = (n: number, meta: OrderMeta) => fmtTick(n, meta.tick, n)

/** "2L (130)" for whole lots of a contract known to trade in lots, else the units. */
function qty(n: number, meta: OrderMeta): string {
  const lots = meta.lots ? n / meta.lotsize : Number.NaN
  return Number.isInteger(lots) ? `${fmtQty(lots)}L (${fmtQty(n)})` : fmtQty(n)
}

export function GttRow(p: {
  row: Row
  meta: OrderMeta
  expanded: boolean
  onPress: () => void
  /** The actions, under the row while it is expanded. */
  children?: ReactNode
}) {
  const { row: r, meta } = p
  const { c } = useTheme()
  const id = r.triggerId
  const actionable = canModify(r) || canCancel(r)
  const triggers = r.triggers.map((n) => px(n, meta)).join(' / ')
  return (
    <View style={[styles.wrap, { borderBottomColor: c.border }]}>
      <Pressable
        testID={`gtt-row-${id}`}
        accessibilityRole={actionable ? 'button' : undefined}
        accessibilityState={actionable ? { expanded: p.expanded } : undefined}
        onPress={actionable ? p.onPress : undefined}
        style={[styles.row, { opacity: OVER.has(r.status) ? 0.6 : 1 }]}
      >
        <View style={styles.line}>
          <Text style={styles.symbol} numberOfLines={1}>
            {r.symbol}
          </Text>
          <Text variant="caption" tone="muted">
            {r.exchange}
          </Text>
          <Text variant="caption" tone="muted">
            {r.type === 'OCO' ? 'OCO' : 'Single'}
          </Text>
          <View style={styles.spacer} />
          <Status testID={`gtt-status-${id}`} status={r.status} />
        </View>
        <View style={styles.line}>
          <Text variant="caption" tone="muted">
            Trigger <Text variant="mono">{triggers || '--'}</Text>
          </Text>
          <View style={styles.spacer} />
          {r.status === 'active' ? (
            <Ltp exchange={r.exchange} symbol={r.symbol} testID={`gtt-ltp-${id}`} />
          ) : null}
        </View>
        {r.legs.map((leg, i) => (
          // The legs come in trigger order, each once: the index is the leg.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Leg key={i} leg={leg} meta={meta} />
        ))}
      </Pressable>
      {p.children}
    </View>
  )
}

/**
 * The status in Badge's tones, with its id on the label, so a Maestro flow reads the id and the
 * text from one node (ruling 28, as `ModeBadge`).
 */
function Status({ status, testID }: { status: string; testID: string }) {
  const { bg, fg } = useToneColors(statusTone(status))
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text testID={testID} variant="caption" style={[styles.badgeLabel, { color: fg }]}>
        {status || '--'}
      </Text>
    </View>
  )
}

/** `SELL 1 @ 1,499.00 LIMIT · CNC`, the side in its colour. */
function Leg({ leg, meta }: { leg: GttLeg; meta: OrderMeta }) {
  const { trade } = useTheme()
  return (
    <Text variant="mono">
      <Text style={[styles.side, { color: leg.action === 'BUY' ? trade.buy : trade.sell }]}>
        {leg.action}
      </Text>
      {` ${qty(leg.quantity, meta)} @ ${px(leg.price, meta)} ${leg.pricetype || '--'} · ${leg.product || '--'}`}
    </Text>
  )
}

/**
 * The live price, LTP only (mode 1), for a row on screen. An expired or unknown contract takes no
 * feed slot and makes no call (ruling 8).
 */
function Ltp(p: { exchange: string; symbol: string; testID: string }) {
  const unknown = useIsUnknown(p.exchange, p.symbol)
  return unknown ? null : <LiveLtp {...p} />
}

function LiveLtp(p: { exchange: string; symbol: string; testID: string }) {
  const q = useLiveQuote(p.exchange, p.symbol, 1)
  return <Price value={q?.ltp} sign={signOf(q?.change)} testID={p.testID} />
}

/** A GTT's actions, under the row once it is tapped. */
export function GttActions(p: {
  row: Row
  /** A write on this GTT is still out, so its outcome is not known yet: the bar says so. */
  pending: boolean
  /** Blocked, or a write on this GTT or from the tab is out: Modify and Cancel wait. */
  disabled: boolean
  onModify: () => void
  onCancel: () => void
}) {
  return (
    <View style={styles.actions}>
      {p.pending ? (
        <Text testID="gtt-pending" variant="caption" tone="muted" style={styles.note}>
          {GTT_ROW_OUT}
        </Text>
      ) : null}
      <View style={styles.bar}>
        {canModify(p.row) ? (
          <View style={styles.slot}>
            <Button
              testID="gtt-modify"
              title="Modify"
              variant="secondary"
              disabled={p.disabled}
              onPress={p.onModify}
            />
          </View>
        ) : null}
        {canCancel(p.row) ? (
          <View style={styles.slot}>
            <Button
              testID="gtt-cancel"
              title="Cancel"
              variant="destructive"
              disabled={p.disabled}
              onPress={p.onCancel}
            />
          </View>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 8, gap: 4 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { fontWeight: '600', flexShrink: 1 },
  spacer: { flex: 1 },
  side: { fontWeight: '700' },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeLabel: { fontWeight: '700' },
  actions: { gap: 6 },
  note: { paddingHorizontal: 16 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  slot: { flex: 1 },
})
