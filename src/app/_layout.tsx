import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { usePrefs } from '~/core/config/prefs'
import { applyPrivacy } from '~/core/platform/privacy'
import { defaultDeps } from '~/core/services/deps'
import { bootSession, useSession } from '~/core/services/services'
import { ThemeProvider, useTheme } from '~/ui/theme'

// Held until boot decides where to go; the app group releases it after its first unlock.
void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const status = useSession((s) => s.status)
  const hideContentAndroid = usePrefs((s) => s.hideContentAndroid)

  useEffect(() => {
    void bootSession(defaultDeps)
  }, [])

  useEffect(() => {
    void applyPrivacy({ hideContentAndroid })
  }, [hideContentAndroid])

  useEffect(() => {
    if (status === 'onboarding') void SplashScreen.hideAsync()
  }, [status])

  if (status === 'loading') return null

  // No GestureHandlerRootView yet: nothing in M1 uses a gesture, and gesture-handler bundles
  // Reanimated, about 1.3 MB of Hermes bytecode, which breaks the 4.34 MB budget (design 12).
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <RootStack />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

/** Exactly one group is reachable: the app once a key is saved, onboarding until then. */
function RootStack() {
  const status = useSession((s) => s.status)
  const { c } = useTheme()
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.background } }}>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'onboarding'}>
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
    </Stack>
  )
}
