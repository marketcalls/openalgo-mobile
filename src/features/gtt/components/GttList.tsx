// The Orders tab's GTT segment (design 17.3): the GTT book, read when the segment shows (and on
// focus, after a write's poke, and on a pull), never on a timer (design 12). A tap on a GTT opens
// Modify (the GTT ticket) and Cancel. While the broker is blocked the book shows what was last
// read, dimmed, and nothing can be sent. The last write's notices are the tab's (ruling 29).
import { type Href, useRouter } from 'expo-router'
import { useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { DroppedNote } from '~/market/components/DroppedNote'
import { StaleNote } from '~/market/components/StaleNote'
import { useGttBook } from '~/market/gtt/queries'
import { gttModifyHref } from '~/market/links'
import { onGtt, useScopesOut } from '~/market/orders/pending'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { type GttWrites, rowMeta } from '../hooks/useGttWrites'
import { GttActions, GttRow } from './GttRow'

export const GTT_NOT_READ = "The GTT book can't be read right now."

export function GttList({ writes }: { writes: GttWrites }) {
  const router = useRouter()
  const trading = useTrading()
  const blocked = useBrokerBlocked()
  const q = useGttBook()
  // A write still out on a GTT (a modify sheet's that went, or this tab's cancel) holds its
  // Modify and Cancel until its outcome is known, whichever screen sent it.
  const out = useScopesOut(trading)
  const [expanded, setExpanded] = useState<string | null>(null)
  const data = q.data

  if (data === undefined) {
    if (blocked) return <EmptyState title={GTT_NOT_READ} />
    if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    return <Skeleton />
  }
  const stale = blocked || q.isRefetchError
  return (
    <View style={styles.fill}>
      <DroppedNote dropped={data.dropped} />
      {stale ? <StaleNote at={q.dataUpdatedAt} /> : null}
      <View testID="gtt-list" style={[styles.fill, { opacity: stale ? 0.5 : 1 }]}>
        <FlatList
          data={data.rows}
          extraData={`${expanded}|${blocked}|${writes.busy}|${[...out].join(',')}`}
          keyExtractor={(r) => r.triggerId}
          renderItem={({ item: r }) => {
            const open = expanded === r.triggerId
            const pending = out.has(onGtt(r.triggerId))
            return (
              <GttRow
                row={r}
                meta={rowMeta(trading.instruments, r)}
                expanded={open}
                onPress={() => setExpanded((e) => (e === r.triggerId ? null : r.triggerId))}
              >
                {open ? (
                  <GttActions
                    row={r}
                    pending={pending}
                    disabled={blocked || writes.busy || pending}
                    onModify={() => router.push(gttModifyHref(r.triggerId) as Href)}
                    onCancel={() => writes.cancel(r)}
                  />
                ) : null}
              </GttRow>
            )
          }}
          ListEmptyComponent={
            <View testID="gtt-empty">
              <EmptyState title="No GTTs" />
            </View>
          }
          // Blocked, a read would only fail: the book stays as it was last read.
          refreshing={q.isRefetching}
          onRefresh={blocked ? undefined : () => void q.refetch()}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
