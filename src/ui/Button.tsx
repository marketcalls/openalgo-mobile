import { ActivityIndicator, Pressable, StyleSheet } from 'react-native'
import { tapLight } from '~/core/platform/haptics'
import { Text } from './Text'
import { useTheme } from './theme'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'buy' | 'sell'

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
}: {
  title: string
  onPress: () => void
  variant?: ButtonVariant
  loading?: boolean
  disabled?: boolean
  testID?: string
}) {
  const { c, trade } = useTheme()
  const colors = {
    primary: { bg: c.primary, fg: c.primaryForeground },
    secondary: { bg: c.secondary, fg: c.secondaryForeground },
    destructive: { bg: c.destructive, fg: '#ffffff' },
    buy: { bg: trade.buy, fg: trade.onBuy },
    sell: { bg: trade.sell, fg: trade.onSell },
  }[variant]
  const inactive = disabled || loading
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        if (inactive) return
        tapLight()
        onPress()
      }}
      style={[styles.button, { backgroundColor: colors.bg }, inactive && styles.inactive]}
    >
      {loading ? (
        <ActivityIndicator color={colors.fg} />
      ) : (
        <Text style={[styles.label, { color: colors.fg }]}>{title}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontWeight: '600' },
  inactive: { opacity: 0.5 },
})
