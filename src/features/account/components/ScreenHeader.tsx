import { Stack } from 'expo-router'
import { useTheme } from '~/ui/theme'

/** The back header the account sub-screens share (the app group's stack hides it by default). */
export function ScreenHeader({ title }: { title: string }) {
  const { c } = useTheme()
  return (
    <Stack.Screen
      options={{
        headerShown: true,
        title,
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.foreground,
        headerShadowVisible: false,
      }}
    />
  )
}
