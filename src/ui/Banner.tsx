import { Pressable, StyleSheet, View } from 'react-native'
import { type Tone, useToneColors } from './Badge'
import { Text } from './Text'

export function Banner({
  tone,
  text,
  action,
  testID,
}: {
  tone: Tone
  text: string
  action?: { label: string; onPress: () => void }
  testID?: string
}) {
  const { bg, fg } = useToneColors(tone)
  return (
    <View testID={testID} style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: fg }]}>{text}</Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={8}>
          <Text style={[styles.action, { color: fg }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  text: { flex: 1 },
  action: { fontWeight: '700', textDecorationLine: 'underline' },
})
