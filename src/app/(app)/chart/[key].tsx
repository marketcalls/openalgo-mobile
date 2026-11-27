import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChartScreen } from '~/features/chart/screens/ChartScreen'
import { parseKey } from '~/market/links'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'

/**
 * The chart of `exchange:symbol`. The screen takes the key once: when the chart changes symbol it
 * sets the param itself, and keeps its page (no `key` prop, so no remount). The route has no
 * header, so a malformed link offers its own way back.
 */
export default function ChartRoute() {
  const router = useRouter()
  const { key } = useLocalSearchParams<{ key: string }>()
  const k = parseKey(key ?? '')
  if (!k) {
    return (
      <EmptyState
        title="This chart link is incomplete."
        action={
          <Button
            testID="chart-back"
            title="Back"
            variant="secondary"
            onPress={() => router.back()}
          />
        }
      />
    )
  }
  return <ChartScreen initial={k} />
}
