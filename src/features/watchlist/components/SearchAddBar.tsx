// Kite's bar under the tabs (design 17.1): "Search & add" to the active list, with its count
// ("18/250"), then the sort and the edit-mode switch.
import { Pressable, StyleSheet, View } from 'react-native'
import { WATCHLIST_LIMITS } from '~/market/watchlists/model'
import { Icon, type IconName } from '~/ui/Icon'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

const SEARCH: IconName = { ios: 'magnifyingglass', android: 'search' }
const SORT: IconName = { ios: 'arrow.up.arrow.down', android: 'sort' }

export function SearchAddBar(p: {
  count: number
  editing: boolean
  onSearch: () => void
  onSort: () => void
  onEdit: () => void
}) {
  const { c } = useTheme()
  return (
    <View style={styles.bar}>
      {/* the count sits inside the field's frame, but outside its button */}
      <View style={[styles.field, { borderColor: c.border }]}>
        <Pressable
          testID="wl-search-add"
          accessibilityRole="button"
          accessibilityLabel="Search and add symbols"
          onPress={p.onSearch}
          style={styles.search}
        >
          <Icon name={SEARCH} size={16} color={c.mutedForeground} />
          <Text tone="muted">Search & add</Text>
        </Pressable>
        <Text testID="wl-count" variant="caption" tone="muted" style={styles.count}>
          {`${p.count}/${WATCHLIST_LIMITS.items}`}
        </Text>
      </View>
      <Pressable
        testID="wl-sort"
        accessibilityRole="button"
        accessibilityLabel="Sort"
        onPress={p.onSort}
        hitSlop={4}
        style={styles.button}
      >
        <Icon name={SORT} size={18} color={c.foreground} />
      </Pressable>
      <Pressable
        testID="wl-edit"
        accessibilityRole="button"
        accessibilityLabel={p.editing ? 'Done editing' : 'Edit list'}
        onPress={p.onEdit}
        hitSlop={4}
        style={styles.button}
      >
        <Text style={styles.label}>{p.editing ? 'Done' : 'Edit'}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, gap: 4 },
  field: {
    flex: 1,
    minHeight: 40,
    marginVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  search: {
    flex: 1,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
  },
  count: { paddingHorizontal: 12 },
  button: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' },
})
