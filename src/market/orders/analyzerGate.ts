// The analyzer mode an order write is checked against (design 7.10): `/api/v1/analyzer`, read
// before each write unless the last reading is under 5 s old. It shares useAnalyzer's query
// (ruling 5), so the header badge and the gate read one cache and never disagree.
import type { QueryClient } from '@tanstack/react-query'
import type { Api } from '~/core/http/api'
import { ApiError, isRecord } from '~/core/http/errors'
import { type Analyzer, AnalyzerSchema } from '~/core/http/schemas'
import { qk } from '~/core/query/keys'

export type AnalyzerMode = 'live' | 'analyze'

/** What an abandoned read rejects with: no reply in time, as the read lane names it. */
const noReply = () => new ApiError({ kind: 'Network', status: 0, endpoint: 'analyzer' })

/** `p`, or a Network rejection as soon as `signal` aborts (the request itself goes on). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(noReply())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function createAnalyzerGate({
  queryClient,
  pid,
  api,
  ttlMs = 5_000,
}: {
  queryClient: QueryClient
  pid: string
  api: Api
  ttlMs?: number
}) {
  const queryKey = qk.analyzer(pid)

  return {
    /**
     * The server's mode: the cached reading while it is under `ttlMs` old, else a fresh read,
     * never retried. `signal` abandons the wait with a Network error; a read already on its way
     * still lands in the cache.
     */
    read({ signal }: { signal?: AbortSignal } = {}): Promise<AnalyzerMode> {
      if (signal?.aborted) return Promise.reject(noReply())
      const fetch = queryClient
        .fetchQuery({
          queryKey,
          queryFn: () => api.call('analyzer', {}, AnalyzerSchema),
          staleTime: ttlMs,
          retry: false,
        })
        .then((d) => d.mode)
      return signal ? untilAborted(fetch, signal) : fetch
    },

    /** The last reading, however old; null before the first. Never calls the server. */
    peek(): AnalyzerMode | null {
      return queryClient.getQueryData<Analyzer>(queryKey)?.mode ?? null
    },

    /**
     * A reply that says `mode: 'analyze'` came from the sandbox, so the mode is ANALYZE as of now.
     * Any other reply proves nothing: a refusal carries no mode, and Semi-Auto says `semi_auto`.
     */
    noteReply(json: unknown): void {
      if (!isRecord(json) || json.mode !== 'analyze') return
      queryClient.setQueryData<Analyzer>(queryKey, (prev) => ({
        ...prev,
        mode: 'analyze',
        analyze_mode: true,
      }))
    },

    /**
     * Drops the reading at once, however fresh: the next `read` asks the server, and the header
     * badge (useAnalyzer, on the same query) reads again now. For a write the server answered
     * in a mode other than the one the reading gave.
     */
    invalidate(): void {
      void queryClient.invalidateQueries({ queryKey })
    },

    /**
     * A read whose reply shows the server's mode (the GTT book: the sandbox tags it, G3), when the
     * last reading says the other: the reading is dropped (`invalidate`), so the header badge, GTT
     * support and the next write ask the server now, not on the next foreground. It never sets the
     * mode itself, as `noteReply` does for a write: the read may have gone before the reading, and
     * a stale ANALYZE would let a write go live without the live confirm. Nothing before the first
     * reading.
     */
    noteMode(mode: AnalyzerMode): void {
      const shown = queryClient.getQueryData<Analyzer>(queryKey)?.mode
      if (shown !== undefined && shown !== mode) void queryClient.invalidateQueries({ queryKey })
    },
  }
}

export type AnalyzerGate = ReturnType<typeof createAnalyzerGate>
