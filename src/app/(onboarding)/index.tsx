import { Redirect } from 'expo-router'

// The app opens at `/`; onboarding starts at the server step.
export default function OnboardingIndex() {
  return <Redirect href="/server" />
}
