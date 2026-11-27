// The chart and the depth screen open each other (the chart header's Depth, the depth screen's
// Chart). A round trip must not stack a new screen each time: every chart is a WebView page of
// about 2.3 MB with its feed holds, so a trader flipping between the two would soon have several
// live pages, and the OS then kills renderers. When the screen just beneath is the one asked for,
// on the same instrument, this goes back to it instead of pushing another.
import { type Href, useNavigation, useRouter } from 'expo-router'
import { parseKey } from './links'

/** The stack routes this opens: their `[key]` param is `exchange:symbol`. */
export type InstrumentRoute = 'chart/[key]' | 'depth/[key]'

type Route = { name?: string; params?: object }

export function useOpenOrBack(): (
  route: InstrumentRoute,
  inst: { exchange: string; symbol: string },
  href: string,
) => void {
  const router = useRouter()
  const navigation = useNavigation()
  return (route, inst, href) => {
    const state = navigation.getState() as { index?: number; routes?: Route[] } | undefined
    const below = state?.routes?.[(state.index ?? 0) - 1]
    const key = (below?.params as { key?: unknown } | undefined)?.key
    const k = below?.name === route && typeof key === 'string' ? parseKey(key) : null
    if (k?.exchange === inst.exchange && k.symbol === inst.symbol) router.back()
    else router.push(href as Href)
  }
}
