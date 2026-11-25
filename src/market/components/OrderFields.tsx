// The order forms' fields (design 7.10), shared by the ticket and the modify sheet: a labelled
// field, the number input, one choice of a few, and what a price or quantity field holds.
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import type { InstrumentMeta } from '../instruments/meta'
import { snapTick } from '../instruments/tick'
import type { Side } from '../types'

/** On the tick, with the price itself as the guard's reference, as the ticket rules send it. */
export const snapPrice = (n: number | undefined, meta: InstrumentMeta): number | undefined =>
  n === undefined ? undefined : snapTick(n, meta.tick, n)

/** What a number field holds: a number, or nothing while it is blank or not a number. */
export const numberOf = (s: string): number | undefined => {
  const t = s.replace(/,/g, '').trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** A blank or unreadable quantity is NaN, which the ticket rules refuse. */
export const qtyOf = (s: string): number => {
  const t = s.replace(/,/g, '').trim()
  return t === '' ? Number.NaN : Number(t)
}

/** A field's text for a value: blank for none. */
export const fieldText = (n: number | undefined) =>
  n === undefined || !Number.isFinite(n) ? '' : String(n)

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </View>
  )
}

export function Input(p: React.ComponentProps<typeof TextInput>) {
  const { c } = useTheme()
  return (
    <TextInput
      {...p}
      selectTextOnFocus
      placeholderTextColor={c.mutedForeground}
      style={[styles.input, { color: c.foreground, borderColor: c.border }]}
    />
  )
}

export type Segment = { id: string; label: string; on: boolean; side?: Side; onPress: () => void }

/** One choice of a few, the chosen one filled; a side fills in its own colour. */
export function Segments({ label, items }: { label: string; items: Segment[] }) {
  const { c, trade } = useTheme()
  return (
    <Field label={label}>
      <View style={[styles.segments, { borderColor: c.border }]}>
        {items.map((s) => {
          const bg = !s.on
            ? 'transparent'
            : s.side === 'BUY'
              ? trade.buy
              : s.side === 'SELL'
                ? trade.sell
                : c.primary
          const fg = !s.on
            ? c.foreground
            : s.side === 'BUY'
              ? trade.onBuy
              : s.side === 'SELL'
                ? trade.onSell
                : c.primaryForeground
          return (
            <Pressable
              key={s.id}
              testID={s.id}
              accessibilityRole="button"
              accessibilityState={{ selected: s.on }}
              onPress={s.onPress}
              style={[styles.segment, { backgroundColor: bg }]}
            >
              <Text style={{ color: fg, fontWeight: s.on ? '700' : '400' }}>{s.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </Field>
  )
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  segments: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
})
