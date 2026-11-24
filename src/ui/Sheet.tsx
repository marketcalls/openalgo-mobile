import type { ReactNode } from 'react'
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { useTheme } from './theme'

/** A page sheet on iOS; on Android a card at the bottom over a dimmed backdrop. */
export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean
  onClose: () => void
  children?: ReactNode
}) {
  const { c } = useTheme()
  const ios = Platform.OS === 'ios'
  return (
    <Modal
      visible={visible}
      onRequestClose={onClose}
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
            onPress={onClose}
          />
          <View style={[styles.card, { backgroundColor: c.card }]}>{children}</View>
        </View>
      )}
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000080' },
  card: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '90%' },
})
