import { useLocalSearchParams } from 'expo-router'
import { SearchScreen } from '~/features/search/screens/SearchScreen'

/** The search modal: `?addTo=<list id>` adds to that list, otherwise a tap opens the symbol. */
export default function SearchRoute() {
  const { addTo } = useLocalSearchParams<{ addTo?: string }>()
  return <SearchScreen addTo={addTo || undefined} />
}
