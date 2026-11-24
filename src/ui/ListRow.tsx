import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { useTheme } from './theme'

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  testID,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  onPress?: () => void
  testID?: string
}) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={[styles.row, { borderBottomColor: c.border }]}
    >
      <View style={styles.main}>
        <Text>{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1, gap: 2 },
})
