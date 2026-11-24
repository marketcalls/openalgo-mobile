// The Watchlist tab: the device-local list with live prices. Editing, search, the index strip
// and the buy/sell buttons come with the full watchlist in the next plan.
import { useEffect, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import { useServices } from '~/core/services/services'
import type { WatchItem } from '~/market/watchlists/model'
import { loadWatchlists } from '~/market/watchlists/store'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { useSeedQuotes } from '../api'
import { useReduceMotion, WatchRow } from '../components/WatchRow'

const EMPTY: readonly WatchItem[] = []

export function WatchlistScreen() {
  const { storage } = useServices()
  const { c } = useTheme()
  const reduceMotion = useReduceMotion()
  const [name, setName] = useState('Watchlist')
  const [items, setItems] = useState<readonly WatchItem[]>(EMPTY)

  useEffect(() => {
    let live = true
    loadWatchlists(storage)
      .then((w) => {
        const list = w.lists[0]
        if (!live || !list) return
        setName(list.name)
        setItems(list.items)
      })
      .catch((e) => log.warn('watchlist', 'could not load the watchlist', e))
    return () => {
      live = false
    }
  }, [storage])

  useSeedQuotes(items)

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <Text variant="title" style={styles.title}>
        {name}
      </Text>
      <FlatList
        data={items}
        keyExtractor={(i) => `${i.exchange}:${i.symbol}`}
        renderItem={({ item }) => (
          <WatchRow exchange={item.exchange} symbol={item.symbol} reduceMotion={reduceMotion} />
        )}
        getItemLayout={(_d, index) => ({ length: 56, offset: 56 * index, index })}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  title: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
})
