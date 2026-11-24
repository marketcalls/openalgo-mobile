// One short line at the bottom for two seconds. `toast` can be called from anywhere; the host
// mounted once in the app shell shows it. A new toast replaces the one on screen.
import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { create } from 'zustand'
import { Text } from './Text'
import { useTheme } from './theme'

export const TOAST_MS = 2000

type ToastState = { id: number; text: string | null }

const useToastStore = create<ToastState>(() => ({ id: 0, text: null }))

export function toast(text: string): void {
  useToastStore.setState((s) => ({ id: s.id + 1, text }))
}

export function ToastHost() {
  const { id, text } = useToastStore()
  const { c } = useTheme()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` restarts the timer for a new toast
  useEffect(() => {
    if (text === null) return
    const t = setTimeout(() => useToastStore.setState({ text: null }), TOAST_MS)
    return () => clearTimeout(t)
  }, [id, text])
  if (text === null) return null
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View
        testID="toast"
        accessibilityLiveRegion="polite"
        style={[styles.pill, { backgroundColor: c.foreground }]}
      >
        <Text numberOfLines={1} style={{ color: c.background }}>
          {text}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, bottom: 48, alignItems: 'center' },
  pill: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '100%' },
})
