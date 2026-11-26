// Quote and market depth (design 7.5): the day's quote over a ladder of bids and asks. A level
// tap opens a LIMIT ticket at its price, BUY and SELL a MARKET one. Where the broker's feed sends
// deeper books (C8) a level switch appears, kept only while the feed bears it out (ruling 10). An
// index shows its quote alone; an expired or unknown contract shows only that, and takes no feed
// slot (ruling 8). A book that does not come is a read error, with a retry (design 7.11).
import { type Href, useRouter } from 'expo-router'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { type Quote, quoteKey } from '~/core/realtime/protocol'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useFeedStale, useQuote } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { StaleNote } from '~/market/components/StaleNote'
import { isQuoteOnly, usesLots } from '~/market/instruments/exchanges'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { chartHref, ticketHref } from '~/market/links'
import { useBrokerBlocked } from '~/market/session'
import type { TicketParams } from '~/market/types'
import { Badge } from '~/ui/Badge'
import { Button } from '~/ui/Button'
import { Change } from '~/ui/Change'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { DepthPanel } from '../components/DepthPanel'

/** The footer's own padding above and below its buttons, before the safe-area inset. */
const FOOTER_PAD = 12

type Key = { exchange: string; symbol: string }

export function DepthScreen({ exchange, symbol }: Key) {
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  const name = inst.meta?.name
  return (
    <View style={styles.fill} testID="depth-screen">
      <BrokerBanner />
      {refused || inst.unknown ? (
        <View style={styles.body}>
          <Title exchange={exchange} symbol={symbol} />
          <Badge testID="depth-unknown" label="Expired or unknown" tone="warning" />
        </View>
      ) : inst.loading ? (
        <Skeleton />
      ) : isQuoteOnly(exchange) ? (
        <QuoteOnly exchange={exchange} symbol={symbol} name={name} />
      ) : (
        <Depth exchange={exchange} symbol={symbol} name={name} />
      )}
    </View>
  )
}

/** An index: its quote and a chart, nothing to trade (mode 2, no book). */
function QuoteOnly(p: Key & { name?: string }) {
  const q = useLiveQuote(p.exchange, p.symbol, 2)
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Header {...p} q={q} />
    </ScrollView>
  )
}

function Depth(p: Key & { name?: string }) {
  const { exchange, symbol } = p
  const router = useRouter()
  const active = useScreenActive()
  const blocked = useBrokerBlocked()
  const insets = useSafeAreaInsets()
  // The panel holds the book subscription; the header only reads its quote (ruling 31).
  const q = useQuote(quoteKey(exchange, symbol), active)
  const open = (t: TicketParams) => router.push(ticketHref(t) as Href)
  const market = (action: TicketParams['action']) =>
    open({ exchange, symbol, action, pricetype: 'MARKET' })

  return (
    <>
      <ScrollView contentContainerStyle={styles.body}>
        <Header {...p} q={q} />
        <DepthPanel exchange={exchange} symbol={symbol} onLevel={open} />
      </ScrollView>
      {/* The home indicator or gesture bar sits under the screen's bottom edge. */}
      <View
        testID="depth-footer"
        style={[styles.footer, { paddingBottom: FOOTER_PAD + insets.bottom }]}
      >
        <View style={styles.fill}>
          <Button
            testID="depth-buy"
            title="BUY"
            variant="buy"
            disabled={blocked}
            onPress={() => market('BUY')}
          />
        </View>
        <View style={styles.fill}>
          <Button
            testID="depth-sell"
            title="SELL"
            variant="sell"
            disabled={blocked}
            onPress={() => market('SELL')}
          />
        </View>
      </View>
    </>
  )
}

function Title({ exchange, symbol, name }: Key & { name?: string }) {
  return (
    <View style={styles.title}>
      <Text variant="heading" numberOfLines={1}>
        {symbol}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {name ? `${name} · ${exchange}` : exchange}
      </Text>
    </View>
  )
}

/** LTP and change, the day's range, prev close and volume, and OI where contracts trade in lots. */
function Header(p: Key & { name?: string; q: Quote | undefined }) {
  const { exchange, symbol, q } = p
  const router = useRouter()
  const stale = useFeedStale()
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Title {...p} />
        <Button
          testID="depth-chart"
          title="Chart"
          variant="secondary"
          onPress={() => router.push(chartHref(exchange, symbol) as Href)}
        />
      </View>
      <View style={{ opacity: stale ? 0.5 : 1 }}>
        <Text variant="title" testID="depth-ltp" style={styles.ltp}>
          {fmtPrice(q?.ltp)}
        </Text>
        <Change change={q?.change} pct={q?.changePct} testID="depth-change" />
        <View style={styles.stats}>
          <Stat testID="depth-open" label="Open" value={fmtPrice(q?.open)} />
          <Stat testID="depth-high" label="High" value={fmtPrice(q?.high)} />
          <Stat testID="depth-low" label="Low" value={fmtPrice(q?.low)} />
          <Stat testID="depth-prev-close" label="Prev close" value={fmtPrice(q?.close)} />
          <Stat testID="depth-volume" label="Volume" value={fmtQty(q?.volume)} />
          {usesLots(exchange) ? <Stat testID="depth-oi" label="OI" value={fmtQty(q?.oi)} /> : null}
        </View>
      </View>
      {stale && q ? <StaleNote at={q.ts} /> : null}
    </View>
  )
}

function Stat({ testID, label, value }: { testID: string; label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="mono" testID={testID}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 16 },
  header: { gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, minWidth: 0, gap: 2 },
  ltp: { fontVariant: ['tabular-nums'] },
  stats: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8, marginTop: 8 },
  stat: { width: '33%', gap: 2 },
  footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: FOOTER_PAD },
})
