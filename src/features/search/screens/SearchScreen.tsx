// The search modal. Browse mode opens the instrument sheet; add mode (`addTo` = a list id)
// adds the symbol to that list, and each row's trailing button opens its sheet instead. Chips
// narrow the search to one exchange.
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useServices } from '~/core/services/services'
import { searchExchanges } from '~/market/instruments/exchanges'
import { instrumentHref } from '~/market/links'
import { useTrading, useWatchlists } from '~/market/trading'
import { addItem, WATCHLIST_LIMITS } from '~/market/watchlists/model'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { TOAST_MS } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { MAX_QUERY, useSymbolSearch } from '../api'
import { ResultRow } from '../components/ResultRow'

export function SearchScreen({ addTo }: { addTo?: string }) {
  const { c } = useTheme()
  const router = useRouter()
  const { caps } = useServices()
  const { watchlists } = useTrading()
  const [text, setText] = useState('')
  const [chip, setChip] = useState('ALL')
  // Add-mode feedback is drawn inside this screen: the root ToastHost sits beneath the native
  // modal presentation and can be hidden behind it on iOS.
  const [status, setStatus] = useState<string | null>(null)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = (message: string) => {
    if (statusTimer.current) clearTimeout(statusTimer.current)
    setStatus(message)
    statusTimer.current = setTimeout(() => setStatus(null), TOAST_MS)
  }
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current)
    },
    [],
  )
  const chips = ['ALL', ...searchExchanges(caps.get()?.version ?? null)]
  const search = useSymbolSearch(text, chip === 'ALL' ? undefined : chip)

  // The store is shared with the watchlist tab; adding to unloaded defaults would overwrite it.
  useEffect(() => {
    if (addTo !== undefined && !watchlists.getState().loaded) void watchlists.getState().load()
  }, [addTo, watchlists])
  const list = useWatchlists((w) => w.lists.find((l) => l.id === addTo))

  const open = (exchange: string, symbol: string) =>
    router.replace(instrumentHref(exchange, symbol) as never)

  const onPick = async (exchange: string, symbol: string) => {
    if (addTo === undefined) {
      open(exchange, symbol)
      return
    }
    if (!watchlists.getState().loaded) await watchlists.getState().load()
    const result = await watchlists.getState().apply(addItem, addTo, { exchange, symbol })
    const name = watchlists.getState().data.lists.find((l) => l.id === addTo)?.name
    say(
      {
        added: `Added ${symbol} to ${name ?? 'the list'}`,
        duplicate: 'Already in this list',
        full: `This list is full (${WATCHLIST_LIMITS.items})`,
        missing: 'That list no longer exists',
      }[result],
    )
  }

  const body = () => {
    if (!search.ready) return <EmptyState title="Type at least 2 letters" />
    if (search.error) return <ErrorState error={search.error} onRetry={search.retry} />
    if (search.rows.length === 0) {
      if (search.loading) return <Skeleton />
      return <EmptyState title="No matching symbols" />
    }
    return (
      <FlatList
        data={search.rows}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(r) => `${r.exchange}:${r.symbol}`}
        renderItem={({ item }) => (
          <ResultRow
            row={item}
            added={list?.items.some(
              (i) => i.exchange === item.exchange && i.symbol === item.symbol,
            )}
            onPress={() => void onPick(item.exchange, item.symbol)}
            onOpen={addTo === undefined ? undefined : () => open(item.exchange, item.symbol)}
          />
        )}
      />
    )
  }

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <TextInput
        testID="search-input"
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="Search symbols"
        placeholderTextColor={c.mutedForeground}
        maxLength={MAX_QUERY}
        value={text}
        onChangeText={setText}
        style={[styles.input, { color: c.foreground, borderColor: c.border }]}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
        {chips.map((ex) => (
          <Pressable
            key={ex}
            testID={`search-chip-${ex}`}
            accessibilityRole="button"
            accessibilityState={{ selected: chip === ex }}
            onPress={() => setChip(ex)}
            style={[
              styles.chip,
              { borderColor: c.border, backgroundColor: chip === ex ? c.primary : c.background },
            ]}
          >
            <Text
              variant="caption"
              style={{ color: chip === ex ? c.primaryForeground : c.foreground }}
            >
              {ex}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {body()}
      {status !== null && (
        <View pointerEvents="none" style={styles.statusWrap}>
          <View
            testID="search-status"
            accessibilityLiveRegion="polite"
            style={[styles.status, { backgroundColor: c.foreground }]}
          >
            <Text numberOfLines={1} style={{ color: c.background }}>
              {status}
            </Text>
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  input: {
    margin: 16,
    marginBottom: 8,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  statusWrap: { position: 'absolute', left: 16, right: 16, bottom: 48, alignItems: 'center' },
  status: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '100%' },
  chips: { flexGrow: 0, paddingHorizontal: 12, paddingBottom: 8 },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginHorizontal: 4,
    borderWidth: 1,
    borderRadius: 999,
  },
})
