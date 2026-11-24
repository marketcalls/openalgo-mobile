import { Stack } from 'expo-router'
import { defaultDeps } from '~/core/services/deps'
import { OnboardingProvider } from '~/features/onboarding/context'
import { COPY } from '~/features/onboarding/copy'
import { useTheme } from '~/ui/theme'

/** The onboarding steps (design 7.1), sharing one draft until the server is saved. */
export default function OnboardingLayout() {
  const { c } = useTheme()
  return (
    <OnboardingProvider deps={defaultDeps}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.foreground,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="server" options={{ title: 'Connect to OpenAlgo' }} />
        <Stack.Screen name="update" options={{ title: COPY.tooOld }} />
        <Stack.Screen name="key" options={{ title: 'API key' }} />
        <Stack.Screen name="feed" options={{ title: 'Live feed' }} />
        <Stack.Screen name="help" options={{ title: COPY.setupHelp }} />
      </Stack>
    </OnboardingProvider>
  )
}
