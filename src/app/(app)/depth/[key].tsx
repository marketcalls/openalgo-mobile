import { useLocalSearchParams } from 'expo-router'
import { DepthScreen } from '~/features/depth/screens/DepthScreen'
import { parseKey } from '~/market/links'
import { EmptyState } from '~/ui/EmptyState'

/** Quote and market depth for `exchange:symbol`; a malformed link says so. */
export default function DepthRoute() {
  const { key } = useLocalSearchParams<{ key: string }>()
  const k = parseKey(key ?? '')
  if (!k) return <EmptyState title="This link is incomplete." />
  return <DepthScreen exchange={k.exchange} symbol={k.symbol} />
}
