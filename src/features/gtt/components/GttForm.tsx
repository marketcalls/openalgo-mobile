// The GTT ticket's edit step (design 17.3): the type (a SINGLE trigger, or an OCO's stop-loss and
// target), the side, the quantity (lots on a derivative), each trigger and limit price snapped to
// the tick when its field is left, the LTP, and what stops the GTT going to review. A modify keeps
// the GTT's own type, side and product: a modify replaces the GTT, and they are not its to change.
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
import { SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import type { GttType } from '~/market/gtt/schemas'
import { type GttIssue, type GttTicketState, gttProduct } from '~/market/gtt/ticket'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { fmtTick } from '~/market/instruments/tick'
import { Button } from '~/ui/Button'
import { fmtQty } from '~/ui/format'
import { Text } from '~/ui/Text'

type PriceKey = 'trigger' | 'price' | 'slTrigger' | 'slPrice' | 'tgTrigger' | 'tgPrice'

const TYPES: { type: GttType; label: string }[] = [
  { type: 'SINGLE', label: 'Single' },
  { type: 'OCO', label: 'OCO' },
]

/** The price fields of each type, by their testID and label. */
const FIELDS: Record<GttType, { key: PriceKey; id: string; label: string }[]> = {
  SINGLE: [
    { key: 'trigger', id: 'gtt-trigger', label: 'Trigger price' },
    { key: 'price', id: 'gtt-price', label: 'Limit price' },
  ],
  OCO: [
    { key: 'slTrigger', id: 'gtt-sl-trigger', label: 'Stop-loss trigger' },
    { key: 'slPrice', id: 'gtt-sl-price', label: 'Stop-loss limit price' },
    { key: 'tgTrigger', id: 'gtt-tg-trigger', label: 'Target trigger' },
    { key: 'tgPrice', id: 'gtt-tg-price', label: 'Target limit price' },
  ],
}

export function GttForm(p: {
  ticket: GttTicketState
  meta: InstrumentMeta
  ltp: number | undefined
  issues: { issue: GttIssue; text: string }[]
  /** A modify: the type, side and product are the GTT's own. */
  fixed: boolean
  /** Why the last send did not go through. */
  error?: string
  /** The server's reason when Semi-Auto mode refused the last send. */
  semiAuto?: string
  canReview: boolean
  onChange: (patch: Partial<GttTicketState>) => void
  onReview: () => void
}) {
  const { ticket: t, meta } = p
  const [qty, setQty] = useState(() => fieldText(t.qty))
  const qtyValid = Number.isInteger(t.qty) && t.qty >= 1

  return (
    <View style={styles.form}>
      {p.fixed ? (
        <Text tone="muted">
          {`${t.action} · ${t.type === 'OCO' ? 'OCO' : 'Single'} · ${gttProduct(t.exchange)}`}
        </Text>
      ) : (
        <>
          <Segments
            label="Type"
            items={TYPES.map(({ type, label }) => ({
              id: `gtt-type-${type}`,
              label,
              on: t.type === type,
              onPress: () => p.onChange({ type }),
            }))}
          />
          <Segments
            label="Side"
            items={(['BUY', 'SELL'] as const).map((side) => ({
              id: `gtt-side-${side.toLowerCase()}`,
              label: side,
              on: t.action === side,
              side,
              onPress: () => p.onChange({ action: side }),
            }))}
          />
        </>
      )}

      <Field label={meta.lots ? 'Lots' : 'Quantity'}>
        <Input
          testID="gtt-qty"
          value={qty}
          keyboardType="number-pad"
          onChangeText={(s) => {
            setQty(s)
            p.onChange({ qty: qtyOf(s) })
          }}
        />
        {meta.lots && qtyValid ? (
          <Text variant="caption" tone="muted">
            {`${fmtQty(t.qty)} × ${fmtQty(meta.lotsize)} = ${fmtQty(t.qty * meta.lotsize)}`}
          </Text>
        ) : null}
      </Field>

      {FIELDS[t.type].map((f) => (
        <PriceField
          key={f.key}
          testID={f.id}
          label={f.label}
          value={t[f.key]}
          meta={meta}
          onChange={(n) => p.onChange({ [f.key]: n })}
        />
      ))}

      <Text variant="mono" tone="muted" testID="gtt-ltp">
        {`LTP ${p.ltp === undefined ? '--' : fmtTick(p.ltp, meta.tick, p.ltp)}`}
      </Text>
      {p.issues.map(({ issue, text }) => (
        <Text key={issue} testID={`gtt-issue-${issue.toUpperCase()}`} tone="loss">
          {text}
        </Text>
      ))}
      {p.error ? (
        <Text testID="gtt-error" tone="loss">
          {p.error}
        </Text>
      ) : null}
      {p.semiAuto ? <SemiAutoBlockedBanner message={p.semiAuto} /> : null}

      <Button testID="gtt-review" title="Review GTT" disabled={!p.canReview} onPress={p.onReview} />
    </View>
  )
}

/** A trigger or limit price, snapped to the tick when the field is left. */
function PriceField(p: {
  testID: string
  label: string
  value: number | undefined
  meta: InstrumentMeta
  onChange: (n: number | undefined) => void
}) {
  const [text, setText] = useState(() => fieldText(p.value))
  return (
    <Field label={p.label}>
      <Input
        testID={p.testID}
        value={text}
        keyboardType="decimal-pad"
        onChangeText={(s) => {
          setText(s)
          p.onChange(numberOf(s))
        }}
        onBlur={() => {
          const n = snapPrice(p.value, p.meta)
          setText(fieldText(n))
          p.onChange(n)
        }}
      />
    </Field>
  )
}

const styles = StyleSheet.create({
  form: { gap: 14 },
})
