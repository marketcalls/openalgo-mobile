// The ticket's edit step (design 7.10): side, product, price type, quantity (lots on a
// derivative), price and trigger snapped to the tick when the field is left, the LTP, the margin
// and what stops the order going to review. Where the server serves GTT for this contract, the
// ticket gives way to the GTT ticket for the same side and quantity (design 17.3).
import { type Href, useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  Field,
  fieldText,
  Input,
  numberOf,
  qtyOf,
  Segments,
  snapPrice,
} from '~/market/components/OrderFields'
import { useGttSupport } from '~/market/gtt/queries'
import { productOptionsFor } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { fmtTick } from '~/market/instruments/tick'
import { gttHref } from '~/market/links'
import { type TicketIssue, type TicketState, ticketUnits } from '~/market/orders/ticket'
import { PRICE_TYPES, type PriceType } from '~/market/types'
import { Button } from '~/ui/Button'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'

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
  const router = useRouter()
  const gtt = useGttSupport(t.exchange)
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
              p.onChange({ price: numberOf(s) })
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
              p.onChange({ trigger: numberOf(s) })
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
      {gtt.state === 'yes' ? (
        <Button
          testID="ticket-gtt"
          title="Create GTT"
          variant="secondary"
          onPress={() =>
            router.replace(
              gttHref({
                exchange: t.exchange,
                symbol: t.symbol,
                action: t.action,
                quantity: ticketUnits(t, meta),
              }) as Href,
            )
          }
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: 14 },
})
