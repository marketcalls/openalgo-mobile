// The review before every order (design 7.10): the order as it will be sent, how it splits, and
// the mode the server is in now, LIVE or ANALYZE. Confirm sends it, in the side's colour.
import { StyleSheet, View } from 'react-native'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import type { Side } from '~/market/types'
import { useToneColors } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'

export const MODE_LABEL: Record<AnalyzerMode, string> = { live: 'LIVE', analyze: 'ANALYZE' }

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
}) {
  return (
    <View style={styles.wrap} testID="ticket-review-step">
      <View style={styles.modeRow}>
        <Text variant="heading">Review</Text>
        {p.mode ? <ModeBadge mode={p.mode} /> : null}
      </View>
      <Text variant="mono" testID="review-summary">
        {p.summary}
      </Text>
      {p.split ? (
        <Text testID="review-split">{`Sent as ${p.split.orders} orders: ${p.split.breakdown}`}</Text>
      ) : null}
      {p.notice ? (
        <Text testID="review-notice" tone="loss">
          {p.notice}
        </Text>
      ) : null}
      {p.readError !== undefined ? (
        <ErrorState error={p.readError} onRetry={p.onRetryRead} />
      ) : p.mode === null ? (
        <Skeleton rows={1} />
      ) : null}
      {p.sending && p.splitWaitSec !== undefined ? (
        <Text variant="caption" tone="muted">
          {`A split order can take up to ${p.splitWaitSec} s.`}
        </Text>
      ) : null}
      <Button
        testID="ticket-confirm"
        title={`Place ${p.side} order`}
        variant={p.side === 'BUY' ? 'buy' : 'sell'}
        loading={p.sending}
        disabled={p.mode === null || p.blocked}
        onPress={p.onConfirm}
      />
      <Button
        testID="ticket-back"
        title="Back"
        variant="secondary"
        disabled={p.sending}
        onPress={p.onBack}
      />
    </View>
  )
}

/**
 * LIVE in the danger colours, ANALYZE in the analyzer's. It looks like a Badge but carries its id
 * on the label, so a Maestro flow reads the id and the text from one node.
 */
function ModeBadge({ mode }: { mode: AnalyzerMode }) {
  const { bg, fg } = useToneColors(mode === 'live' ? 'danger' : 'analyze')
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text testID="review-mode-badge" variant="caption" style={[styles.badgeLabel, { color: fg }]}>
        {MODE_LABEL[mode]}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeLabel: { fontWeight: '700' },
})
