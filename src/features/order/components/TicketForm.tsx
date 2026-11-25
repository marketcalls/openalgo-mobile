// The ticket's edit step (design 7.10): side, product, price type, quantity (lots on a
// derivative), price and trigger snapped to the tick when the field is left, the LTP, the margin
// and what stops the order going to review.
import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { productOptionsFor } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { fmtTick, snapTick } from '~/market/instruments/tick'
import { type TicketIssue, type TicketState, ticketUnits } from '~/market/orders/ticket'
import { PRICE_TYPES, type PriceType, type Side } from '~/market/types'
import { Button } from '~/ui/Button'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

/** On the tick, with the price itself as the guard's reference, as the ticket rules send it. */
export const snapPrice = (n: number | undefined, meta: InstrumentMeta): number | undefined =>
  n === undefined ? undefined : snapTick(n, meta.tick, n)

/** What a price field holds: a number, or nothing while it is blank or not a number. */
const priceOf = (s: string): number | undefined => {
  const t = s.replace(/,/g, '').trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** A blank or unreadable quantity is NaN, which the ticket rules refuse. */
const qtyOf = (s: string): number => {
  const t = s.replace(/,/g, '').trim()
  return t === '' ? Number.NaN : Number(t)
}

const fieldText = (n: number | undefined) =>
  n === undefined || !Number.isFinite(n) ? '' : String(n)

/** C9: LIMIT and SL carry a price, SL and SL-M a trigger. */
const showsPrice = (pt: PriceType) => pt === 'LIMIT' || pt === 'SL'
const showsTrigger = (pt: PriceType) => pt === 'SL' || pt === 'SL-M'

export function TicketForm(p: {
  ticket: TicketState
  meta: InstrumentMeta
  ltp: number | undefined
  issues: { issue: TicketIssue; text: string }[]
  /** "Sent as {n} orders (freeze limit {freeze})" when the order goes out split. */
  splitNote: string | null
  margin: number | null
  /** Why the last send did not go through. */
  error?: string
  canReview: boolean
  onChange: (patch: Partial<TicketState>) => void
  onReview: () => void
}) {
  const { ticket: t, meta } = p
  const [qty, setQty] = useState(() => fieldText(t.qty))
  const [price, setPrice] = useState(() => fieldText(t.price))
  const [trigger, setTrigger] = useState(() => fieldText(t.trigger))
  const qtyValid = Number.isInteger(t.qty) && t.qty >= 1

  const snapped = (field: 'price' | 'trigger', set: (s: string) => void) => () => {
    const n = snapPrice(t[field], meta)
    set(fieldText(n))
    p.onChange({ [field]: n })
  }

  return (
    <View style={styles.form}>
      <Segments
        label="Side"
        items={(['BUY', 'SELL'] as const).map((side) => ({
          id: `ticket-side-${side.toLowerCase()}`,
          label: side,
          on: t.action === side,
          side,
          onPress: () => p.onChange({ action: side }),
        }))}
      />
      <Segments
        label="Product"
        items={productOptionsFor(t.exchange).map((product) => ({
          id: `ticket-product-${product}`,
          label: product,
          on: t.product === product,
          onPress: () => p.onChange({ product }),
        }))}
      />
      <Segments
        label="Type"
        items={PRICE_TYPES.map((pricetype) => ({
          id: `ticket-type-${pricetype}`,
          label: pricetype,
          on: t.pricetype === pricetype,
          onPress: () => p.onChange({ pricetype }),
        }))}
      />

      <Field label={meta.lots ? 'Lots' : 'Quantity'}>
        <Input
          testID="ticket-qty"
          value={qty}
          keyboardType="number-pad"
          onChangeText={(s) => {
            setQty(s)
            p.onChange({ qty: qtyOf(s) })
          }}
        />
        {meta.lots && qtyValid ? (
          <Text variant="caption" tone="muted" testID="ticket-qty-units">
            {`${fmtQty(t.qty)} × ${fmtQty(meta.lotsize)} = ${fmtQty(ticketUnits(t, meta))}`}
          </Text>
        ) : null}
      </Field>

      {showsPrice(t.pricetype) ? (
        <Field label="Price">
          <Input
            testID="ticket-price"
            value={price}
            keyboardType="decimal-pad"
            onChangeText={(s) => {
              setPrice(s)
              p.onChange({ price: priceOf(s) })
            }}
            onBlur={snapped('price', setPrice)}
          />
        </Field>
      ) : null}
      {showsTrigger(t.pricetype) ? (
        <Field label="Trigger price">
          <Input
            testID="ticket-trigger"
            value={trigger}
            keyboardType="decimal-pad"
            onChangeText={(s) => {
              setTrigger(s)
              p.onChange({ trigger: priceOf(s) })
            }}
            onBlur={snapped('trigger', setTrigger)}
          />
        </Field>
      ) : null}

      <Text variant="mono" tone="muted" testID="ticket-ltp">
        {`LTP ${p.ltp === undefined ? '--' : fmtTick(p.ltp, meta.tick, p.ltp)}`}
      </Text>
      {p.margin !== null ? (
        <Text variant="mono" testID="ticket-margin">{`Margin ≈ ₹${fmtPrice(p.margin)}`}</Text>
      ) : null}
      {p.splitNote ? (
        <Text testID="ticket-split-note" tone="muted">
          {p.splitNote}
        </Text>
      ) : null}
      {p.issues.map(({ issue, text }) => (
        <Text key={issue} testID={`ticket-issue-${issue}`} tone="loss">
          {text}
        </Text>
      ))}
      {p.error ? (
        <Text testID="ticket-error" tone="loss">
          {p.error}
        </Text>
      ) : null}

      <Button
        testID="ticket-review"
        title="Review order"
        disabled={!p.canReview}
        onPress={p.onReview}
      />
    </View>
  )
}

type Segment = { id: string; label: string; on: boolean; side?: Side; onPress: () => void }

/** One choice of a few, the chosen one filled; a side fills in its own colour. */
function Segments({ label, items }: { label: string; items: Segment[] }) {
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </View>
  )
}

function Input(p: React.ComponentProps<typeof TextInput>) {
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

const styles = StyleSheet.create({
  form: { gap: 14 },
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
