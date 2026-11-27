// The Watchlist tab, Kite style (design 17.1): the index strip, the lists as tabs, the "Search &
// add" bar with the count, sort and edit, then the active list's rows: ungrouped first, then each
// group under its header. A row press opens the instrument sheet. Edit mode reorders within a
// group, moves between groups and removes; a long press on a tab, or the manage sheet, renames,
// deletes and reorders the lists. A FlatList, not FlashList (M2 ruling 2).
import { type Href, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, FlatList, type ListRenderItemInfo, StyleSheet, View } from 'react-native'
import { useStore } from 'zustand'
import { log } from '~/core/log/logger'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import { useHeldQuantities } from '~/market/books/held'
import { searchHref } from '~/market/links'
import { useTrading, useWatchlists } from '~/market/trading'
import {
  createGroup,
  deleteGroup,
  deleteList,
  moveGroup,
  moveItemInGroup,
  moveList,
  removeItem,
  renameGroup,
  renameList,
  setActive,
  setItemGroup,
  setSort,
  WATCHLIST_LIMITS,
  type WatchItem,
  type Watchlists,
  type WatchSort,
} from '~/market/watchlists/model'
import { Button } from '~/ui/Button'
import { confirm } from '~/ui/confirm'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { useReduceMotion } from '~/ui/useReduceMotion'
import { createAndOpen, newGroupId, newListId, useSeedQuotes } from '../api'
import { GroupHeader, NewGroupRow } from '../components/GroupHeader'
import { IndexStrip } from '../components/IndexStrip'
import { ManageListsSheet, MoveToGroupSheet, SortSheet } from '../components/ListSheets'
import { ListNameSheet, ListTabs } from '../components/ListTabs'
import { SearchAddBar } from '../components/SearchAddBar'
import { WatchRow } from '../components/WatchRow'
import { buildRows, type RowModel, rowHeight, rowOffsets } from '../rows'

const EMPTY: readonly WatchItem[] = []

export const WATCHLIST_COPY = {
  empty: 'This list is empty',
  keepOne: 'Keep at least one list.',
  badName: `Use 1 to ${WATCHLIST_LIMITS.nameMax} characters for the name.`,
  tooMany: `You can keep up to ${WATCHLIST_LIMITS.lists} lists.`,
  tooManyGroups: `You can keep up to ${WATCHLIST_LIMITS.groups} groups.`,
  saveFailed: 'Could not save your lists. Try again.',
} as const

const activeOf = (w: Watchlists) => w.lists.find((l) => l.id === w.activeId) ?? w.lists[0]
const same = (a: WatchItem, b: WatchItem) => a.exchange === b.exchange && a.symbol === b.symbol

type Naming =
  | { kind: 'new' }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'new-group' }
  | { kind: 'rename-group'; id: string; name: string }

/** The name sheet's title and first value. */
function namingCopy(n: Naming, lists: number) {
  switch (n.kind) {
    case 'new':
      return { title: 'New list', initial: `Watchlist ${lists + 1}`, placeholder: 'List name' }
    case 'rename':
      return { title: 'Rename list', initial: n.name, placeholder: 'List name' }
    case 'new-group':
      return { title: 'New group', initial: '', placeholder: 'Group name' }
    case 'rename-group':
      return { title: 'Rename group', initial: n.name, placeholder: 'Group name' }
  }
}

/** Rename, Delete or Cancel, as a native menu. */
function renameOrDelete(title: string, onRename: () => void, onDelete: () => void) {
  Alert.alert(
    title,
    undefined,
    [
      { text: 'Rename', onPress: onRename },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
      { text: 'Cancel', style: 'cancel' },
    ],
    { cancelable: true },
  )
}

/** Moves on each time the screen comes into focus. */
function useFocusCount(active: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (active) setN((x) => x + 1)
  }, [active])
  return n
}

const rowKey = (r: RowModel) =>
  r.kind === 'item' ? r.key : r.kind === 'group' ? `group:${r.group.id}` : 'new-group'

