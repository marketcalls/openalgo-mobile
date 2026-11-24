// Account's server calls (design 7.2, 7.3): the analyzer mode, read on foreground and switched
// with a confirmation. The mode is install-wide, so the web app and strategies change with it.
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert } from 'react-native'
import { usePrefs } from '~/core/config/prefs'
import { confirmLiveWrite } from '~/core/credentials/lock'
import { ApiError, userMessage } from '~/core/http/errors'
import { AnalyzerSchema } from '~/core/http/schemas'
import { log } from '~/core/log/logger'
import { qk } from '~/core/query/keys'
import { useConnection } from '~/core/services/connection'
import { defaultDeps } from '~/core/services/deps'
import { useServices } from '~/core/services/services'

export type AnalyzerMode = 'live' | 'analyze'

export const ANALYZER_COPY = {
  live: {
    title: 'Switch to LIVE?',
    message:
      'This switches the whole OpenAlgo install to live trading, including the web app and your running strategies.',
    confirm: 'Switch to LIVE',
  },
  analyze: {
    title: 'Switch to ANALYZE?',
    message:
      'This switches the whole OpenAlgo install to the analyzer (sandbox), including the web app and your running strategies.',
    confirm: 'Switch to ANALYZE',
  },
} as const

export const TOGGLE_FAILED = 'Could not switch the mode. Try again.'

/** A native confirm: true when the user taps the confirm button. */
export function confirmAction(o: {
  title: string
  message: string
  confirmLabel: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      o.title,
      o.message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: o.confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

/**
 * The server's analyzer mode, asked again on every foreground (stale after 5 s), and written to
 * `conn.analyzer` for the header badge. An error reads as `unknown`. Mounted by the tabs layout.
 */
export function useAnalyzer(): AnalyzerMode | 'unknown' {
  const s = useServices()
  const pid = s.profile.get().id
  const locked = useSyncExternalStore(s.lock.subscribe, s.lock.isLocked)
  const q = useQuery({
    queryKey: qk.analyzer(pid),
    queryFn: () => s.api.call('analyzer', {}, AnalyzerSchema),
    staleTime: 5_000,
    // the key is in memory only while unlocked
    enabled: !locked,
  })
  const mode: AnalyzerMode | 'unknown' = q.isError || !q.data ? 'unknown' : q.data.mode
  useEffect(() => {
    useConnection.getState().set({ analyzer: mode })
  }, [mode])
  return mode
}

export function useToggleAnalyzer(): {
  toggle: (to: AnalyzerMode) => Promise<void>
  pending: boolean
  error: string | null
} {
  const s = useServices()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const toggle = useCallback(
    async (to: AnalyzerMode) => {
      if (busy.current) return
      busy.current = true
      setError(null)
      try {
        const c = ANALYZER_COPY[to]
        if (!(await confirmAction({ title: c.title, message: c.message, confirmLabel: c.confirm })))
          return
        if (
          to === 'live' &&
          !(await confirmLiveWrite({
            enabled: usePrefs.getState().confirmLiveWrites,
            authenticate: defaultDeps.lock.authenticate,
          }))
        )
          return
        setPending(true)
        try {
          await s.api.call('analyzer/toggle', { mode: to === 'analyze' }, AnalyzerSchema)
          s.books.poke()
        } catch (e) {
          log.warn('account', 'analyzer toggle failed', e)
          setError(e instanceof ApiError ? userMessage(e) : TOGGLE_FAILED)
        } finally {
          void s.queryClient.invalidateQueries({ queryKey: qk.analyzer(s.profile.get().id) })
          setPending(false)
        }
      } finally {
        busy.current = false
      }
    },
    [s],
  )
  return { toggle, pending, error }
}
