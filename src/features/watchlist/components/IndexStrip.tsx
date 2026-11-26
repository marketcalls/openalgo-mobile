// The strip of index chips above the watchlist. A tap opens a panel with that index's day range
// and the account's funds; Edit picks which indices show (one to four). The chevron collapses it
// to a 32 px "Indices" bar (design 17.1): the chips unmount, and so release their feed slots.
import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { useFunds } from '~/market/books/queries'
import { useIsUnknown } from '~/market/instruments/useInstrument'
import { Change } from '~/ui/Change'
import { fmtPrice } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { Price } from '~/ui/Price'
import { Sheet } from '~/ui/Sheet'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import {
  DEFAULT_INDEX_STRIP,
  INDEX_CHOICES,
  type IndexChoice,
  loadIndexStrip,
  loadIndexStripOpen,
  saveIndexStrip,
  saveIndexStripOpen,
  toggleIndex,
} from '../indexStrip'

const find = (key: string) => INDEX_CHOICES.find((i) => i.key === key)
const COLLAPSE: IconName = { ios: 'chevron.up', android: 'expand_less' }
const EXPAND: IconName = { ios: 'chevron.down', android: 'expand_more' }

export function IndexStrip() {
  const { storage } = useServices()
  const { c } = useTheme()
  const [strip, setStrip] = useState<readonly string[]>(DEFAULT_INDEX_STRIP)
  const [shown, setShown] = useState(true)
  // false until the saved choices are read, so a change cannot be overwritten by that read, and
  // a strip saved collapsed never mounts its chips
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let live = true
    const unread = (e: unknown) => log.warn('watchlist', 'could not read the index strip', e)
    void Promise.all([
      loadIndexStrip(storage)
        .then((s) => live && setStrip(s))
        .catch(unread),
      loadIndexStripOpen(storage)
        .then((o) => live && setShown(o))
        .catch(unread),
    ]).then(() => live && setReady(true))
    return () => {
      live = false
    }
  }, [storage])

  const toggleShown = () => {
    const next = !shown
    setShown(next)
    if (!next) setOpen(null)
    saveIndexStripOpen(storage, next).catch((e) =>
      log.warn('watchlist', 'could not save the index strip', e),
    )
  }

  const toggle = useCallback(
    (key: string) => {
      const next = toggleIndex(strip, key)
      if (next.length === strip.length && next.every((k, i) => k === strip[i])) return
      setStrip(next)
      if (open && !next.includes(open)) setOpen(null)
      saveIndexStrip(storage, next).catch((e) => {
        log.warn('watchlist', 'could not save the index strip', e)
        toast('Could not save your indices. Try again.')
      })
    },
    [strip, open, storage],
  )

  const chips = strip.map(find).filter((i): i is IndexChoice => i !== undefined)
  const current = chips.find((i) => i.key === open)
  return (
    <View style={[styles.wrap, { borderBottomColor: c.border }, !shown && styles.collapsed]}>
      <View style={styles.row}>
        {shown ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
              {ready
                ? chips.map((i) => (
                    <Chip
                      key={i.key}
                      index={i}
                      selected={open === i.key}
                      onPress={() => setOpen(open === i.key ? null : i.key)}
                    />
                  ))
                : null}
            </ScrollView>
            <Pressable
              testID="index-edit"
              accessibilityRole="button"
              accessibilityLabel="Choose indices"
              disabled={!ready}
              onPress={() => setEditing(true)}
              hitSlop={8}
              style={styles.edit}
            >
              <Text style={styles.editLabel}>Edit</Text>
            </Pressable>
          </>
        ) : (
          <Text variant="caption" tone="muted" style={styles.barLabel}>
            Indices
          </Text>
        )}
        <Pressable
          testID="index-toggle"
          accessibilityRole="button"
          accessibilityLabel={shown ? 'Hide indices' : 'Show indices'}
          accessibilityState={{ expanded: shown }}
          disabled={!ready}
          onPress={toggleShown}
          hitSlop={8}
          style={[styles.toggle, !shown && styles.toggleBar]}
        >
          <Icon name={shown ? COLLAPSE : EXPAND} size={16} color={c.mutedForeground} />
        </Pressable>
      </View>
      {shown && current ? <Panel index={current} /> : null}
      <Sheet visible={editing} onClose={() => setEditing(false)}>
        <Text variant="title">Indices</Text>
        {INDEX_CHOICES.map((i) => (
          <Pressable
            key={i.key}
            testID={`index-pick-${i.symbol}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: strip.includes(i.key) }}
            onPress={() => toggle(i.key)}
            style={styles.pick}
          >
            <Text>{strip.includes(i.key) ? '✓ ' : '    '}</Text>
            <Text>{i.symbol}</Text>
          </Pressable>
        ))}
        <Pressable
          testID="index-edit-done"
          accessibilityRole="button"
          onPress={() => setEditing(false)}
          style={styles.pick}
        >
          <Text style={styles.editLabel}>Done</Text>
        </Pressable>
      </Sheet>
    </View>
  )
}

function Chip(p: { index: IndexChoice; selected: boolean; onPress: () => void }) {
  const unknown = useIsUnknown(p.index.exchange, p.index.symbol)
  return (
    <ChipFrame {...p}>
      {unknown ? <Text tone="muted">--</Text> : <ChipPrice index={p.index} />}
    </ChipFrame>
  )
}

function ChipPrice({ index }: { index: IndexChoice }) {
  const q = useLiveQuote(index.exchange, index.symbol, 2)
  return (
    <>
      <Price value={q?.ltp} />
      <Change change={q?.change} pct={q?.changePct} />
    </>
  )
}

function ChipFrame(p: {
  index: IndexChoice
  selected: boolean
  onPress: () => void
  children: React.ReactNode
}) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={`index-${p.index.symbol}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: p.selected }}
      onPress={p.onPress}
      style={[styles.chip, { borderColor: p.selected ? c.primary : c.border }]}
    >
      <Text variant="caption" tone="muted">
        {p.index.symbol}
      </Text>
      {p.children}
    </Pressable>
  )
}

