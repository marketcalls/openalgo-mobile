// What came of the order (design 7.10). Placed shows its id, and the sandbox mark for an
// analyzer reply; queued points to the web Action Center; an unknown outcome says what the order
// book shows. Nothing here sends the order again: the way on is the order book.
import { StyleSheet, View } from 'react-native'
import { ApiError, userMessage } from '~/core/http/errors'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { type SplitPlaced, SplitResult } from './SplitResult'

/** What the order book showed after an unknown outcome; `checked` false when it could not be read. */
export type Reconcile =
  | { kind: 'single'; checked: boolean; status: string | null }
  | { kind: 'split'; checked: boolean; found: number; of: number }

export type TicketResult =
  | { kind: 'placed'; orderid: string; analyze: boolean }
  | { kind: 'queued' }
  | { kind: 'split'; reply: SplitPlaced }
  /** It may have gone (MaybePlaced, a 5xx, a success without an id); `check` once the book says. */
  | { kind: 'maybe'; check: Reconcile | null }

/** A-T7's copy for MaybePlaced, verbatim (ruling 3). */
const CHECKING = userMessage(
  new ApiError({ kind: 'MaybePlaced', status: 0, endpoint: 'placeorder' }),
)
const NOT_FOUND =
  'Not found in the order book. It was probably not placed. Check the order book before trying again.'
const NOT_CHECKED = "Couldn't check the order book. Check it before trying again."
const SANDBOX = 'Analyzer (sandbox)'

function reconciled(r: Reconcile): string {
  if (!r.checked) return NOT_CHECKED
  if (r.kind === 'split') return `Found ${r.found} of ${r.of} child orders in the order book.`
  return r.status === null ? NOT_FOUND : `Found in the order book: ${r.status || '--'}`
}

export function ResultView(p: {
  result: TicketResult
  onDone: () => void
  onViewOrderbook: () => void
  onOpenActionCenter: () => void
}) {
  const { result: r } = p
  const orderbook = (
    <Button
      testID="view-orderbook"
      title="View order book"
      variant="secondary"
      onPress={p.onViewOrderbook}
    />
  )
  return (
    <View style={styles.wrap} testID="order-result">
      {r.kind === 'placed' ? (
        <>
          <Text variant="heading">Order placed</Text>
          <Text variant="mono" testID="order-result-id">{`Order ID ${r.orderid}`}</Text>
          {r.analyze ? <Badge testID="result-sandbox" label={SANDBOX} tone="analyze" /> : null}
        </>
      ) : r.kind === 'queued' ? (
        <>
          <Text variant="heading">{QUEUED_COPY}</Text>
          <Button
            testID="open-action-center"
            title="Open Action Center"
            variant="secondary"
            onPress={p.onOpenActionCenter}
          />
        </>
      ) : r.kind === 'split' ? (
        <>
          {r.reply.analyze ? (
            <Badge testID="result-sandbox" label={SANDBOX} tone="analyze" />
          ) : null}
          <SplitResult reply={r.reply} />
          {orderbook}
        </>
      ) : (
        <>
          <Text variant="heading">{CHECKING}</Text>
          {r.check === null ? (
            <Skeleton rows={1} />
          ) : (
            <Text testID="result-reconcile">{reconciled(r.check)}</Text>
          )}
          {orderbook}
        </>
      )}
      <Button testID="ticket-done" title="Done" onPress={p.onDone} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
})
