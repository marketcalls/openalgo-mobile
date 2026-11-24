import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { createProfileRepo } from '~/core/config/profile'
import { wireQueryManagers } from '~/core/query/wiring'
import { LiveContext } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { defaultDeps } from '~/core/services/deps'
import {
  createServices,
  disposeServices,
  type Services,
  ServicesProvider,
  useSession,
} from '~/core/services/services'
import { LockOverlay } from '~/ui/LockOverlay'
import { useTheme } from '~/ui/theme'

export default function AppLayout() {
  const services = useActiveServices()
  if (!services) return null
  return <AppShell s={services} />
}

/** One container per saved profile, disposed when the group unmounts (sign-out, onboarding). */
function useActiveServices(): Services | null {
  const [services, setServices] = useState<Services | null>(null)
  useEffect(() => {
    let live = true
    let made: Services | null = null
    void createProfileRepo(defaultDeps.kv)
      .load()
      .then((profile) => {
        if (!live) return
        if (!profile) {
          useSession.getState().set({ status: 'onboarding' })
          return
        }
        made = createServices(profile, defaultDeps)
        setServices(made)
      })
    return () => {
      live = false
      if (made) disposeServices(made)
      setServices(null)
    }
  }, [])
  return services
}

function AppShell({ s }: { s: Services }) {
  const { c } = useTheme()
  const locked = useSyncExternalStore(s.lock.subscribe, s.lock.isLocked)
  const live = { realtime: s.realtime, polling: s.polling, store: s.store }

  // The overlay starts the first unlock on mount; the splash stays up until it settles, so the
  // locked screen never flashes before the prompt (ruling 5).
  useEffect(() => {
    void s.lock.unlock().finally(() => void SplashScreen.hideAsync())
  }, [s])

  return (
    <ServicesProvider value={s}>
      <QueryClientProvider client={s.queryClient}>
        <TickStoreContext.Provider value={s.store}>
          <LiveContext.Provider value={live}>
            <Lifecycle s={s} />
            {/* TalkBack would read through the overlay without this (iOS uses its modal flag). */}
            <View
              style={styles.fill}
              importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
            >
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: c.background },
                }}
              />
            </View>
            {locked ? (
              <LockOverlay controller={s.lock} onForgetKey={() => void s.lifecycle.forgetKey()} />
            ) : null}
          </LiveContext.Provider>
        </TickStoreContext.Provider>
      </QueryClientProvider>
    </ServicesProvider>
  )
}

/** The cold start once, then every AppState change, for this container. */
function Lifecycle({ s }: { s: Services }) {
  useEffect(() => {
    const unwire = wireQueryManagers()
    void s.lifecycle.coldStart()
    const sub = AppState.addEventListener('change', (next) => void s.lifecycle.appState(next))
    return () => {
      sub.remove()
      unwire()
    }
  }, [s])
  return null
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
