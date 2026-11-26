// The named lists as Kite's tab strip: a press shows one, the active one is underlined, a long
// press offers Rename and Delete, and the trailing button manages the lists (design 17.1).
// `ListNameSheet` asks for a name (Alert.prompt is iOS only).
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { WATCHLIST_LIMITS } from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import { Icon, type IconName } from '~/ui/Icon'
import { Sheet } from '~/ui/Sheet'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const MENU_ACTION = [{ name: 'longpress', label: 'Rename or delete' }]
const MANAGE: IconName = { ios: 'list.bullet', android: 'list' }

export function ListTabs(p: {
  lists: readonly { id: string; name: string }[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onMenu: (id: string) => void
  onManage: () => void
}) {
  const { c } = useTheme()
  return (
    <View style={[styles.bar, { borderBottomColor: c.border }]}>
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
              style={[styles.tab, { borderBottomColor: selected ? c.primary : 'transparent' }]}
            >
              <Text
                numberOfLines={1}
                style={[styles.label, { color: selected ? c.foreground : c.mutedForeground }]}
              >
                {l.name}
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
      <Pressable
        testID="wl-manage"
        accessibilityRole="button"
        accessibilityLabel="Manage watchlists"
        onPress={p.onManage}
        hitSlop={4}
        style={styles.manage}
      >
        <Icon name={MANAGE} size={20} color={c.foreground} />
      </Pressable>
    </View>
  )
}

type NameProps = {
  title: string
  initial: string
  placeholder?: string
  onSave: (name: string) => void
}

/** Asks for a name (1–30 characters); mount it to show it, so each opening starts afresh. */
export function ListNameSheet(p: NameProps & { onClose: () => void }) {
  return (
    <Sheet visible onClose={p.onClose}>
      <ListNameForm {...p} onCancel={p.onClose} />
    </Sheet>
  )
}

/** The name form itself, for a sheet that shows it in place of its own content. */
export function ListNameForm(p: NameProps & { onCancel: () => void }) {
  const { c } = useTheme()
  const [name, setName] = useState(p.initial)
  const ok = name.trim().length > 0
  const save = () => {
    if (ok) p.onSave(name)
  }
  return (
    <View style={styles.sheet}>
      <Text variant="heading">{p.title}</Text>
      <TextInput
        testID="wl-name-input"
        autoFocus
        value={name}
        onChangeText={setName}
        maxLength={WATCHLIST_LIMITS.nameMax}
        placeholder={p.placeholder ?? 'List name'}
        placeholderTextColor={c.mutedForeground}
        returnKeyType="done"
        onSubmitEditing={save}
        style={[styles.input, { color: c.foreground, borderColor: c.border }]}
      />
      <View style={styles.buttons}>
        <View style={styles.button}>
          <Button testID="wl-name-cancel" title="Cancel" variant="secondary" onPress={p.onCancel} />
        </View>
        <View style={styles.button}>
          <Button testID="wl-name-save" title="Save" disabled={!ok} onPress={save} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: { flexGrow: 1, flexShrink: 1 },
  tabs: { alignItems: 'stretch', paddingHorizontal: 8 },
  tab: {
    minHeight: 44,
    maxWidth: 180,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 2,
  },
  label: { fontWeight: '600' },
  manage: { width: 48, alignItems: 'center', justifyContent: 'center' },
  sheet: { gap: 16 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 12 },
  button: { flex: 1 },
})
