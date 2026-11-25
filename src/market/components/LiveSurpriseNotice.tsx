// The danger notice for a write the server took LIVE after the user reviewed it in ANALYZE mode
// (`Outcome.liveSurprise`): a real order went to the broker, without the live confirm. Design
// 7.10 never lets the mode pass unsaid, so it shows above everything else on the screen, in the
// danger colours, and is read out at once.
import { Pressable, StyleSheet, View } from 'react-native'
import { useToneColors } from '~/ui/Badge'
import { Text } from '~/ui/Text'

export function LiveSurpriseNotice({
  text,
  onDismiss,
}: {
  text: string
  /** A screen that stays up after the write (the Orders tab) lets the user put it away. */
  onDismiss?: () => void
}) {
  const { bg, fg } = useToneColors('danger')
  return (
    <View
      testID="live-surprise"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.box, { backgroundColor: bg }]}
    >
      <Text style={[styles.text, { color: fg }]}>{text}</Text>
      {onDismiss ? (
        <Pressable
          testID="live-surprise-dismiss"
          accessibilityRole="button"
          onPress={onDismiss}
          hitSlop={8}
        >
          <Text style={[styles.action, { color: fg }]}>Dismiss</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 },
  text: { fontWeight: '700' },
  action: { fontWeight: '700', textDecorationLine: 'underline' },
})
