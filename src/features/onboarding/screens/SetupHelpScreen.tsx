// What works on which OpenAlgo setup, and the lines that fix the common ones (design 7.1).
// Onboarding and the app's polling banner both open it.
import { ScrollView, StyleSheet, View } from 'react-native'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ENV_LINES, HELP } from '../copy'

export function SetupHelpScreen() {
  const { c } = useTheme()
  const code = [styles.code, { backgroundColor: c.muted, color: c.foreground }]
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text variant="heading">What works where</Text>
      {HELP.matrix.map((row) => (
        <View key={row.setup} style={[styles.card, { borderColor: c.border }]}>
          <Text style={styles.setup}>{row.setup}</Text>
          <Text variant="caption" tone="muted">{`Server: ${row.rest}`}</Text>
          <Text variant="caption" tone="muted">{`Live feed: ${row.feed}`}</Text>
          <Text variant="caption">{row.note}</Text>
        </View>
      ))}

      <Text variant="heading">OpenAlgo on your PC</Text>
      <Text>{HELP.envIntro}</Text>
      {ENV_LINES.map((line) => (
        <Text key={line} variant="mono" style={code}>
          {line}
        </Text>
      ))}
      <Text>{HELP.dockerRun}</Text>

      <Text variant="heading">Tunnels</Text>
      <Text>{HELP.tunnels}</Text>
      <Text>{HELP.cloudflaredIntro}</Text>
      <Text variant="mono" style={code}>
        {HELP.cloudflaredRule}
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 12, gap: 2 },
  setup: { fontWeight: '600' },
  code: { borderRadius: 6, padding: 8 },
})
