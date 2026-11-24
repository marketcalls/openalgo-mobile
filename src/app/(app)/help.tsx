import { Stack } from 'expo-router'
import { COPY } from '~/features/onboarding/copy'
import { SetupHelpScreen } from '~/features/onboarding/screens/SetupHelpScreen'
import { useTheme } from '~/ui/theme'

/** The polling banner's "Setup help". */
export default function AppSetupHelp() {
  const { c } = useTheme()
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: COPY.setupHelp,
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.foreground,
          headerShadowVisible: false,
        }}
      />
      <SetupHelpScreen />
    </>
  )
}
