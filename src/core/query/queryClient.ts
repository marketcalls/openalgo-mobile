import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '~/core/http/errors'

/**
 * Reads retry twice at most, and only on Network or Server. A non-JSON 401/403/404
 * (an nginx or Cloudflare page) is classified Server but must never be retried.
 */
export const shouldRetryQuery = (failures: number, e: unknown): boolean =>
  failures < 2 &&
  e instanceof ApiError &&
  (e.kind === 'Network' || e.kind === 'Server') &&
  ![401, 403, 404].includes(e.status)

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 300_000,
        refetchOnWindowFocus: true,
        retry: shouldRetryQuery,
      },
      mutations: { retry: 0 },
    },
  })
