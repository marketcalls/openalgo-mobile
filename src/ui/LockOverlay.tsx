import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native'
import type { LockController } from '~/core/credentials/lock'
import { tokens } from './tokens'

/**
 * An opaque full-screen cover, rendered as the last sibling over the app while it is locked. It
 * prompts once on mount; after a cancelled prompt the button tries again.
 */
export function LockOverlay({ controller }: { controller: LockController }) {
  const t = useColorScheme() === 'dark' ? tokens.dark : tokens.light

  useEffect(() => {
    void controller.unlock()
  }, [controller])

  return (
    <View
      testID="lock-overlay"
      accessibilityViewIsModal
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: t.background }]}
    >
      <Text style={[styles.title, { color: t.foreground }]}>OpenAlgo is locked</Text>
      <Pressable
        testID="lock-unlock"
        accessibilityRole="button"
        onPress={() => void controller.unlock()}
        style={[styles.button, { backgroundColor: t.primary }]}
      >
        <Text style={[styles.label, { color: t.primaryForeground }]}>Unlock</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  cover: { alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24, zIndex: 1000 },
  title: { fontSize: 20, fontWeight: '600' },
  button: {
    minWidth: 160,
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  label: { fontSize: 16, fontWeight: '600' },
})
