import { Text as RNText, StyleSheet, type TextProps } from 'react-native'
import { useTheme } from './theme'

export type TextVariant = 'title' | 'heading' | 'body' | 'caption' | 'mono'
export type TextTone = 'default' | 'muted' | 'profit' | 'loss'

export function Text({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: TextProps & { variant?: TextVariant; tone?: TextTone }) {
  const { c, trade } = useTheme()
  const color = {
    default: c.foreground,
    muted: c.mutedForeground,
    profit: trade.profit,
    loss: trade.loss,
  }[tone]
  return <RNText {...rest} style={[styles[variant], { color }, style]} />
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '700' },
  heading: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 15 },
  caption: { fontSize: 12 },
  mono: { fontSize: 15, fontVariant: ['tabular-nums'] },
})
