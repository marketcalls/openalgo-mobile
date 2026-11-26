// A group's section header in the list: its name and how many symbols it holds. In edit mode it
// moves the group up or down and offers Rename and Delete; `NewGroupRow` ends edit mode's list.
import { Pressable, StyleSheet, View } from 'react-native'
import type { WatchGroup } from '~/market/watchlists/model'
import type { IconName } from '~/ui/Icon'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { GROUP_HEIGHT, NEW_GROUP_HEIGHT } from '../rows'
import { EditButton } from './EditControls'

const MENU: IconName = { ios: 'ellipsis', android: 'more_horiz' }

export function GroupHeader(p: {
  group: WatchGroup
  /** Its place among the list's groups, the testIDs' `{N}`. */
  index: number
  count: number
  editing: boolean
  last: boolean
  onMove: (groupId: string, by: -1 | 1) => void
  onMenu: (groupId: string) => void
}) {
  const { c } = useTheme()
  const { group, index } = p
  return (
    <View
      testID={`wl-group-${index}`}
      style={[styles.row, { backgroundColor: c.muted, borderBottomColor: c.border }]}
    >
      <Text accessibilityRole="header" numberOfLines={1} style={styles.name}>
        {group.name}
      </Text>
      <Text variant="caption" tone="muted" style={styles.count}>
        {p.count}
      </Text>
      {p.editing ? (
        <>
          <EditButton
            testID={`wl-group-up-${index}`}
            glyph="↑"
            label={`Move group ${group.name} up`}
            disabled={index === 0}
            style={styles.control}
            onPress={() => p.onMove(group.id, -1)}
          />
          <EditButton
            testID={`wl-group-down-${index}`}
            glyph="↓"
            label={`Move group ${group.name} down`}
            disabled={p.last}
            style={styles.control}
            onPress={() => p.onMove(group.id, 1)}
          />
          <EditButton
            testID={`wl-group-menu-${index}`}
            icon={MENU}
            label={`Rename or delete group ${group.name}`}
            style={styles.control}
            onPress={() => p.onMenu(group.id)}
          />
        </>
      ) : null}
    </View>
  )
}

export function NewGroupRow({ onPress }: { onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID="wl-new-group"
      accessibilityRole="button"
      accessibilityLabel="New group"
      onPress={onPress}
      style={[styles.add, { borderBottomColor: c.border }]}
    >
      <Text style={styles.addLabel}>+ New group</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    height: GROUP_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  name: { flexShrink: 1, fontWeight: '600' },
  count: { flex: 1, marginLeft: 8 },
  control: { height: GROUP_HEIGHT },
  add: {
    height: NEW_GROUP_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addLabel: { fontWeight: '600' },
})
