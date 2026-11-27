// The Tools tab (design 7.8): every tool the web frontend lists, in dense rows grouped as a trader
// looks for them, Option Chain first. A tool opens when this build hosts it and the server has
// what it needs; otherwise its row says why, and a tap says it in full without opening anything.
import { type Href, useRouter } from 'expo-router'
import { useMemo, useSyncExternalStore } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useServices } from '~/core/services/services'
import { toolHref } from '~/market/links'
import type { ToolEntry } from '~/market/tools/registry'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { ToolTile } from '../components/ToolTile'
import { gatedToast, TOOL_GROUPS, tileState, toolOf } from '../model'

type Section = { title: string; data: ToolEntry[] }

const SECTIONS: readonly Section[] = TOOL_GROUPS.map((g) => ({
  title: g.title,
  data: g.ids.flatMap((id) => {
    const t = toolOf(id)
    return t ? [t] : []
  }),
}))
const COUNT = SECTIONS.reduce((n, sec) => n + sec.data.length, 0)

export function ToolsScreen() {
  const s = useServices()
  const router = useRouter()
  const { c } = useTheme()
  const caps = useSyncExternalStore(s.caps.subscribe, s.caps.get)
  const states = useMemo(
    () => new Map(SECTIONS.flatMap((sec) => sec.data).map((t) => [t.id, tileState(t.id, caps)])),
    [caps],
  )

  const open = (t: ToolEntry) => {
    const state = states.get(t.id) ?? tileState(t.id, caps)
    if (state.kind === 'open') router.push(toolHref(t.id) as Href)
    else toast(gatedToast(state, caps?.version ?? null))
  }

  return (
    <SectionList
      testID="tools-grid"
      sections={SECTIONS}
      keyExtractor={(t) => t.id}
      // twenty rows: all of them at once (a section's header and footer count as items), so the
      // list never fills in under a fast scroll
      initialNumToRender={COUNT + 2 * SECTIONS.length}
      stickySectionHeadersEnabled={false}
      style={{ backgroundColor: c.background }}
      renderSectionHeader={({ section }) => (
        <View style={[styles.header, { backgroundColor: c.background }]}>
          <Text tone="muted" maxFontSizeMultiplier={1.3} style={styles.headerText}>
            {section.title}
          </Text>
        </View>
      )}
      renderItem={({ item }) => (
        <ToolTile
          tool={item}
          state={states.get(item.id) ?? { kind: 'later' }}
          onPress={() => open(item)}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  headerText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' },
})
