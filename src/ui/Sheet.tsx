import type { ReactNode } from 'react'
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from './theme'

/**
 * A page sheet on iOS; on Android a card at the bottom over a dimmed backdrop. While it is not
 * `dismissible` (a write on its way), the backdrop and Android's back do nothing; an iOS page
 * sheet is never swiped away (the Modal's allowSwipeDismissal is off).
 */
export function Sheet({
  visible,
  onClose,
  dismissible = true,
  children,
}: {
  visible: boolean
  onClose: () => void
  dismissible?: boolean
  children?: ReactNode
}) {
  const { c } = useTheme()
  const ios = Platform.OS === 'ios'
  const close = dismissible ? onClose : noop
  return (
    <Modal
      visible={visible}
      onRequestClose={close}
      animationType="slide"
      presentationStyle={ios ? 'pageSheet' : undefined}
      transparent={!ios}
      onDismiss={onClose}
    >
      {ios ? (
        <View style={[styles.page, { backgroundColor: c.background }]}>{children}</View>
      ) : (
        <View style={styles.backdrop}>
          <Pressable
            testID="sheet-backdrop"
            accessibilityLabel="Close"
            style={StyleSheet.absoluteFill}
            onPress={close}
          />
          <View style={[styles.card, { backgroundColor: c.card }]}>{children}</View>
        </View>
      )}
    </Modal>
  )
}

const noop = () => {}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000080' },
  card: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '90%' },
})
