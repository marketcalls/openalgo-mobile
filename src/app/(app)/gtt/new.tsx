import { useLocalSearchParams } from 'expo-router'
import { GttTicketScreen } from '~/features/gtt'
import { gttHref, parseGttParams } from '~/market/links'
import { EmptyState } from '~/ui/EmptyState'

/** The GTT ticket for a `gttHref` link; params that do not parse say so. */
export default function NewGttRoute() {
  const params = parseGttParams(useLocalSearchParams())
  if (!params) return <EmptyState title="This GTT link is incomplete." />
  // a different link is a different ticket, never the last one's state
  return <GttTicketScreen key={gttHref(params)} mode={{ kind: 'new', params }} />
}
