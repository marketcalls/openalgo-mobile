import { useLocalSearchParams } from 'expo-router'
import { NotYetAvailable } from '~/ui/NotYetAvailable'

/** Tools arrive after this build; the route exists so links to them work. */
export default function ToolRoute() {
  const { toolId } = useLocalSearchParams<{ toolId: string }>()
  return <NotYetAvailable what={toolId === 'optionchain' ? 'Option chains' : 'Tools'} />
}
