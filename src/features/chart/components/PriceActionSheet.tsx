// The actions of a long press on the chart (design 7.9.6): the pressed price, and one button per
// order the ticket can open there (`priceActions`). A pick opens the ticket preset; nothing here
// places an order. Mount it to show it, so each long press starts afresh.
import { useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import type { PriceAction } from '~/market/chart/priceActions'
import { Button } from '~/ui/Button'
import { Sheet } from '~/ui/Sheet'
import { Text } from '~/ui/Text'

export function PriceActionSheet(p: {
  /** `SYMBOL @ price`, the price at the tick's decimals. */
  title: string
  actions: readonly PriceAction[]
  onPick: (a: PriceAction) => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(true)
  const picked = useRef<PriceAction | null>(null)
  /** The sheet has gone: the pick, if one was made, opens its ticket now. */
  const gone = () => {
    const a = picked.current
    picked.current = null
    if (a) p.onPick(a)
    else p.onClose()
  }
  const pick = (a: PriceAction) => {
    picked.current = a
    // iOS presents nothing over a sheet still closing, so the ticket waits for its dismissal
    // (onDismiss); an Android sheet is gone at once.
    if (Platform.OS === 'ios') setOpen(false)
    else gone()
  }
  return (
    <Sheet visible={open} onClose={gone}>
      <View style={styles.body}>
        <Text variant="heading" testID="chart-price-title">
          {p.title}
        </Text>
        {p.actions.map((a) => (
          <Button
            key={a.id}
            testID={a.testID}
            title={a.label}
            variant={a.params.action === 'BUY' ? 'buy' : 'sell'}
            onPress={() => pick(a)}
          />
        ))}
        <Button
          testID="chart-price-cancel"
          title="Cancel"
          variant="secondary"
          onPress={p.onClose}
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: 12 },
})
