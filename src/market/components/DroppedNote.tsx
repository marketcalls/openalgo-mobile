import { StyleSheet } from 'react-native'
import { Text } from '~/ui/Text'

/** Review Focus 4: book rows that could not be read were left out; the rest still show. */
export function DroppedNote({ dropped }: { dropped: number }) {
  if (dropped <= 0) return null
  return (
    <Text testID="books-dropped" variant="caption" tone="muted" style={styles.note}>
      {dropped === 1 ? '1 row could not be read' : `${dropped} rows could not be read`}
    </Text>
  )
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingVertical: 6 },
})
