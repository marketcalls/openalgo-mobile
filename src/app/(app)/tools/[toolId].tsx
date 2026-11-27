import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isToolPage, TOOL_BUILD, TOOL_LINK_INCOMPLETE, ToolScreen } from '~/features/tools'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { NotYetAvailable } from '~/ui/NotYetAvailable'
import { useTheme } from '~/ui/theme'

/**
 * A tool by its web id. The ten tool pages open their DOM screen; Option Chain (until its native
 * screen) and the tools after this build say they are coming; anything else is a broken link.
 * The route has no header, so each of those offers its own way back.
 */
export default function ToolRoute() {
  const { toolId } = useLocalSearchParams<{ toolId: string }>()
  const id = toolId ?? ''
  if (isToolPage(id)) return <ToolScreen key={id} page={id} />
  const build = TOOL_BUILD[id]?.build
  return (
    <NotHere
      body={
        build === 'later' || build === 'native' ? (
          <NotYetAvailable what={id === 'optionchain' ? 'Option chains' : 'Tools'} />
        ) : (
          <EmptyState title={TOOL_LINK_INCOMPLETE} />
        )
      }
    />
  )
}

function NotHere({ body }: { body: ReactNode }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { c } = useTheme()
  return (
    <View
      testID="tool-unavailable"
      style={[styles.fill, { backgroundColor: c.background, paddingTop: insets.top + 8 }]}
    >
      {body}
      <View style={styles.back}>
        <Button testID="tool-back" title="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  back: { paddingHorizontal: 16 },
})
