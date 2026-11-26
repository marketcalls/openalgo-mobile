import { useLocalSearchParams } from 'expo-router'
import { ModifySheet } from '~/features/orders/screens/ModifySheet'
import { parseModifyParams } from '~/market/links'
import { EmptyState } from '~/ui/EmptyState'

/** The modify sheet for the order a `modifyHref` link names. */
export default function ModifyOrderRoute() {
  const raw = useLocalSearchParams()
  const id = raw.id
  const preset = parseModifyParams(raw)
  if (typeof id !== 'string' || !id || !preset) {
    return <EmptyState title="This link is incomplete." />
  }
  const { source, ...fill } = preset
  // another order, or another preset, is another sheet, never the last one's state
  return (
    <ModifySheet
      key={`${id}|${fill.price ?? ''}|${fill.trigger_price ?? ''}|${source ?? ''}`}
      orderid={id}
      preset={fill}
      source={source}
    />
  )
}
