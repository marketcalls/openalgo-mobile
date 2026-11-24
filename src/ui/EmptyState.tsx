import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from './Text'

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <View style={styles.wrap}>
      <Text variant="heading">{title}</Text>
      {body ? <Text tone="muted">{body}</Text> : null}
      {action}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 12, padding: 24 },
})
