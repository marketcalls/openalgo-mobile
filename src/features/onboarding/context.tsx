// What the onboarding screens share while the group is mounted: the deps, the saved profile (its
// URL prefills the form), and each step's result. The key lives here, in React state only, until
// it is saved; it is never put in a store, a URL or a log.
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { Capabilities } from '~/core/capabilities/gates'
import { createProfileRepo, type ServerProfile } from '~/core/config/profile'
import { log } from '~/core/log/logger'
import type { BrokerSession } from '~/core/services/connection'
import type { AppDeps } from '~/core/services/services'

export type OnboardingDeps = Pick<
  AppDeps,
  'fetch' | 'WebSocketImpl' | 'kv' | 'secureKV' | 'uuid' | 'now' | 'allowDevHosts'
>

export type Draft = {
  /** The saved profile, kept after sign-out: its id, URLs and http ack are reused. */
  existing: ServerProfile | null
  httpAcked: boolean
  /** From the server step. */
  server?: { url: string; host: string; caps: Capabilities }
  /** The version a too-old server reported, if any. */
  tooOldVersion?: string | null
  /** From the key step. */
  key?: { key: string; broker: string | null; brokerSession: BrokerSession }
}

type OnboardingContextValue = {
  deps: OnboardingDeps
  draft: Draft
  update: (patch: Partial<Draft>) => void
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null)

/** Renders nothing until the saved profile has been read. */
export function OnboardingProvider({
  deps,
  children,
}: {
  deps: OnboardingDeps
  children: ReactNode
}) {
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => {
    let live = true
    createProfileRepo(deps.kv)
      .load()
      .catch((e) => {
        log.warn('onboarding', 'could not read the saved profile', e)
        return null
      })
      .then((existing) => {
        if (live) setDraft({ existing, httpAcked: existing?.httpWarningAcked ?? false })
      })
    return () => {
      live = false
    }
  }, [deps.kv])

  if (!draft) return null
  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  return (
    <OnboardingContext.Provider value={{ deps, draft, update }}>
      {children}
    </OnboardingContext.Provider>
  )
}

export function useOnboarding(): OnboardingContextValue {
  const v = useContext(OnboardingContext)
  if (!v) throw new Error('OnboardingProvider is missing')
  return v
}