export function WatchlistScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const { store } = useServices()
  const { watchlists } = useTrading()
  const reduceMotion = useReduceMotion()
  const active = useScreenActive()
  const loaded = useStore(watchlists, (st) => st.loaded)
  const lists = useWatchlists((w) => w.lists)
  const list = useWatchlists(activeOf)
  const [failed, setFailed] = useState<unknown>(null)
  const [editing, setEditing] = useState(false)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [managing, setManaging] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [moving, setMoving] = useState<WatchItem | null>(null)

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
  // a list switch or a sort change asks for the seed out then, or sent with it
  const { seeded } = useSeedQuotes(items, loaded && list ? `${list.id}:${list.sort}` : '')
  const held = useHeldQuantities()
  const focus = useFocusCount(active)

  // The sort is a snapshot of the quotes: taken on each focus and when the sort or the items
  // change, and again once the first seed after a focus, a list switch or a sort change is in.
  // Never on a tick, nor on a seed outside those (the broker session turning active, the unknown
  // set clearing): rows do not jump under a finger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focus` and `seeded` retake the snapshot
  const rows = useMemo(
    () => (loaded && list ? buildRows(list, { editing, quoteOf: (k) => store.get(k) }) : []),
    [loaded, list, editing, store, focus, seeded],
  )
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const hasGroups = (list?.groups.length ?? 0) > 0

  /** Runs a store change; a failed save is told, and the store has rolled back. */
  const change = useCallback(async <R,>(p: Promise<R>): Promise<R | undefined> => {
    try {
      return await p
    } catch (e) {
      log.warn('watchlist', 'could not save the lists', e)
      // closed, so the toast is not hidden under it
      setManaging(false)
      toast(WATCHLIST_COPY.saveFailed)
      return undefined
    }
  }, [])

  /** The active list as stored now, for a handler. */
  const current = useCallback(() => activeOf(watchlists.getState().data), [watchlists])

  const onRemove = useCallback(
    async (exchange: string, symbol: string) => {
      const target = current()
      if (!target) return
      const ok = await confirm(`Remove ${symbol} from ${target.name}?`, '', 'Remove', {
        destructive: true,
      })
      if (ok) await change(watchlists.getState().apply(removeItem, target.id, { exchange, symbol }))
    },
    [watchlists, change, current],
  )

  const onMove = useCallback(
    async (exchange: string, symbol: string, by: -1 | 1) => {
      const target = current()
      // past either end of its group, moveItemInGroup keeps the order (bad_index)
      if (target)
        await change(
          watchlists.getState().apply(moveItemInGroup, target.id, { exchange, symbol }, by),
        )
    },
    [watchlists, change, current],
  )

  const onRegroup = useCallback(
    (exchange: string, symbol: string) => setMoving({ exchange, symbol }),
    [],
  )

  const onMoveTo = async (groupId: string | null) => {
    const item = moving
    setMoving(null)
    const target = current()
    if (!item || !target) return
    // the same group would only move it to the end
    if ((target.items.find((i) => same(i, item))?.group ?? null) === groupId) return
    await change(watchlists.getState().apply(setItemGroup, target.id, item, groupId))
  }

  const onGroupMove = useCallback(
    async (groupId: string, by: -1 | 1) => {
      const target = current()
      if (target) await change(watchlists.getState().apply(moveGroup, target.id, groupId, by))
    },
    [watchlists, change, current],
  )

  const onGroupMenu = useCallback(
    (groupId: string) => {
      const target = current()
      const group = target?.groups.find((g) => g.id === groupId)
      if (!target || !group) return
      renameOrDelete(
        group.name,
        () => setNaming({ kind: 'rename-group', id: groupId, name: group.name }),
        async () => {
          const ok = await confirm(
            `Delete group ${group.name}?`,
            'Its symbols stay in the list.',
            'Delete',
            { destructive: true },
          )
          if (ok) await change(watchlists.getState().apply(deleteGroup, target.id, groupId))
        },
      )
    },
    [watchlists, change, current],
  )

  const onNewGroup = useCallback(() => {
    if ((current()?.groups.length ?? 0) >= WATCHLIST_LIMITS.groups)
      toast(WATCHLIST_COPY.tooManyGroups)
    else setNaming({ kind: 'new-group' })
  }, [current])

  const onSort = async (sort: WatchSort) => {
    setSorting(false)
    const target = current()
    if (target && sort !== target.sort)
      await change(watchlists.getState().apply(setSort, target.id, sort))
  }

  const onSelect = (id: string) => {
    if (id !== list?.id) void change(watchlists.getState().apply(setActive, id))
  }

  const onNew = () => {
    if (lists.length < WATCHLIST_LIMITS.lists) {
      setNaming({ kind: 'new' })
      return
    }
    setManaging(false)
    toast(WATCHLIST_COPY.tooMany)
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

  const onRename = (id: string) => {
    const target = watchlists.getState().data.lists.find((l) => l.id === id)
    if (target) setNaming({ kind: 'rename', id, name: target.name })
  }

  const onMenu = (id: string) => {
    const target = watchlists.getState().data.lists.find((l) => l.id === id)
    if (target)
      renameOrDelete(
        target.name,
        () => onRename(id),
        () => void onDelete(id),
      )
  }

  /** Saves the name asked for; each reducer's result is one of the strings below. */
  const save = (n: Naming, name: string): Promise<string | undefined> => {
    const st = watchlists.getState()
    const target = activeOf(st.data)
    switch (n.kind) {
      case 'new':
        return change(st.apply(createAndOpen, name, newListId(st.data)))
      case 'rename':
        return change(st.apply(renameList, n.id, name))
      case 'new-group':
        return target
          ? change(st.apply(createGroup, target.id, name, newGroupId(target)))
          : Promise.resolve(undefined)
      case 'rename-group':
        return target
          ? change(st.apply(renameGroup, target.id, n.id, name))
          : Promise.resolve(undefined)
    }
  }

  const onName = async (name: string) => {
    if (!naming) return
    // Closed first: a sheet is a native modal, and a toast under it would not be seen. A new
    // list closes the manage sheet too, to show the list; a rename goes back to the lists.
    setNaming(null)
    if (naming.kind === 'new') setManaging(false)
    const result = await save(naming, name)
    if (result === 'bad_name') toast(WATCHLIST_COPY.badName)
    if (result === 'limit')
      toast(naming.kind === 'new-group' ? WATCHLIST_COPY.tooManyGroups : WATCHLIST_COPY.tooMany)
  }

  const addTo = (id: string) => router.push(searchHref({ addTo: id }) as Href)

  const renderRow = ({ item: r }: ListRenderItemInfo<RowModel>) => {
    if (r.kind === 'group')
      return (
        <GroupHeader
          group={r.group}
          index={r.index}
          count={r.count}
          editing={editing}
          last={r.index === (list?.groups.length ?? 0) - 1}
          onMove={onGroupMove}
          onMenu={onGroupMenu}
        />
      )
    if (r.kind === 'new-group') return <NewGroupRow onPress={onNewGroup} />
    return (
      <WatchRow
        exchange={r.item.exchange}
        symbol={r.item.symbol}
        held={held.get(r.key)}
        reduceMotion={reduceMotion}
        editing={editing}
        first={r.first}
        last={r.last}
        onRemove={onRemove}
        onMove={onMove}
        onRegroup={hasGroups ? onRegroup : undefined}
      />
    )
  }

  const body = () => {
    if (failed !== null) return <ErrorState error={failed} onRetry={load} />
    if (!loaded || !list) return <Skeleton />
    if (list.items.length === 0 && !editing) {
      return (
        <EmptyState
          title={WATCHLIST_COPY.empty}
          action={
            <Button testID="wl-empty-add" title="Add symbols" onPress={() => addTo(list.id)} />
          }
        />
      )
    }
    return (
      <FlatList
        data={rows}
        extraData={held}
        keyExtractor={rowKey}
        getItemLayout={(data, index) => {
          const r = data?.[index]
          return { length: r ? rowHeight(r) : 0, offset: offsets[index] ?? 0, index }
        }}
        renderItem={renderRow}
      />
    )
  }

  const copy = naming ? namingCopy(naming, lists.length) : null
  const listNaming = naming?.kind === 'new' || naming?.kind === 'rename'
  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <IndexStrip />
      {loaded && list ? (
        <>
          <ListTabs
            lists={lists}
            activeId={list.id}
            onSelect={onSelect}
            onMenu={onMenu}
            onManage={() => setManaging(true)}
          />
          <SearchAddBar
            count={list.items.length}
            editing={editing}
            onSearch={() => addTo(list.id)}
            onSort={() => setSorting(true)}
            onEdit={() => setEditing((e) => !e)}
          />
        </>
      ) : null}
      {body()}
      {managing ? (
        <ManageListsSheet
          lists={lists}
          naming={
            naming && copy && listNaming
              ? { key: naming.kind === 'rename' ? naming.id : 'new', ...copy }
              : null
          }
          onMove={(id, by) => void change(watchlists.getState().apply(moveList, id, by))}
          onRename={onRename}
          onDelete={(id) => void onDelete(id)}
          onNew={onNew}
          onName={(name) => void onName(name)}
          onNameCancel={() => setNaming(null)}
          onClose={() => {
            setManaging(false)
            setNaming(null)
          }}
        />
      ) : naming && copy ? (
        <ListNameSheet
          {...copy}
          onSave={(name) => void onName(name)}
          onClose={() => setNaming(null)}
        />
      ) : null}
      {sorting && list ? (
        <SortSheet
          sort={list.sort}
          onPick={(s) => void onSort(s)}
          onClose={() => setSorting(false)}
        />
      ) : null}
      {moving && list ? (
        <MoveToGroupSheet
          symbol={moving.symbol}
          groups={list.groups}
          current={list.items.find((i) => same(i, moving))?.group}
          onPick={(g) => void onMoveTo(g)}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
