import { StyleSheet } from 'react-native'
import { istClock } from '~/core/realtime/marketHours'
import { Text } from '~/ui/Text'

const pad = (n: number) => String(n).padStart(2, '0')

/** "Last updated 14:32:05" (IST): shown under cached data that can no longer refresh. */
export function StaleNote({ at }: { at: number }) {
  const { hh, mm, ss } = istClock(at)
  return (
    <Text testID="stale-note" variant="caption" tone="muted" style={styles.note}>
      {`Last updated ${pad(hh)}:${pad(mm)}:${pad(ss)}`}
    </Text>
  )
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingVertical: 6 },
})
