import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChainLinkIncomplete, OptionChainScreen, targetFromU } from '~/features/optionchain'
import { isToolPage, TOOL_BUILD, TOOL_LINK_INCOMPLETE, ToolScreen } from '~/features/tools'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { NotYetAvailable } from '~/ui/NotYetAvailable'
import { useTheme } from '~/ui/theme'

/**
 * A tool by its web id. The ten tool pages open their DOM screen and Option Chain its native one,
 * on `u` (`NFO:NIFTY`) or NIFTY; the tools after this build say they are coming; anything else is
 * a broken link. The route has no header, so each of those offers its own way back.
 */
export default function ToolRoute() {
  const { toolId, u } = useLocalSearchParams<{ toolId: string; u?: string }>()
  const id = toolId ?? ''
  if (isToolPage(id)) return <ToolScreen key={id} page={id} />
  if (id === 'optionchain') {
    const target = targetFromU(u || undefined)
    if (u && !target) return <ChainLinkIncomplete />
    return <OptionChainScreen key={u ?? ''} initial={target} />
  }
  return (
    <NotHere
      body={
        TOOL_BUILD[id]?.build === 'later' ? (
          <NotYetAvailable what="Tools" />
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
