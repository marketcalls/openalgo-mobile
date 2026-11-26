// The chart's two native reads (design 7.9): the session calendar and the interval list. Both are
// kept for the whole app session: the default 5 minute gcTime would refetch a chart reopened later.
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Api } from '~/core/http/api'
import { qk } from '~/core/query/keys'
import { istDate } from '~/core/realtime/marketHours'
import { useServices } from '~/core/services/services'
import { type Calendars, IST_OFFSET_MS, loadCalendars } from './calendar'
import { chartIntervals } from './intervals'
import { IntervalsSchema } from './schemas'

const FIVE_MINUTES = 300_000
const DAY = 24 * 60 * 60_000

type ChartApi = Pick<Api, 'call'>

/** The calendar query's options, shared by the hook and the compat cache check (ruling 34). */
export const sessionCalendarsQuery = (api: ChartApi, pid: string, day: string) => ({
  queryKey: qk.calendar(pid, day),
  // Noon IST of the key's own day, so the entry always holds that day's calendar.
  queryFn: () => loadCalendars(api, Date.parse(`${day}T12:00:00Z`) - IST_OFFSET_MS),
  staleTime: (query: { state: { data?: Calendars } }) =>
    query.state.data?.source === 'defaults' ? FIVE_MINUTES : Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
})

/** The interval list's query options, shared by the hook and the compat cache check (ruling 34). */
export const chartIntervalsQuery = (api: ChartApi, pid: string) => ({
  queryKey: qk.intervals(pid),
  queryFn: () => api.call('intervals', {}, IntervalsSchema),
  staleTime: DAY,
  gcTime: Number.POSITIVE_INFINITY,
})

/**
 * Every exchange's calendar for today in IST: read once per IST day, or again after 5 minutes
 * when it fell back to defaults.
 */
export function useSessionCalendars(): Calendars | undefined {
  const { api, profile } = useServices()
  const q = useQuery(sessionCalendarsQuery(api, profile.get().id, istDate(Date.now())))
  return q.data
}

/** The interval codes to offer; undefined while the first read is out, the fallback if it failed. */
export function useChartIntervals(polling: boolean): readonly string[] | undefined {
  const { api, profile } = useServices()
  const q = useQuery(chartIntervalsQuery(api, profile.get().id))
  const { data, isError } = q
  // Stable between renders: a bridge push or effect keyed on the list must not fire every render.
  return useMemo(() => {
    if (data) return chartIntervals(data, polling)
    return isError ? chartIntervals(null, polling) : undefined
  }, [data, isError, polling])
}