function Panel({ index }: { index: IndexChoice }) {
  const unknown = useIsUnknown(index.exchange, index.symbol)
  const funds = useFunds({ enabled: true })
  const f = funds.data
  return (
    <View testID="index-panel" style={styles.panel}>
      {unknown ? null : <DayRange index={index} />}
      <Figure label="Available" id="available" value={f?.availablecash} />
      <Figure label="Used margin" id="used" value={f?.utiliseddebits} />
    </View>
  )
}

function DayRange({ index }: { index: IndexChoice }) {
  const q = useLiveQuote(index.exchange, index.symbol, 2)
  return (
    <>
      <Figure label="Open" id="open" value={q?.open} />
      <Figure label="High" id="high" value={q?.high} />
      <Figure label="Low" id="low" value={q?.low} />
      <Figure label="Prev close" id="close" value={q?.close} />
    </>
  )
}

function Figure(p: { label: string; id: string; value: number | undefined }) {
  return (
    <View style={styles.figure}>
      <Text variant="caption" tone="muted">
        {p.label}
      </Text>
      <Text variant="mono" testID={`index-panel-${p.id}`}>
        {fmtPrice(p.value)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flex: 1, paddingLeft: 16 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
    minWidth: 104,
  },
  collapsed: { height: 32, paddingVertical: 0, justifyContent: 'center' },
  barLabel: { flex: 1, paddingLeft: 16 },
  edit: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  toggle: { minHeight: 44, justifyContent: 'center', paddingRight: 12, paddingLeft: 4 },
  toggleBar: { minHeight: 32 },
  editLabel: { fontWeight: '600' },
  pick: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  panel: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, paddingTop: 8, gap: 16 },
  figure: { minWidth: 80 },
})
