// The instrument sheet (design 7.5): symbol, name, price, and what you can do next: trade, chart,
// depth, option chain, or keep it in the active watchlist. An expired or unknown contract shows
// only that, and takes no feed slot.
import { type Href, useRouter } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { log } from '~/core/log/logger'
import { useLiveQuote } from '~/core/realtime/useLive'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { chartHref, depthHref, ticketHref, toolHref } from '~/market/links'
import { useBrokerBlocked } from '~/market/session'
import { useTrading, useWatchlists } from '~/market/trading'
import type { Side } from '~/market/types'
import { addItem, removeItem, type Watchlists } from '~/market/watchlists/model'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Change } from '~/ui/Change'
import { Price } from '~/ui/Price'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'

/** No option chain for these (M4 replaces this with a symbol-master check). */
const NO_OPTION_CHAIN: ReadonlySet<string> = new Set([
  'CDS',
  'BCD',
  'CRYPTO',
  'GLOBAL_INDEX',
  'MCX_INDEX',
  'NCDEX',
])

const activeOf = (w: Watchlists) => w.lists.find((l) => l.id === w.activeId) ?? w.lists[0]

export function InstrumentSheet({ exchange, symbol }: { exchange: string; symbol: string }) {
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  const unknown = refused || inst.unknown
  return (
    <ScrollView contentContainerStyle={styles.body} testID="instrument-sheet">
      <BrokerBanner />
      <View style={styles.head}>
        <Text variant="title">{symbol}</Text>
        {inst.meta?.name ? (
          <Text tone="muted" numberOfLines={2}>
            {inst.meta.name}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted">
          {exchange}
        </Text>
        {unknown ? (
          <Badge testID="inst-unknown" label="Expired or unknown" tone="warning" />
        ) : inst.loading ? (
          <Skeleton />
        ) : (
          <Quote exchange={exchange} symbol={symbol} />
        )}
      </View>
      {unknown || inst.loading ? null : <Actions exchange={exchange} symbol={symbol} />}
      <WatchToggle exchange={exchange} symbol={symbol} />
    </ScrollView>
  )
}

function Quote({ exchange, symbol }: { exchange: string; symbol: string }) {
  const q = useLiveQuote(exchange, symbol, 2)
  return (
    <View>
      <Price value={q?.ltp} testID="inst-ltp" />
      <Change change={q?.change} pct={q?.changePct} testID="inst-change" />
    </View>
  )
}

function Actions({ exchange, symbol }: { exchange: string; symbol: string }) {
  const router = useRouter()
  const blocked = useBrokerBlocked()
  // The sheet is replaced, not stacked under: a push after a sheet would sit beneath it on iOS.
  const go = (href: string) => router.replace(href as Href)
  const trade = (action: Side) => go(ticketHref({ exchange, symbol, action }))
  return (
    <View style={styles.actions}>
      {isQuoteOnly(exchange) ? null : (
        <View style={styles.pair}>
          <View style={styles.fill}>
            <Button
              testID="inst-buy"
              title="BUY"
              variant="buy"
              disabled={blocked}
              onPress={() => trade('BUY')}
            />
          </View>
          <View style={styles.fill}>
            <Button
              testID="inst-sell"
              title="SELL"
              variant="sell"
              disabled={blocked}
              onPress={() => trade('SELL')}
            />
          </View>
        </View>
      )}
      <Button
        testID="inst-chart"
        title="Chart"
        variant="secondary"
        onPress={() => go(chartHref(exchange, symbol))}
      />
      <Button
        testID="inst-depth"
        title="Market depth"
        variant="secondary"
        onPress={() => go(depthHref(exchange, symbol))}
      />
      {NO_OPTION_CHAIN.has(exchange) ? null : (
        <Button
          testID="inst-optionchain"
          title="Option chain"
          variant="secondary"
          onPress={() => go(toolHref('optionchain', { u: `${exchange}:${symbol}` }))}
        />
      )}
    </View>
  )
}

/** Adds the symbol to the active list, or removes it when it is already there. */
function WatchToggle({ exchange, symbol }: { exchange: string; symbol: string }) {
  const { watchlists } = useTrading()
  const list = useWatchlists(activeOf)
  const inList = list?.items.some((i) => i.exchange === exchange && i.symbol === symbol) ?? false
  const [busy, setBusy] = useState(false)

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
    <View style={styles.actions}>
      <Button
        testID="inst-watch"
        title={inList ? `Remove from ${list?.name ?? 'list'}` : `Add to ${list?.name ?? 'list'}`}
        variant="secondary"
        disabled={busy}
        onPress={() => void onPress()}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 16 },
  head: { gap: 4 },
  actions: { gap: 12 },
  pair: { flexDirection: 'row', gap: 12 },
  fill: { flex: 1 },
})
