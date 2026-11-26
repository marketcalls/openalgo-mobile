import { useLocalSearchParams } from 'expo-router'
import { TicketScreen } from '~/features/order/screens/TicketScreen'
import { parseTicketParams, ticketHref } from '~/market/links'
import { EmptyState } from '~/ui/EmptyState'

/** The order ticket for a `ticketHref` link; params that do not parse say so. */
export default function NewOrderRoute() {
  const params = parseTicketParams(useLocalSearchParams())
  if (!params) return <EmptyState title="This order link is incomplete." />
  // a different link is a different ticket, never the last one's state
  return <TicketScreen key={ticketHref(params)} params={params} />
}
