// The server's mode where an order write is reviewed before it goes (design 7.10): the ticket's
// review and the modify sheet.
import { StyleSheet, View } from 'react-native'
import { useToneColors } from '~/ui/Badge'
import { Text } from '~/ui/Text'
import type { AnalyzerMode } from '../orders/analyzerGate'
import { MODE_LABEL } from '../orders/confirmWrite'

/**
 * LIVE in the danger colours, ANALYZE in the analyzer's. It looks like a Badge but carries its id
 * on the label, so a Maestro flow reads the id and the text from one node.
 */
export function ModeBadge({ mode, testID }: { mode: AnalyzerMode; testID: string }) {
  const { bg, fg } = useToneColors(mode === 'live' ? 'danger' : 'analyze')
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text testID={testID} variant="caption" style={[styles.label, { color: fg }]}>
        {MODE_LABEL[mode]}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  label: { fontWeight: '700' },
})
