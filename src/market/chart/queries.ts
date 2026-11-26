// The chart's two native reads (design 7.9): the session calendar and the interval list. Both are
// kept for the whole app session: the default 5 minute gcTime would refetch a chart reopened later.
import { useQuery } from '@tanstack/react-query'
import { qk } from '~/core/query/keys'
import { istDate } from '~/core/realtime/marketHours'
import { useServices } from '~/core/services/services'
import { type Calendars, loadCalendars } from './calendar'
import { chartIntervals } from './intervals'
import { IntervalsSchema } from './schemas'

const FIVE_MINUTES = 300_000
const DAY = 24 * 60 * 60_000

/**
 * Every exchange's calendar for today in IST: read once per IST day, or again after 5 minutes
 * when it fell back to defaults.
 */
export function useSessionCalendars(): Calendars | undefined {
  const { api, profile } = useServices()
  const day = istDate(Date.now())
  const q = useQuery({
    queryKey: qk.calendar(profile.get().id, day),
    queryFn: () => loadCalendars(api, Date.now()),
    staleTime: (query) =>
      query.state.data?.source === 'defaults' ? FIVE_MINUTES : Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })
  return q.data
}

/** The interval codes to offer; undefined while the first read is out, the fallback if it failed. */
export function useChartIntervals(polling: boolean): string[] | undefined {
  const { api, profile } = useServices()
  const q = useQuery({
    queryKey: qk.intervals(profile.get().id),
    queryFn: () => api.call('intervals', {}, IntervalsSchema),
    staleTime: DAY,
    gcTime: Number.POSITIVE_INFINITY,
  })
  if (q.data) return chartIntervals(q.data, polling)
  return q.isError ? chartIntervals(null, polling) : undefined
}
