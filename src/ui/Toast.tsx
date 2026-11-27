// A short message at the bottom for two seconds (four for a long one). `toast` can be called from
// anywhere; the host mounted once in the app shell shows it. A new toast replaces the one on
// screen. A screen reader hears each one: TalkBack through the live region, VoiceOver, which
// ignores live regions, through `announce`.
import { useEffect } from 'react'
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native'
import { create } from 'zustand'
import { Text } from './Text'
import { useTheme } from './theme'

export const TOAST_MS = 2000
/** A message longer than one short line stays this long, so it can be read. */
export const LONG_TOAST_MS = 4000
const toastMs = (text: string) => (text.length > 48 ? LONG_TOAST_MS : TOAST_MS)

type ToastState = { id: number; text: string | null }

const useToastStore = create<ToastState>(() => ({ id: 0, text: null }))

/**
 * Reads `text` out on iOS, where VoiceOver ignores `accessibilityLiveRegion`; Android's TalkBack
 * reads the live region, so announcing there too would say it twice.
 */
export function announce(text: string): void {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text)
}

export function toast(text: string): void {
  useToastStore.setState((s) => ({ id: s.id + 1, text }))
  announce(text)
}

/**
 * `hold` (the app is locked) keeps a toast off screen with its timer stopped, so one that came
 * under the lock, such as a refused link's at a cold start, shows for its full time after.
 */
export function ToastHost({ hold = false }: { hold?: boolean }) {
  const { id, text } = useToastStore()
  const { c } = useTheme()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` restarts the timer for a new toast
  useEffect(() => {
    if (text === null || hold) return
    const t = setTimeout(() => useToastStore.setState({ text: null }), toastMs(text))
    return () => clearTimeout(t)
  }, [id, text, hold])
  if (text === null || hold) return null
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View
        testID="toast"
        accessibilityLiveRegion="polite"
        style={[styles.pill, { backgroundColor: c.foreground }]}
      >
        <Text numberOfLines={4} style={{ color: c.background }}>
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
