// What came of the GTT write (design 7.10). Placed or modified shows its trigger id, marked when
// the sandbox answered; one the server took LIVE after an ANALYZE review leads with the danger
// notice; queued points to the web Action Center; an unknown outcome says what the GTT book shows.
// Nothing here sends the GTT again: the way on is the GTT list.
import { StyleSheet, View } from 'react-native'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import type { GttChange } from '~/market/gtt/reconcile'
import type { GttRow } from '~/market/gtt/schemas'
import { CHECKING, sandboxed } from '~/market/orders/outcome'
import type { Reconciled } from '~/market/orders/reconcile'
import { liveSurpriseText } from '~/market/orders/submit'
import { Button } from '~/ui/Button'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'

/** `liveSurprise`: the review showed ANALYZE, but the server took it LIVE (`Outcome`). */
export type GttResult =
  | { kind: 'ok'; triggerId: string; analyze: boolean; liveSurprise?: true }
  | { kind: 'queued' }
  /** It may have gone: `line` once the GTT book says, null while it is read. */
  | { kind: 'maybe'; line: string | null }

const NOT_CHECKED = "Couldn't check the GTT book. Check it before trying again."

/**
 * What the GTT book showed after a placement whose outcome is unknown. `earlier` when the book
 * could not be read at the review: a match may then be an identical GTT from before, and is
 * never reported as this one.
 */
export function placementLine(r: Reconciled<GttRow | null> | null, earlier: boolean): string {
  if (!r?.checked) return NOT_CHECKED
  if (r.found === null) {
    return 'The GTT book does not show it. Check the GTT list before trying again.'
  }
  if (earlier) {
    return 'A matching GTT is in the GTT book, but it may be an earlier one. Check the GTT list before trying again.'
  }
  return `The GTT book shows it: ${r.found.status || '--'}.`
}

/** What the GTT book showed after a modify whose outcome is unknown. */
export function changeLine(r: Reconciled<GttChange> | null): string {
  if (!r?.checked) return NOT_CHECKED
  switch (r.found) {
    case 'applied':
      return 'The GTT book shows the change.'
    case 'unchanged':
      return 'The GTT book still shows the old values. Check it before trying again.'
    case 'gone':
      return 'The GTT is no longer active.'
  }
}

/** The result in the one line a toast holds, once the sheet has gone while the GTT was out. */
export function gttResultLine(r: GttResult, modify: boolean): string {
  const done = modify ? 'GTT modified' : 'GTT placed'
  switch (r.kind) {
    case 'ok':
      return r.liveSurprise
        ? `LIVE ${done}: ${r.triggerId}. The server switched to LIVE after your review.`
        : sandboxed(`${done}: ${r.triggerId}`, r.analyze)
    case 'queued':
      return 'GTT queued in the web Action Center'
    case 'maybe':
      return r.line ?? CHECKING
  }
}

export function GttResultView(p: {
  result: GttResult
  modify: boolean
  onDone: () => void
  onViewList: () => void
  onOpenActionCenter: () => void
}) {
  const { result: r } = p
  const list = (
    <Button
      testID="gtt-view-list"
      title="View in GTT list"
      variant="secondary"
      onPress={p.onViewList}
    />
  )
  return (
    <View style={styles.wrap}>
      {r.kind === 'ok' && r.liveSurprise ? (
        <LiveSurpriseNotice text={liveSurpriseText(p.modify ? 'gttModify' : 'gttPlace')} />
      ) : null}
      {r.kind === 'ok' ? (
        <>
          <Text variant="heading" testID="gtt-result">
            {sandboxed(p.modify ? 'GTT modified' : 'GTT placed', r.analyze)}
          </Text>
          <Text variant="mono" testID="gtt-result-id">{`Trigger ID ${r.triggerId}`}</Text>
          {list}
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
      ) : (
        <>
          <Text variant="heading">{CHECKING}</Text>
          {r.line === null ? <Skeleton rows={1} /> : <Text>{r.line}</Text>}
          {list}
        </>
      )}
      <Button testID="gtt-done" title="Done" onPress={p.onDone} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
})
