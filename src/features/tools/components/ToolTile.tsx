// One tool on the Tools tab, as a dense Kite row: the web's initials in its colour, the title,
// and one line under it. A tool that does not open here is dimmed, says why in that line, and a
// tap says it in full: never a dead tap.
import { Pressable, StyleSheet, View } from 'react-native'
import type { ToolEntry } from '~/market/tools/registry'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { LATER_NOTE, needsNote, type TileState } from '../model'

/** The row's least height; it grows with the font scale, up to 1.3. */
export const TILE_MIN_HEIGHT = 56
const MAX_SCALE = 1.3

/** `tool-tile-PORTFOLIO-BACKTESTER`: the id in upper case. */
export const tileId = (id: string) => `tool-tile-${id.toUpperCase()}`
const noteId = (id: string) => `tool-tile-note-${id.toUpperCase()}`

export function ToolTile({
  tool,
  state,
  onPress,
}: {
  tool: ToolEntry
  state: TileState
  onPress: () => void
}) {
  const { c } = useTheme()
  const id = tileId(tool.id)
  const note =
    state.kind === 'needs' ? needsNote(state.version) : state.kind === 'later' ? LATER_NOTE : null
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={note === null ? tool.title : `${tool.title}, ${note}`}
      accessibilityState={{ disabled: note !== null }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: c.border },
        pressed && { backgroundColor: c.muted },
      ]}
    >
      <View style={[styles.content, note !== null && styles.gated]}>
        <View style={[styles.mark, { backgroundColor: tool.color }]}>
          <Text maxFontSizeMultiplier={MAX_SCALE} style={styles.initials}>
            {tool.initials}
          </Text>
        </View>
        <View style={styles.text}>
          <Text maxFontSizeMultiplier={MAX_SCALE} numberOfLines={1} style={styles.title}>
            {tool.title}
          </Text>
          {note === null ? (
            <Text
              tone="muted"
              maxFontSizeMultiplier={MAX_SCALE}
              numberOfLines={1}
              style={styles.line}
            >
              {tool.description}
            </Text>
          ) : (
            <Text
              testID={noteId(tool.id)}
              tone="muted"
              maxFontSizeMultiplier={MAX_SCALE}
              numberOfLines={1}
              style={styles.line}
            >
              {note}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: TILE_MIN_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gated: { opacity: 0.5 },
  mark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  line: { fontSize: 13 },
})
