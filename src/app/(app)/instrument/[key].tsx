import { useLocalSearchParams } from 'expo-router'
import { InstrumentSheet } from '~/features/instrument/screens/InstrumentSheet'
import { parseKey } from '~/market/links'
import { EmptyState } from '~/ui/EmptyState'

/** The instrument sheet for `exchange:symbol`; a malformed link says so. */
export default function InstrumentRoute() {
  const { key } = useLocalSearchParams<{ key: string }>()
  const k = parseKey(key ?? '')
  if (!k) return <EmptyState title="This link is incomplete." />
  return <InstrumentSheet exchange={k.exchange} symbol={k.symbol} />
}
