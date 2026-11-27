// The instrument sheet (design 17.2), Kite's: it opens at half height, and its header drags, or
// its handle taps, it to full height. The header holds the symbol, the price and the watchlist
// toggle; the body BUY and SELL, the chart, option chain (an NSE stock's once it is known to list
// options) and GTT links, the depth, and at full height the day's quote. The depth panel holds the
// sheet's one subscription (an index, with no book, holds its mode-2 quote instead); the rest only
// read its quote. An expired or unknown contract shows only that, and takes no feed slot.
import { type Href, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import { DepthPanel } from '~/features/depth'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { useGttSupport } from '~/market/gtt/queries'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { chartHref, gttHref, optionChainHref, ticketHref } from '~/market/links'
import { useOptionChainTarget } from '~/market/optionChain'
import { useBrokerBlocked } from '~/market/session'
import type { Side } from '~/market/types'
import { Badge } from '~/ui/Badge'
import { BottomSheet } from '~/ui/BottomSheet'
import { Button } from '~/ui/Button'
import { Icon, type IconName } from '~/ui/Icon'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { QuoteDetails } from '../components/QuoteDetails'
import { SheetHeader } from '../components/SheetHeader'

const SNAP_POINTS = [0.5, 1] as const
const CHART: IconName = { ios: 'chart.xyaxis.line', android: 'show_chart' }
const CHAIN: IconName = { ios: 'list.bullet.rectangle', android: 'view_list' }
const GTT: IconName = { ios: 'clock', android: 'schedule' }

type Key = { exchange: string; symbol: string }

export function InstrumentSheet({ exchange, symbol }: Key) {
  const router = useRouter()
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  const unknown = refused || inst.unknown
  const [expanded, setExpanded] = useState(false)
  return (
    <BottomSheet
      testID="instrument-sheet"
      snapPoints={SNAP_POINTS}
      onClose={router.back}
      onSnap={(index) => setExpanded(index === 1)}
      header={<SheetHeader exchange={exchange} symbol={symbol} priced={!unknown} />}
    >
      <View style={styles.body}>
        <BrokerBanner />
        {unknown ? (
          <Badge testID="inst-unknown" label="Expired or unknown" tone="warning" />
        ) : inst.loading ? (
          <Skeleton />
        ) : (
          <Body
            exchange={exchange}
            symbol={symbol}
            meta={inst.meta ?? { exchange, symbol, name: '' }}
            expanded={expanded}
          />
        )}
      </View>
    </BottomSheet>
  )
}

function Body(
  p: Key & { meta: Pick<InstrumentMeta, 'exchange' | 'symbol' | 'name'>; expanded: boolean },
) {
  const { exchange, symbol } = p
  const router = useRouter()
  const gtt = useGttSupport(exchange)
  // The sheet is replaced, not stacked under: a push after a modal would sit beneath it on iOS.
  const go = (href: string) => router.replace(href as Href)
  const quoteOnly = isQuoteOnly(exchange)
  const chain = useOptionChainTarget(p.meta)
  return (
    <>
      {quoteOnly ? (
        <IndexQuote exchange={exchange} symbol={symbol} />
      ) : (
        <Trade exchange={exchange} symbol={symbol} go={go} />
      )}
      <View style={styles.actions}>
        <Action
          testID="inst-chart"
          icon={CHART}
          title="View chart"
          onPress={() => go(chartHref(exchange, symbol))}
        />
        {chain ? (
          <Action
            testID="inst-optionchain"
            icon={CHAIN}
            title="Option chain"
            onPress={() => go(optionChainHref(chain.exchange, chain.symbol))}
          />
        ) : null}
        {gtt.state === 'yes' ? (
          <Action
            testID="inst-gtt"
            icon={GTT}
            title="Create GTT"
            onPress={() => go(gttHref({ exchange, symbol }))}
          />
        ) : null}
      </View>
      {quoteOnly ? null : (
        <DepthPanel exchange={exchange} symbol={symbol} onLevel={(t) => go(ticketHref(t))} />
      )}
      {p.expanded ? <QuoteDetails exchange={exchange} symbol={symbol} /> : null}
    </>
  )
}

/** An index has no book for a depth panel to hold: its mode-2 quote is the sheet's feed. */
function IndexQuote({ exchange, symbol }: Key) {
  useLiveQuote(exchange, symbol, 2)
  return null
}

/** BUY (green) and SELL (red), side by side; disabled while the broker is blocked. */
function Trade({ exchange, symbol, go }: Key & { go: (href: string) => void }) {
  const blocked = useBrokerBlocked()
  const trade = (action: Side) => go(ticketHref({ exchange, symbol, action }))
  return (
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
  )
}

function Action(p: { testID: string; icon: IconName; title: string; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      onPress={p.onPress}
      style={[styles.action, { borderColor: c.border }]}
    >
      <Icon name={p.icon} size={16} color={c.primary} />
      <Text style={[styles.actionLabel, { color: c.primary }]}>{p.title}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 16, gap: 16 },
  pair: { flexDirection: 'row', gap: 12 },
  fill: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  actionLabel: { fontWeight: '600' },
})
