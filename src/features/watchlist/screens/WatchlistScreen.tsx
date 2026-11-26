// The Watchlist tab (design 7.7): named device-local lists with live prices. Add opens search,
// Edit reorders and removes, a long press on a list renames or deletes it. The broker banner
// sits above the tabs (ruling 9). A FlatList, not FlashList: FlashList would add 3% to a bundle
// already at its 5% growth limit (ruling 2).
import { type Href, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native'
import { useStore } from 'zustand'
import { log } from '~/core/log/logger'
import { quoteKey } from '~/core/realtime/protocol'
import { searchHref } from '~/market/links'
import { useTrading, useWatchlists } from '~/market/trading'
import {
  deleteList,
  moveItem,
  removeItem,
  renameList,
  setActive,
  WATCHLIST_LIMITS,
  type WatchItem,
  type Watchlists,
} from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import { confirm } from '~/ui/confirm'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { createAndOpen, newListId, useSeedQuotes } from '../api'
import { IndexStrip } from '../components/IndexStrip'
import { ListNameSheet, ListTabs } from '../components/ListTabs'
import { ROW_HEIGHT, useReduceMotion, WatchRow } from '../components/WatchRow'

const EMPTY: readonly WatchItem[] = []

export const WATCHLIST_COPY = {
  empty: 'This list is empty',
  keepOne: 'Keep at least one list.',
  badName: `Use 1 to ${WATCHLIST_LIMITS.nameMax} characters for the name.`,
  tooMany: `You can keep up to ${WATCHLIST_LIMITS.lists} lists.`,
  saveFailed: 'Could not save your lists. Try again.',
} as const

const activeOf = (w: Watchlists) => w.lists.find((l) => l.id === w.activeId) ?? w.lists[0]

type Naming = { kind: 'new' } | { kind: 'rename'; id: string; name: string }

export function WatchlistScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const { watchlists } = useTrading()
  const reduceMotion = useReduceMotion()
  const loaded = useStore(watchlists, (st) => st.loaded)
  const lists = useWatchlists((w) => w.lists)
  const list = useWatchlists(activeOf)
  const [failed, setFailed] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [naming, setNaming] = useState<Naming | null>(null)

  // The store is shared with search; until it has read the saved lists, they are not shown,
  // seeded or changed.
  const load = useCallback(() => {
    setFailed(null)
    watchlists
      .getState()
      .load()
      .catch((e) => {
        log.warn('watchlist', 'could not load the lists', e)
        setFailed(e)
      })
  }, [watchlists])
  useEffect(() => {
    if (!watchlists.getState().loaded) load()
  }, [watchlists, load])

  const items = loaded ? (list?.items ?? EMPTY) : EMPTY
  useSeedQuotes(items)

  /** Runs a store change; a failed save is told, and the store has rolled back. */
  const change = useCallback(async <R,>(p: Promise<R>): Promise<R | undefined> => {
    try {
      return await p
    } catch (e) {
      log.warn('watchlist', 'could not save the lists', e)
      toast(WATCHLIST_COPY.saveFailed)
      return undefined
    }
  }, [])

  const onRemove = useCallback(
    async (exchange: string, symbol: string) => {
      const target = activeOf(watchlists.getState().data)
      if (!target) return
      const ok = await confirm(`Remove ${symbol} from ${target.name}?`, '', 'Remove', {
        destructive: true,
      })
      if (ok) await change(watchlists.getState().apply(removeItem, target.id, { exchange, symbol }))
    },
    [watchlists, change],
  )

  const onMove = useCallback(
    async (exchange: string, symbol: string, by: -1 | 1) => {
      const target = activeOf(watchlists.getState().data)
      const from =
        target?.items.findIndex((i) => i.exchange === exchange && i.symbol === symbol) ?? -1
      // A row that has gone does nothing; past either end, moveItem keeps the order (bad_index).
      if (!target || from < 0) return
      await change(watchlists.getState().apply(moveItem, target.id, from, from + by))
    },
    [watchlists, change],
  )

  const onSelect = (id: string) => {
    if (id !== list?.id) void change(watchlists.getState().apply(setActive, id))
  }

  const onNew = () => {
    if (lists.length >= WATCHLIST_LIMITS.lists) toast(WATCHLIST_COPY.tooMany)
    else setNaming({ kind: 'new' })
  }

  const onDelete = async (id: string) => {
    const data = watchlists.getState().data
    const target = data.lists.find((l) => l.id === id)
    if (!target) return
    if (data.lists.length <= 1) {
      toast(WATCHLIST_COPY.keepOne)
      return
    }
    const n = target.items.length
    const ok = await confirm(
      `Delete ${target.name} and its ${n} ${n === 1 ? 'symbol' : 'symbols'}?`,
      '',
      'Delete',
      { destructive: true },
    )
    if (!ok) return
    const result = await change(watchlists.getState().apply(deleteList, id))
    if (result === 'last_list') toast(WATCHLIST_COPY.keepOne)
  }

  const onMenu = (id: string) => {
    const target = watchlists.getState().data.lists.find((l) => l.id === id)
    if (!target) return
    Alert.alert(
      target.name,
      undefined,
      [
        { text: 'Rename', onPress: () => setNaming({ kind: 'rename', id, name: target.name }) },
        { text: 'Delete', style: 'destructive', onPress: () => void onDelete(id) },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    )
  }

  const onName = async (name: string) => {
    if (!naming) return
    // Closed first: the sheet is a native modal, and a toast under it would not be seen.
    setNaming(null)
    const st = watchlists.getState()
    const result = await change(
      naming.kind === 'new'
        ? st.apply(createAndOpen, name, newListId(st.data))
        : st.apply(renameList, naming.id, name),
    )
    if (result === 'bad_name') toast(WATCHLIST_COPY.badName)
    if (result === 'limit') toast(WATCHLIST_COPY.tooMany)
  }

  const addTo = (id: string) => router.push(searchHref({ addTo: id }) as Href)

  const body = () => {
    if (failed !== null) return <ErrorState error={failed} onRetry={load} />
    if (!loaded || !list) return <Skeleton />
    if (list.items.length === 0) {
      return (
        <EmptyState
          title={WATCHLIST_COPY.empty}
          action={
            <Button testID="wl-empty-add" title="Add symbols" onPress={() => addTo(list.id)} />
          }
        />
      )
    }
    const last = list.items.length - 1
    return (
      <FlatList
        data={list.items}
        extraData={editing}
        keyExtractor={(i) => quoteKey(i.exchange, i.symbol)}
        getItemLayout={(_d, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        renderItem={({ item, index }) => (
          <WatchRow
            exchange={item.exchange}
            symbol={item.symbol}
            reduceMotion={reduceMotion}
            editing={editing}
            first={index === 0}
            last={index === last}
            onRemove={onRemove}
            onMove={onMove}
          />
        )}
      />
    )
  }

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <IndexStrip />
      {loaded && list ? (
        <View style={styles.header}>
          <ListTabs
            lists={lists}
            activeId={list.id}
            onSelect={onSelect}
            onMenu={onMenu}
            onNew={onNew}
          />
          <HeaderButton
            testID="wl-search"
            title="Search"
            label="Search symbols"
            // browse mode (design 7.3): a result opens the instrument sheet, for its quote,
            // depth and chart, without adding it to a list first
            onPress={() => router.push(searchHref() as Href)}
          />
          <HeaderButton
            testID="wl-add"
            title="Add"
            label="Add symbols"
            onPress={() => addTo(list.id)}
          />
          <HeaderButton
            testID="wl-edit"
            title={editing ? 'Done' : 'Edit'}
            label={editing ? 'Done editing' : 'Edit list'}
            onPress={() => setEditing((e) => !e)}
          />
        </View>
      ) : null}
      {body()}
      {naming ? (
        <ListNameSheet
          title={naming.kind === 'new' ? 'New list' : 'Rename list'}
          initial={naming.kind === 'new' ? '' : naming.name}
          onSave={(name) => void onName(name)}
          onClose={() => setNaming(null)}
        />
      ) : null}
    </View>
  )
}

function HeaderButton(p: { testID: string; title: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      onPress={p.onPress}
      hitSlop={8}
      style={styles.headerButton}
    >
      <Text style={styles.headerLabel}>{p.title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  headerButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  headerLabel: { fontWeight: '600' },
})
