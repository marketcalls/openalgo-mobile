// The watchlist's sheets: manage the lists, choose the sort, and move a symbol to a group.
// The manage sheet asks for a name in place, never in a second sheet over it.
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { WATCH_SORTS, type WatchGroup, type WatchSort } from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import type { IconName } from '~/ui/Icon'
import { Sheet } from '~/ui/Sheet'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { EditButton } from './EditControls'
import { ListNameForm } from './ListTabs'

const RENAME: IconName = { ios: 'pencil', android: 'edit' }
const DELETE: IconName = { ios: 'trash', android: 'delete' }

export function ManageListsSheet(p: {
  lists: readonly { id: string; name: string }[]
  /** The name being asked for, shown in place of the lists. */
  naming: { key: string; title: string; initial: string } | null
  onMove: (id: string, by: -1 | 1) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
  onName: (name: string) => void
  onNameCancel: () => void
  onClose: () => void
}) {
  const last = p.lists.length - 1
  return (
    <Sheet visible onClose={p.onClose}>
      {p.naming ? (
        <ListNameForm
          key={p.naming.key}
          title={p.naming.title}
          initial={p.naming.initial}
          onSave={p.onName}
          onCancel={p.onNameCancel}
        />
      ) : (
        <View style={styles.body}>
          <Text variant="heading">Watchlists</Text>
          <ScrollView style={styles.scroll}>
            {p.lists.map((l, i) => (
              <View key={l.id} testID={`wl-list-${i}`} style={styles.row}>
                <Text numberOfLines={1} style={styles.name}>
                  {l.name}
                </Text>
                <EditButton
                  testID={`wl-list-up-${i}`}
                  glyph="↑"
                  label={`Move ${l.name} up`}
                  disabled={i === 0}
                  onPress={() => p.onMove(l.id, -1)}
                />
                <EditButton
                  testID={`wl-list-down-${i}`}
                  glyph="↓"
                  label={`Move ${l.name} down`}
                  disabled={i === last}
                  onPress={() => p.onMove(l.id, 1)}
                />
                <EditButton
                  testID={`wl-list-rename-${i}`}
                  icon={RENAME}
                  label={`Rename ${l.name}`}
                  onPress={() => p.onRename(l.id)}
                />
                <EditButton
                  testID={`wl-list-delete-${i}`}
                  icon={DELETE}
                  label={`Delete ${l.name}`}
                  // the last list stays (deleteList refuses it)
                  disabled={p.lists.length <= 1}
                  danger
                  onPress={() => p.onDelete(l.id)}
                />
              </View>
            ))}
          </ScrollView>
          <View style={styles.buttons}>
            <View style={styles.button}>
              <Button testID="wl-new" title="New list" variant="secondary" onPress={p.onNew} />
            </View>
            <View style={styles.button}>
              <Button testID="wl-manage-done" title="Done" onPress={p.onClose} />
            </View>
          </View>
        </View>
      )}
    </Sheet>
  )
}

export const SORT_LABELS: Record<WatchSort, string> = {
  added: 'As added',
  az: 'A–Z',
  change: '% change',
  ltp: 'LTP',
  exchange: 'Exchange',
}

/** The five sorts; a pick applies at once. */
export function SortSheet(p: {
  sort: WatchSort
  onPick: (sort: WatchSort) => void
  onClose: () => void
}) {
  return (
    <Sheet visible onClose={p.onClose}>
      <View style={styles.body}>
        <Text variant="heading">Sort by</Text>
        <View>
          {WATCH_SORTS.map((s) => (
            <Choice
              key={s}
              testID={`wl-sort-${s.toUpperCase()}`}
              label={SORT_LABELS[s]}
              checked={p.sort === s}
              onPress={() => p.onPick(s)}
            />
          ))}
        </View>
      </View>
    </Sheet>
  )
}

/** The list's groups, then "No group"; `current` is the symbol's group, if any. */
export function MoveToGroupSheet(p: {
  symbol: string
  groups: readonly WatchGroup[]
  current: string | undefined
  onPick: (groupId: string | null) => void
  onClose: () => void
}) {
  return (
    <Sheet visible onClose={p.onClose}>
      <View style={styles.body}>
        <Text variant="heading">Move {p.symbol} to</Text>
        <ScrollView style={styles.scroll}>
          {p.groups.map((g, i) => (
            <Choice
              key={g.id}
              testID={`wl-move-${i}`}
              label={g.name}
              checked={p.current === g.id}
              onPress={() => p.onPick(g.id)}
            />
          ))}
          <Choice
            testID="wl-move-none"
            label="No group"
            checked={p.current === undefined}
            onPress={() => p.onPick(null)}
          />
        </ScrollView>
      </View>
    </Sheet>
  )
}

function Choice(p: { testID: string; label: string; checked: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: p.checked }}
      onPress={p.onPress}
      style={[styles.choice, { borderBottomColor: c.border }]}
    >
      <Text style={styles.name} numberOfLines={1}>
        {p.label}
      </Text>
      {p.checked ? <Text>✓</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // shrinks with the sheet, so a long list scrolls inside it
  body: { gap: 12, flexShrink: 1 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  name: { flex: 1 },
  choice: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  buttons: { flexDirection: 'row', gap: 12 },
  button: { flex: 1 },
})
