import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native'
import { FullWindowOverlay } from 'react-native-screens'
import type { LockController } from '~/core/credentials/lock'
import { tokens } from './tokens'

/**
 * Where the lock cover is drawn. On iOS a presented sheet (the ticket, modify, instrument and
 * search screens) is a view controller above the React Native root, so a cover inside the root
 * is drawn beneath it, and the sheet, with its order and prices, stays visible and tappable over
 * "locked". FullWindowOverlay puts the cover in a window above every presented one. Android
 * presents those screens inside the root, so the cover, the root's last child, is already on top.
 */
export function LockLayer({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'ios') return <>{children}</>
  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{children}</FullWindowOverlay>
  )
}

/**
 * An opaque full-screen cover, rendered as the last sibling over the app while it is locked. It
 * prompts once on mount; after a cancelled prompt the button tries again. When the stored key
 * cannot be read even after a retry, it offers `onForgetKey`.
 *
 * While an attempt runs (the prompt is up, or the key is being read) the cover is blank: the
 * title and the button appear only once an attempt has failed, so "locked" never flashes behind
 * the first prompt, a re-lock's prompt, or an unlock that needs no prompt (ruling 5).
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
  // Mounting starts an attempt, so the cover starts blank.
  const [pending, setPending] = useState(true)

  const unlock = useCallback(() => {
    setPending(true)
    void controller.unlock().then((ok) => {
      // On success the shell drops the cover; showing the button first would flash it.
      if (ok) return
      if (controller.keyUnreadable()) setUnreadable(true)
      setPending(false)
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
      {pending ? null : (
        <>
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
              <Text style={[styles.link, { color: t.foreground }]}>
                Forget key and set up again
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
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
