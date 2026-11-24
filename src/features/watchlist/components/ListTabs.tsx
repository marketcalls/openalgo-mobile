// The named lists as tabs: a press shows one, a long press offers Rename and Delete, and `+`
// starts a new one. `ListNameSheet` asks for a name (Alert.prompt is iOS only).
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { WATCHLIST_LIMITS } from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import { Sheet } from '~/ui/Sheet'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const MENU_ACTION = [{ name: 'longpress', label: 'Rename or delete' }]

export function ListTabs(p: {
  lists: readonly { id: string; name: string }[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onMenu: (id: string) => void
  onNew: () => void
}) {
  const { c } = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.tabs}
    >
      {p.lists.map((l) => {
        const selected = l.id === p.activeId
        return (
          <Pressable
            key={l.id}
            testID={`wl-tab-${l.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityActions={MENU_ACTION}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'longpress') p.onMenu(l.id)
            }}
            onPress={() => p.onSelect(l.id)}
            onLongPress={() => p.onMenu(l.id)}
            style={[
              styles.tab,
              { borderColor: c.border, backgroundColor: selected ? c.primary : c.background },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.label, { color: selected ? c.primaryForeground : c.foreground }]}
            >
              {l.name}
            </Text>
          </Pressable>
        )
      })}
      <Pressable
        testID="wl-new"
        accessibilityRole="button"
        accessibilityLabel="New list"
        onPress={p.onNew}
        style={[styles.tab, { borderColor: c.border }]}
      >
        <Text style={styles.label}>+</Text>
      </Pressable>
    </ScrollView>
  )
}

/** Asks for a list name (1–30 characters); mount it to show it, so each opening starts afresh. */
export function ListNameSheet(p: {
  title: string
  initial: string
  onSave: (name: string) => void
  onClose: () => void
}) {
  const { c } = useTheme()
  const [name, setName] = useState(p.initial)
  const ok = name.trim().length > 0
  const save = () => {
    if (ok) p.onSave(name)
  }
  return (
    <Sheet visible onClose={p.onClose}>
      <View style={styles.sheet}>
        <Text variant="heading">{p.title}</Text>
        <TextInput
          testID="wl-name-input"
          autoFocus
          value={name}
          onChangeText={setName}
          maxLength={WATCHLIST_LIMITS.nameMax}
          placeholder="List name"
          placeholderTextColor={c.mutedForeground}
          returnKeyType="done"
          onSubmitEditing={save}
          style={[styles.input, { color: c.foreground, borderColor: c.border }]}
        />
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button
              testID="wl-name-cancel"
              title="Cancel"
              variant="secondary"
              onPress={p.onClose}
            />
          </View>
          <View style={styles.button}>
            <Button testID="wl-name-save" title="Save" disabled={!ok} onPress={save} />
          </View>
        </View>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, flexShrink: 1 },
  tabs: { alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  tab: {
    minHeight: 36,
    maxWidth: 180,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 999,
  },
  label: { fontWeight: '600' },
  sheet: { gap: 16 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 12 },
  button: { flex: 1 },
})
