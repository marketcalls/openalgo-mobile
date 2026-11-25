// The order forms' fields (design 7.10), shared by the ticket and the modify sheet: a labelled
// field, the number input, one choice of a few, and what a price or quantity field holds.
import { createContext, type ReactNode, useContext } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import type { InstrumentMeta } from '../instruments/meta'
import { snapTick } from '../instruments/tick'
import type { Side } from '../types'

/** On the tick, with the price itself as the guard's reference, as the ticket rules send it. */
export const snapPrice = (n: number | undefined, meta: InstrumentMeta): number | undefined =>
  n === undefined ? undefined : snapTick(n, meta.tick, n)

/** Digits grouped by commas in threes (`142,405`), or the Indian way (`1,42,405`). */
const GROUPED = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})$/

/**
 * A field's text with its separators read, or null when they could mean two numbers. iOS's
 * decimal-pad shows the region's decimal separator, which is a comma in many regions (de, fr, es)
 * with no '.' key, so a lone comma is the decimal point ("1424,05"), unless three digits follow
 * it, which reads as a thousands group too ("1,424"). Commas before a point, or in several
 * groups, group thousands. A comma after a point ("1.424,05") reads two ways.
 */
function readSeparators(t: string): string | null {
  if (!t.includes(',')) return t
  const point = t.indexOf('.')
  if (point >= 0) {
    const int = t.slice(0, point)
    const rest = t.slice(point)
    return GROUPED.test(int) && !rest.includes(',') ? int.replace(/,/g, '') + rest : null
  }
  const parts = t.split(',')
  if (parts.length === 2) return /^\d{3}$/.test(parts[1] ?? '') ? null : parts.join('.')
  return GROUPED.test(t) ? t.replace(/,/g, '') : null
}

/**
 * What a price field holds: a number, or nothing while it is blank, not a number, or a text
 * that reads two ways, which the ticket rules then refuse rather than guess.
 */
export const numberOf = (s: string): number | undefined => {
  const t = s.trim()
  if (t === '') return undefined
  const plain = readSeparators(t)
  if (plain === null) return undefined
  const n = Number(plain)
  return Number.isFinite(n) ? n : undefined
}

/**
 * A blank or unreadable quantity is NaN, which the ticket rules refuse. Commas count only as
 * thousands groups: "10,5" is a decimal comma, not 105.
 */
export const qtyOf = (s: string): number => {
  const t = s.trim()
  if (t === '') return Number.NaN
  if (!t.includes(',')) return Number(t)
  return GROUPED.test(t) ? Number(t.replace(/,/g, '')) : Number.NaN
}

/** A field's text for a value: blank for none. */
export const fieldText = (n: number | undefined) =>
  n === undefined || !Number.isFinite(n) ? '' : String(n)

/** The label of the field an input sits in: its accessible name, so a screen reader tells a
 *  price from a trigger (the caption beside it is not linked to it). */
const FieldLabel = createContext<string | undefined>(undefined)

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="caption" tone="muted" importantForAccessibility="no">
        {label}
      </Text>
      <FieldLabel.Provider value={label}>{children}</FieldLabel.Provider>
    </View>
  )
}

export function Input(p: React.ComponentProps<typeof TextInput>) {
  const { c } = useTheme()
  const label = useContext(FieldLabel)
  return (
    <TextInput
      accessibilityLabel={label}
      {...p}
      selectTextOnFocus
      placeholderTextColor={c.mutedForeground}
      style={[styles.input, { color: c.foreground, borderColor: c.border }]}
    />
  )
}

export type Segment = { id: string; label: string; on: boolean; side?: Side; onPress: () => void }

/**
 * One choice of a few, the chosen one filled; a side fills in its own colour. A screen reader
 * hears a radio group named by `label`, each choice a radio, checked when chosen.
 */
export function Segments({ label, items }: { label: string; items: Segment[] }) {
  const { c, trade } = useTheme()
  return (
    <Field label={label}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        style={[styles.segments, { borderColor: c.border }]}
      >
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
              accessibilityRole="radio"
              accessibilityState={{ selected: s.on, checked: s.on }}
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
