import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { createProfileRepo } from '~/core/config/profile'
import { log } from '~/core/log/logger'
import { wireQueryManagers } from '~/core/query/wiring'
import { LiveContext } from '~/core/realtime/useLive'
import { TickStoreContext } from '~/core/realtime/useQuote'
import { defaultDeps } from '~/core/services/deps'
import {
  createServices,
  disposeServices,
  forgetStoredKey,
  type Services,
  ServicesProvider,
  useSession,
} from '~/core/services/services'
import { TradingProvider } from '~/market/trading'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { LockLayer, LockOverlay } from '~/ui/LockOverlay'
import { ToastHost } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'

const TAG = 'app'

export default function AppLayout() {
  // "Try again" remounts the shell, which builds a new container.
  const [attempt, setAttempt] = useState(0)
  return <ShellLoader key={attempt} onRetry={() => setAttempt((n) => n + 1)} />
}

function ShellLoader({ onRetry }: { onRetry: () => void }) {
  const shell = useActiveServices()
  if (shell.kind === 'failed') return <StartFailed onRetry={onRetry} profileId={shell.profileId} />
  if (shell.kind === 'loading') return null
  return <AppShell s={shell.services} />
}

type Shell =
  | { kind: 'loading' }
  | { kind: 'ready'; services: Services }
  | { kind: 'failed'; profileId: string | null }

/**
 * One container per saved profile, disposed when the group unmounts (sign-out, onboarding). A
 * failed start (the profile read, or building the container) is logged, hides the splash and
 * reports `failed`, so the screen offers a way on instead of a splash that never goes.
 */
function useActiveServices(): Shell {
  const [shell, setShell] = useState<Shell>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    let made: Services | null = null
    let profileId = useSession.getState().profileId
    const start = async () => {
      const profile = await createProfileRepo(defaultDeps.kv).load()
      if (!live) return
      if (!profile) {
        useSession.getState().set({ status: 'onboarding' })
        return
      }
      profileId = profile.id
      made = createServices(profile, defaultDeps)
      setShell({ kind: 'ready', services: made })
    }
    start().catch((e) => {
      log.error(TAG, 'could not start the app', e)
      if (!live) return
      void SplashScreen.hideAsync()
      setShell({ kind: 'failed', profileId })
    })
    return () => {
      live = false
      if (made) disposeServices(made)
      setShell({ kind: 'loading' })
    }
  }, [])
  return shell
}

/** The start failed: try again, or drop the key and set the server up afresh. */
function StartFailed({ onRetry, profileId }: { onRetry: () => void; profileId: string | null }) {
  const { c } = useTheme()
  const forget = () => {
    if (profileId) void forgetStoredKey(defaultDeps, profileId)
    else useSession.getState().set({ status: 'onboarding' })
  }
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: c.background }]}>
      <EmptyState
        title="OpenAlgo could not start"
        body="The saved settings for this server could not be loaded."
        action={
          <View style={styles.actions}>
            <Button testID="start-retry" title="Try again" onPress={onRetry} />
            <Button
              testID="start-forget"
              title="Forget key and set up again"
              variant="secondary"
              onPress={forget}
            />
          </View>
        }
      />
    </View>
  )
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
      <TradingProvider now={defaultDeps.now}>
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
                >
                  {/* Each task that adds a route declares its options here (search first). */}
                  <Stack.Screen
                    name="search"
                    options={{
                      presentation: 'modal',
                      headerShown: true,
                      title: 'Search',
                      headerStyle: { backgroundColor: c.background },
                      headerTintColor: c.foreground,
                      headerShadowVisible: false,
                    }}
                  />
                  <Stack.Screen
                    name="instrument/[key]"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [0.6, 1],
                      sheetGrabberVisible: true,
                    }}
                  />
                  <Stack.Screen
                    name="order/new"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [1],
                      sheetGrabberVisible: true,
                    }}
                  />
                  <Stack.Screen
                    name="order/[id]/modify"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [1],
                      sheetGrabberVisible: true,
                    }}
                  />
                  <Stack.Screen
                    name="gtt/new"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [1],
                      sheetGrabberVisible: true,
                    }}
                  />
                  <Stack.Screen
                    name="gtt/[id]/modify"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [1],
                      sheetGrabberVisible: true,
                    }}
                  />
                  <Stack.Screen
                    name="depth/[key]"
                    options={{
                      headerShown: true,
                      title: 'Market depth',
                      headerStyle: { backgroundColor: c.background },
                      headerTintColor: c.foreground,
                      headerShadowVisible: false,
                    }}
                  />
                </Stack>
                <ToastHost />
              </View>
              {locked ? (
                <LockLayer>
                  <LockOverlay
                    controller={s.lock}
                    onForgetKey={() => void s.lifecycle.forgetKey()}
                  />
                </LockLayer>
              ) : null}
            </LiveContext.Provider>
          </TickStoreContext.Provider>
        </QueryClientProvider>
      </TradingProvider>
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { justifyContent: 'center' },
  actions: { alignSelf: 'stretch', gap: 12 },
})
