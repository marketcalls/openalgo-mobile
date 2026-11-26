// The funds figures (design 7.6): refetched every `POLL_RATES.funds` while the segment is in
// front and nothing is blocked; a blocked screen shows what it last read, dimmed.
import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import type { Funds } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'
import { POLL_RATES } from '~/core/realtime/polling'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import { useFunds } from '~/market/books/queries'
import { StaleNote } from '~/market/components/StaleNote'
import { useBrokerBlocked } from '~/market/session'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { fmtPrice } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

type Field = keyof Funds

const ROWS: readonly { id: string; label: string; field: Field }[] = [
  { id: 'cash', label: 'Available cash', field: 'availablecash' },
  { id: 'collateral', label: 'Collateral', field: 'collateral' },
  { id: 'm2m-unrealised', label: 'Unrealised M2M', field: 'm2munrealized' },
  { id: 'm2m-realised', label: 'Realised M2M', field: 'm2mrealized' },
  { id: 'margin-used', label: 'Used margin', field: 'utiliseddebits' },
]

export function FundsView() {
  const { c } = useTheme()
  const s = useServices()
  const blocked = useBrokerBlocked()
  const active = useScreenActive()
  const q = useFunds({ enabled: true })
  const pid = s.profile.get().id
  const on = active && !blocked

  useEffect(() => {
    if (!on) return
    return s.polling.register(
      {
        kind: 'custom',
        intervalMs: () => POLL_RATES.funds,
        run: async () => {
          await s.queryClient.invalidateQueries({ queryKey: qk.funds(pid) })
        },
      },
      true,
    )
  }, [on, s, pid])

  if (q.data === undefined) {
    if (blocked) return <EmptyState title="The funds can't be read right now." />
    if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
    return <Skeleton />
  }
  const stale = blocked || q.isRefetchError
  return (
    <View testID="funds-view" style={styles.fill}>
      {stale ? <StaleNote at={q.dataUpdatedAt} /> : null}
      <View style={{ opacity: stale ? 0.5 : 1 }}>
        {ROWS.map((r) => (
          <View key={r.id} style={[styles.row, { borderBottomColor: c.border }]}>
            <Text tone="muted" style={styles.label}>
              {r.label}
            </Text>
            <Text variant="mono" testID={`funds-${r.id}`}>
              {fmtPrice(q.data[r.field])}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { flex: 1 },
})
