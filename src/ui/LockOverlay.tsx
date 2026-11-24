import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native'
import type { LockController } from '~/core/credentials/lock'
import { tokens } from './tokens'

/**
 * An opaque full-screen cover, rendered as the last sibling over the app while it is locked. It
 * prompts once on mount; after a cancelled prompt the button tries again. When the stored key
 * cannot be read even after a retry, it offers `onForgetKey`.
 */
export function LockOverlay({
  controller,
  onForgetKey,
}: {
  controller: LockController
  onForgetKey?: () => void
}) {
  const t = useColorScheme() === 'dark' ? tokens.dark : tokens.light
  const [unreadable, setUnreadable] = useState(false)

  const unlock = useCallback(() => {
    void controller.unlock().then((ok) => {
      if (!ok && controller.keyUnreadable()) setUnreadable(true)
    })
  }, [controller])

  useEffect(() => {
    unlock()
  }, [unlock])

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
        onPress={unlock}
        style={[styles.button, { backgroundColor: t.primary }]}
      >
        <Text style={[styles.label, { color: t.primaryForeground }]}>Unlock</Text>
      </Pressable>
      {unreadable && onForgetKey ? (
        <Pressable
          testID="lock-forget"
          accessibilityRole="button"
          onPress={onForgetKey}
          hitSlop={8}
        >
          <Text style={[styles.link, { color: t.foreground }]}>Forget key and set up again</Text>
        </Pressable>
      ) : null}
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
  link: { fontSize: 16, textDecorationLine: 'underline' },
})
