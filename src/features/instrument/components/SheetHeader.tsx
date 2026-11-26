// The instrument sheet's header, its drag area (design 17.2): the symbol over its exchange, LTP
// and change in the colour of the change, and the watchlist toggle. It only reads the quote that
// the sheet's one subscription brings (ruling 31). An expired or unknown contract shows no price.
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import { quoteKey } from '~/core/realtime/protocol'
import { useFeedStale, useQuote } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { exchangeLabel } from '~/market/instruments/exchanges'
import { useTrading, useWatchlists } from '~/market/trading'
import { addItem, removeItem, type Watchlists } from '~/market/watchlists/model'
import { Change } from '~/ui/Change'
import { signOf } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { Price } from '~/ui/Price'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'

const ADD: IconName = { ios: 'bookmark', android: 'bookmark_add' }
const IN_LIST: IconName = { ios: 'bookmark.fill', android: 'bookmark_added' }

type Key = { exchange: string; symbol: string }

export function SheetHeader(p: Key & { priced: boolean }) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text variant="heading" numberOfLines={1}>
          {p.symbol}
        </Text>
        {p.priced ? (
          <PricedSub exchange={p.exchange} symbol={p.symbol} />
        ) : (
          <Text testID="inst-sub" variant="caption" tone="muted">
            {exchangeLabel(p.exchange)}
          </Text>
        )}
      </View>
      <WatchToggle exchange={p.exchange} symbol={p.symbol} />
    </View>
  )
}

/** "NSE · 1,500.00 +10.00 (+0.67%)": the price and change take the change's colour. */
function PricedSub({ exchange, symbol }: Key) {
  const active = useScreenActive()
  const q = useQuote(quoteKey(exchange, symbol), active)
  const stale = useFeedStale()
  return (
    <Text testID="inst-sub" numberOfLines={1} style={{ opacity: stale ? 0.5 : 1 }}>
      <Text variant="caption" tone="muted">{`${exchangeLabel(exchange)} · `}</Text>
      <Price value={q?.ltp} sign={signOf(q?.change)} testID="inst-ltp" />{' '}
      <Change change={q?.change} pct={q?.changePct} testID="inst-change" />
    </Text>
  )
}

const activeOf = (w: Watchlists) => w.lists.find((l) => l.id === w.activeId) ?? w.lists[0]

/** Adds the symbol to the active list, or removes it when it is already there. */
function WatchToggle({ exchange, symbol }: Key) {
  const { c } = useTheme()
  const { watchlists } = useTrading()
  const list = useWatchlists(activeOf)
  const inList = list?.items.some((i) => i.exchange === exchange && i.symbol === symbol) ?? false
  const [busy, setBusy] = useState(false)
  const name = list?.name ?? 'list'

  const onPress = async () => {
    if (busy) return
    setBusy(true)
    try {
      // the store is shared with the watchlist tab; changing unloaded defaults would overwrite it
      if (!watchlists.getState().loaded) await watchlists.getState().load()
      const target = activeOf(watchlists.getState().data)
      if (!target) return
      const item = { exchange, symbol }
      const has = target.items.some((i) => i.exchange === exchange && i.symbol === symbol)
      if (has) {
        await watchlists.getState().apply(removeItem, target.id, item)
        toast(`Removed ${symbol} from ${target.name}`)
      } else {
        const r = await watchlists.getState().apply(addItem, target.id, item)
        toast(
          r === 'added'
            ? `Added ${symbol} to ${target.name}`
            : r === 'full'
              ? 'This list is full'
              : 'Already in this list',
        )
      }
    } catch (e) {
      log.warn('instrument', 'could not save the lists', e)
      toast('Could not save your lists. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pressable
      testID="inst-watch"
      accessibilityRole="button"
      accessibilityLabel={inList ? `Remove from ${name}` : `Add to ${name}`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      hitSlop={4}
      onPress={() => void onPress()}
      style={styles.toggle}
    >
      <Icon name={inList ? IN_LIST : ADD} size={22} color={inList ? c.primary : c.foreground} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8 },
  text: { flex: 1, minWidth: 0, gap: 2, paddingBottom: 12 },
  toggle: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
})
