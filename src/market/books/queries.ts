// Account-book queries. Only funds so far; later tasks add the books beside it.
import { useQuery } from '@tanstack/react-query'
import { FundsSchema } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import { useBrokerBlocked } from '../session'

/**
 * The funds figures. It fetches only while `enabled` (a screen that shows them is open) and
 * nothing is blocked (broker logged out, key refused or IP banned).
 */
export function useFunds({ enabled }: { enabled: boolean }) {
  const { api, profile } = useServices()
  const pid = profile.get().id
  const blocked = useBrokerBlocked()
  return useQuery({
    queryKey: qk.funds(pid),
    queryFn: () => api.call('funds', {}, FundsSchema),
    staleTime: 10_000,
    enabled: enabled && !blocked,
  })
}
