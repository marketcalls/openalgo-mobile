// Lost phone (design 7.2): the two steps that cut a lost phone off, in the order that works.
import { ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '~/ui/Text'
import { ScreenHeader } from '../components/ScreenHeader'

export const LOST_PHONE_STEPS = [
  {
    title: 'Regenerate the API key on the OpenAlgo web',
    body: 'This breaks other API clients, such as scripts and strategies, until each is updated with the new key.',
  },
  {
    title: 'Log out of the broker, or restart OpenAlgo',
    body: 'Live-feed sessions that are already open stay connected until the broker session ends or the server restarts.',
  },
] as const

export function LostPhoneScreen() {
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <ScreenHeader title="Lost phone" />
      <Text tone="muted">
        Signing out on this app only removes the key from this phone. To cut a lost phone off, do
        these two steps in order.
      </Text>
      {LOST_PHONE_STEPS.map((step, i) => (
        <View key={step.title} style={styles.step} testID={`lost-step-${i + 1}`}>
          <Text variant="heading">{`${i + 1}. ${step.title}`}</Text>
          <Text>{step.body}</Text>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  step: { gap: 4 },
})
