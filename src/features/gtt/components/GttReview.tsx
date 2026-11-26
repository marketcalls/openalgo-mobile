// The review before every GTT write (design 7.10): the GTT as it will be sent, and the mode the
// server is in now, LIVE or ANALYZE. Confirm waits for that mode and for the GTT book, and sends
// it, in the side's colour.
import { StyleSheet, View } from 'react-native'
import { ModeBadge } from '~/market/components/ModeBadge'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import type { Side } from '~/market/types'
import { Button } from '~/ui/Button'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'

/** Another GTT ticket's write on the same GTT (or a new one) has an outcome not known yet. */
export const GTT_OTHER_OUT =
  "An earlier GTT's outcome isn't known yet. This one can be sent once it is."

/** The outcome of an earlier GTT write whose sheet had gone, which only a toast carried. */
export const earlierGtt = (line: string) => `Your earlier GTT: ${line}`

export function GttReview(p: {
  /** `gttSummary`'s one line. */
  summary: string
  side: Side
  /** A modify of a GTT in the book, not a new one. */
  modify: boolean
  /** Null while the mode is being read. */
  mode: AnalyzerMode | null
  /** The mode read failed: nothing can be confirmed until it works. */
  readError?: unknown
  onRetryRead: () => void
  /** The GTT book is being read for this review: confirm waits for it. */
  bookPending: boolean
  otherOut: boolean
  earlier: string | null
  /** Why the review is shown again: the mode changed, or the live check did not pass. */
  notice?: string
  sending: boolean
  /** Nothing may be sent: the broker is logged out, or the last confirm is cooling down. */
  blocked: boolean
  onConfirm: () => void
  onBack: () => void
}) {
  return (
    <View style={styles.wrap} testID="gtt-review-step">
      <View style={styles.modeRow}>
        <Text variant="heading">{p.modify ? 'Review the change' : 'Review GTT'}</Text>
        {p.mode ? <ModeBadge mode={p.mode} testID="gtt-mode-badge" /> : null}
      </View>
      <Text variant="mono" testID="gtt-summary">
        {p.summary}
      </Text>
      {p.notice ? <Text tone="loss">{p.notice}</Text> : null}
      {p.readError !== undefined ? (
        <ErrorState error={p.readError} onRetry={p.onRetryRead} />
      ) : p.mode === null || p.bookPending ? (
        <Skeleton rows={1} />
      ) : null}
      {p.earlier !== null ? <Text>{earlierGtt(p.earlier)}</Text> : null}
      {p.otherOut ? <Text tone="muted">{GTT_OTHER_OUT}</Text> : null}
      <Button
        testID="gtt-confirm"
        title={`${p.modify ? 'Modify' : 'Place'} ${p.side} GTT`}
        variant={p.side === 'BUY' ? 'buy' : 'sell'}
        loading={p.sending}
        disabled={p.mode === null || p.bookPending || p.otherOut || p.blocked}
        onPress={p.onConfirm}
      />
      <Button
        testID="gtt-back"
        title="Back"
        variant="secondary"
        disabled={p.sending}
        onPress={p.onBack}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
})
