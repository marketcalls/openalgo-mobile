// Symbol search (C1): rows carry the instrument fields, so each result also warms the metadata
// cache and the sheet it opens needs no `/symbol` call.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { type Instrument, SearchSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import { useTrading } from '~/market/trading'

export const MIN_QUERY = 2
export const MAX_QUERY = 40
export const DEBOUNCE_MS = 300
export const MAX_RESULTS = 100

/** Trimmed, single-spaced, upper case, at most 40 characters. */
export const normalizeQuery = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').toUpperCase().slice(0, MAX_QUERY)

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function useSymbolSearch(
  raw: string,
  exchange?: string,
): {
  rows: readonly Instrument[]
  /** The query is long enough to search. */
  ready: boolean
  /** Waiting on the debounce or on the first answer for this query. */
  loading: boolean
  error: unknown
  retry: () => void
} {
  const s = useServices()
  const { instruments } = useTrading()
  const pid = s.profile.get().id
  const q = normalizeQuery(raw)
  const settled = useDebounced(q, DEBOUNCE_MS)
  const ready = q.length >= MIN_QUERY
  const query = useQuery({
    queryKey: qk.search(pid, settled, exchange),
    queryFn: async () => {
      const body = exchange ? { query: settled, exchange } : { query: settled }
      const rows = (await s.api.call('search', body, SearchSchema)).slice(0, MAX_RESULTS)
      // the cache is a convenience: rows show without waiting for its write
      instruments.putMany(rows).catch((e) => log.warn('search', 'could not cache results', e))
      return rows
    },
    enabled: settled.length >= MIN_QUERY,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  return {
    rows: ready ? (query.data ?? []) : [],
    ready,
    loading: ready && (settled !== q || (query.isPending && !query.isError)),
    error: ready && settled === q ? query.error : null,
    retry: () => void query.refetch(),
  }
}
