import { StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { useTheme } from './theme'

export type Tone = 'neutral' | 'warning' | 'danger' | 'analyze'

/** Background and text colours for a tone, shared by Badge and Banner. */
export function useToneColors(tone: Tone): { bg: string; fg: string } {
  const { c, status, analyzer } = useTheme()
  switch (tone) {
    case 'warning':
      return { bg: status.warning, fg: status.onWarning }
    case 'danger':
      return { bg: c.destructive, fg: '#ffffff' }
    case 'analyze':
      return { bg: analyzer.primary, fg: analyzer.primaryForeground }
    default:
      return { bg: c.muted, fg: c.mutedForeground }
  }
}

export function Badge({ label, tone, testID }: { label: string; tone: Tone; testID?: string }) {
  const { bg, fg } = useToneColors(tone)
  return (
    <View testID={testID} style={[styles.badge, { backgroundColor: bg }]}>
      <Text variant="caption" style={[styles.label, { color: fg }]}>
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  label: { fontWeight: '700' },
})
