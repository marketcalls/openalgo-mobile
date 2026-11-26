import { useLocalSearchParams } from 'expo-router'
import { ModifySheet } from '~/features/orders/screens/ModifySheet'
import { EmptyState } from '~/ui/EmptyState'

/** The modify sheet for the order a `modifyHref` link names. */
export default function ModifyOrderRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  if (!id) return <EmptyState title="This link is incomplete." />
  // another order is another sheet, never the last one's state
  return <ModifySheet key={id} orderid={id} />
}
