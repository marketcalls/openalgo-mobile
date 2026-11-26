// What came of the order (design 7.10). Placed shows its id, the sandbox mark for an analyzer
// reply, and then its status as the order book shows it (a broker can reject a placed order a
// moment later); an order the server took LIVE after an ANALYZE review leads with the danger
// notice; queued points to the web Action Center; an unknown outcome says what the order book
// shows. Nothing here sends the order again: the way on is the order book.
import { StyleSheet, View } from 'react-native'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { CHECKING, NOT_CHECKED } from '~/market/orders/outcome'
import { LIVE_SURPRISE } from '~/market/orders/submit'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { type SplitPlaced, SplitResult } from './SplitResult'

/**
 * What the order book showed after an unknown outcome; `checked` false when it could not be read.
 * `earlier` when the book could not be read at the review, so a match found may be an earlier
 * identical order rather than this one (ruling 26): it is then never reported as this order.
 */
export type Reconcile =
  | { kind: 'single'; checked: boolean; status: string | null; earlier: boolean }
  | { kind: 'split'; checked: boolean; found: number; of: number; earlier: boolean }

/** `liveSurprise`: the review showed ANALYZE, but the server placed it LIVE (`Outcome`). */
export type TicketResult =
  | { kind: 'placed'; orderid: string; analyze: boolean; liveSurprise?: true }
  | { kind: 'queued' }
  | { kind: 'split'; reply: SplitPlaced; liveSurprise?: true }
  /**
   * It may have gone (MaybePlaced, a 5xx, a success without an id); `check` once the book says.
   * `waitSec`: how long the check may read, when the server may still be sending the order.
   */
  | { kind: 'maybe'; check: Reconcile | null; waitSec?: number }

/** Never "not placed": the server may still be sending it to the broker (design 7.10). */
const NOT_YET =
  'Not in the order book yet. The server may still be sending it, so check the order book before placing it again.'
const waitText = (sec: number) =>
  `The server may still be sending it to the broker, so this reads the order book for up to ${
    sec >= 90 ? `${Math.round(sec / 60)} minutes` : `${sec} s`
  }.`
const MAYBE_EARLIER =
  'A matching order is in the order book, but it may be an earlier one. Check the order book before trying again.'
const SANDBOX = 'Analyzer (sandbox)'

function reconciled(r: Reconcile): string {
  if (!r.checked) return NOT_CHECKED
  if (r.kind === 'split') {
    if (r.earlier && r.found > 0) {
      return `Found ${r.found} of ${r.of} matching orders in the order book, but they may be earlier ones. Check the order book before trying again.`
    }
    return r.found < r.of
      ? `Found ${r.found} of ${r.of} child orders in the order book. The server may still be sending the rest, so check the order book before placing any again.`
      : `Found ${r.found} of ${r.of} child orders in the order book.`
  }
  if (r.status === null) return NOT_YET
  return r.earlier ? MAYBE_EARLIER : `Found in the order book: ${r.status || '--'}`
}

/** After a LIVE order the review showed as ANALYZE, the toast's reason, after what it names. */
const SWITCHED = 'The server switched to LIVE after your review.'

/**
 * The result in one short line, for the toast once the sheet has gone while the order was out
 * (the toast shows one line). It says no more than the sheet would, and never less: a match that
 * may be an earlier order says so, and an order that went LIVE says LIVE first.
 */
export function resultLine(r: TicketResult): string {
  switch (r.kind) {
    case 'placed':
      if (r.liveSurprise) return `LIVE order placed: ${r.orderid}. ${SWITCHED}`
      return `${r.analyze ? 'Sandbox order' : 'Order'} placed: ${r.orderid}`
    case 'queued':
      return 'Order queued in the web Action Center'
    case 'split': {
      const placed = `${r.reply.children.filter((c) => c.ok).length} of ${r.reply.children.length} placed`
      return r.liveSurprise ? `LIVE split order: ${placed}. ${SWITCHED}` : `Split order: ${placed}`
    }
    case 'maybe': {
      const c = r.check
      if (c === null) return CHECKING
      if (!c.checked) return "Couldn't check the order book"
      if (c.kind === 'split') {
        if (c.earlier && c.found > 0) return `Unclear: ${c.found} of ${c.of} matches may be older`
        return c.found < c.of
          ? `Found ${c.found} of ${c.of} child orders; more may follow`
          : `Found ${c.found} of ${c.of} child orders`
      }
      if (c.status === null) return 'Not in the order book yet'
      return c.earlier
        ? 'Unclear: the match may be an older order'
        : `Found in the order book: ${c.status || '--'}`
    }
  }
}

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
