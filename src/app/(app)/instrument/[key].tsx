import { useLocalSearchParams, useRouter } from 'expo-router'
import { InstrumentSheet } from '~/features/instrument/screens/InstrumentSheet'
import { parseKey } from '~/market/links'
import { BottomSheet } from '~/ui/BottomSheet'
import { EmptyState } from '~/ui/EmptyState'

/**
 * The instrument sheet for `exchange:symbol`. The route is a transparent modal, so a malformed
 * link says so in a sheet of its own, which closes as the instrument sheet does.
 */
export default function InstrumentRoute() {
  const router = useRouter()
  const { key } = useLocalSearchParams<{ key: string }>()
  const k = parseKey(key ?? '')
  if (!k) {
    return (
      <BottomSheet testID="instrument-sheet" onClose={router.back} header={null}>
        <EmptyState title="This link is incomplete." />
      </BottomSheet>
    )
  }
  return <InstrumentSheet exchange={k.exchange} symbol={k.symbol} />
}
