import { useLocalSearchParams } from 'expo-router'
import { GttTicketScreen } from '~/features/gtt'
import { EmptyState } from '~/ui/EmptyState'

/** The GTT ticket modifying the GTT a `gttModifyHref` link names. */
export default function ModifyGttRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  if (!id) return <EmptyState title="This link is incomplete." />
  // another GTT is another sheet, never the last one's state
  return <GttTicketScreen key={id} mode={{ kind: 'modify', triggerId: id }} />
}
