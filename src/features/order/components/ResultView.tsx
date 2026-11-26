// What came of the order (design 7.10). Placed shows its id, the sandbox mark for an analyzer
// reply, and then its status as the order book shows it (a broker can reject a placed order a
// moment later); an order the server took LIVE after an ANALYZE review leads with the danger
// notice; queued points to the web Action Center; an unknown outcome says what the order book
// shows. Nothing here sends the order again: the way on is the order book.
import { StyleSheet, View } from 'react-native'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { CHECKING } from '~/market/orders/outcome'
import { reconcileText, type TicketResult, waitText } from '~/market/orders/result'
import { LIVE_SURPRISE } from '~/market/orders/submit'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { SplitResult } from './SplitResult'

const SANDBOX = 'Analyzer (sandbox)'

/** A placed order's status, as the order book or its order event showed it: rejected in danger. */
function PlacedStatus({ status }: { status: string }) {
  const rejected = status === 'rejected'
  return (
    <Text testID="order-result-status" tone={rejected ? 'loss' : 'muted'}>
      {rejected
        ? 'Rejected by the broker. See the order book for the reason.'
        : `Status: ${status || '--'}`}
    </Text>
  )
}

export function ResultView(p: {
  result: TicketResult
  /** The placed order's status once the book shows it; null until then. */
  placedStatus?: string | null
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
      {(r.kind === 'placed' || r.kind === 'split') && r.liveSurprise ? (
        <LiveSurpriseNotice text={LIVE_SURPRISE} />
      ) : null}
      {r.kind === 'placed' ? (
        <>
          <Text variant="heading">Order placed</Text>
          <Text variant="mono" testID="order-result-id">{`Order ID ${r.orderid}`}</Text>
          {r.analyze ? <Badge testID="result-sandbox" label={SANDBOX} tone="analyze" /> : null}
          {p.placedStatus ? <PlacedStatus status={p.placedStatus} /> : null}
          {orderbook}
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
            <>
              {r.waitSec !== undefined ? (
                <Text testID="result-wait" tone="muted">
                  {waitText(r.waitSec)}
                </Text>
              ) : null}
              <Skeleton rows={1} />
            </>
          ) : (
            <Text testID="result-reconcile">{reconcileText(r.check)}</Text>
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
