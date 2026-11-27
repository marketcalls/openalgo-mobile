// The review before every order (design 7.10): the order as it will be sent, how it splits, and
// the mode the server is in now, LIVE or ANALYZE. Confirm sends it, in the side's colour. The
// ticket shows it as it is; a sheet with its own head and a fixed footer (a tool's held order)
// gives it its title, its own ids and a footer of its own.
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { ModeBadge } from '~/market/components/ModeBadge'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import type { Side } from '~/market/types'
import { Button } from '~/ui/Button'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'

export const OTHER_OUT =
  "An earlier order's outcome isn't known yet. This one can be sent once it is."

/** The outcome of an earlier order whose sheet had gone, which only a toast carried. */
export const earlierOutcome = (line: string) => `Your earlier order: ${line}`

/** The review's test ids; the ticket's by default. */
export type ReviewIds = {
  step: string
  mode: string
  summary: string
  split: string
  notice: string
  earlier: string
  wait: string
  confirm: string
  back: string
}

const TICKET_IDS: ReviewIds = {
  step: 'ticket-review-step',
  mode: 'review-mode-badge',
  summary: 'review-summary',
  split: 'review-split',
  notice: 'review-notice',
  earlier: 'review-earlier',
  wait: 'review-wait',
  confirm: 'ticket-confirm',
  back: 'ticket-back',
}

export function ReviewStep(p: {
  /** `ticketSummary`'s one line. */
  summary: string
  /** The split, when the order goes out as several: "1,755 + 65". */
  split: { orders: number; breakdown: string } | null
  side: Side
  /** Null while the mode is being read. */
  mode: AnalyzerMode | null
  /** The mode read failed: nothing can be confirmed until it works. */
  readError?: unknown
  onRetryRead: () => void
  /** The order book is being read for this review (ruling 26): confirm waits for it. */
  bookPending: boolean
  /** Another ticket's order has an outcome not known yet: nothing is sent until it is. */
  otherOut: boolean
  /** That order's outcome once known, when its own sheet had gone and only a toast said it. */
  earlier: string | null
  /** Why the review is shown again: the mode changed, or the live check did not pass. */
  notice?: string
  /** The confirm is in flight. */
  sending: boolean
  /** While sending a split: how long it may take before its outcome is unknown, in seconds. */
  splitWaitSec?: number
  /** Nothing may be sent: the broker is logged out, or the last confirm is cooling down. */
  blocked: boolean
  onConfirm: () => void
  onBack: () => void
  /** Ids in place of the ticket's, by name. */
  ids?: Partial<ReviewIds>
  /** In place of the "Review" heading; the mode badge stays beside it. */
  title?: ReactNode
  /**
   * In place of the Confirm and Back buttons: a sheet that keeps them in a fixed footer of its
   * own passes null.
   */
  footer?: ReactNode
}) {
  const ids = { ...TICKET_IDS, ...p.ids }
  return (
    <View style={styles.wrap} testID={ids.step}>
      <View style={styles.modeRow}>
        {p.title ?? <Text variant="heading">Review</Text>}
        {p.mode ? <ModeBadge mode={p.mode} testID={ids.mode} /> : null}
      </View>
      <Text variant="mono" testID={ids.summary}>
        {p.summary}
      </Text>
      {p.split ? (
        <Text testID={ids.split}>{`Sent as ${p.split.orders} orders: ${p.split.breakdown}`}</Text>
      ) : null}
      {p.notice ? (
        <Text testID={ids.notice} tone="loss">
          {p.notice}
        </Text>
      ) : null}
      {p.readError !== undefined ? (
        <ErrorState error={p.readError} onRetry={p.onRetryRead} />
      ) : p.mode === null || p.bookPending ? (
        <Skeleton rows={1} />
      ) : null}
      {p.earlier !== null ? <Text testID={ids.earlier}>{earlierOutcome(p.earlier)}</Text> : null}
      {p.otherOut ? (
        <Text testID={ids.wait} tone="muted">
          {OTHER_OUT}
        </Text>
      ) : null}
      {p.sending && p.splitWaitSec !== undefined ? (
        <Text variant="caption" tone="muted">
          {`A split order can take up to ${p.splitWaitSec} s.`}
        </Text>
      ) : null}
      {p.footer !== undefined ? (
        p.footer
      ) : (
        <>
          <Button
            testID={ids.confirm}
            title={`Place ${p.side} order`}
            variant={p.side === 'BUY' ? 'buy' : 'sell'}
            loading={p.sending}
            disabled={!canConfirm(p)}
            onPress={p.onConfirm}
          />
          <Button
            testID={ids.back}
            title="Back"
            variant="secondary"
            disabled={p.sending}
            onPress={p.onBack}
          />
        </>
      )}
    </View>
  )
}

/** Confirm waits for the mode and the book, for another order's outcome, and while blocked. */
export const canConfirm = (p: {
  mode: AnalyzerMode | null
  bookPending: boolean
  otherOut: boolean
  blocked: boolean
}) => p.mode !== null && !p.bookPending && !p.otherOut && !p.blocked

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
})
