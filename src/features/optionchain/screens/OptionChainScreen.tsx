// The native Option Chain (design 7.8, 17.4): one underlying's ladder at one expiry, its legs live
// at Depth and repriced on every tick, and BUY or SELL on any leg into the order ticket. The
// header stays; only the ladder scrolls, opening centred on the strike nearest the live spot and
// moving only when the underlying, the expiry or the count changes (ux OC-1, OC-4). It is never
// blank: a skeleton while a chain is out, the server's sentence and Try again when the first read
// fails, the rows kept and a line when a refresh fails (OC-7).
import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list'
import { type Href, useRouter } from 'expo-router'
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  BackHandler,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { useFeedStale } from '~/core/realtime/useQuote'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { chartHref, depthHref, ticketHref } from '~/market/links'
import { DEFAULT_STRIKE_COUNT } from '~/market/options/live'
import type { ChainLeg } from '~/market/options/schemas'
import type { Side as OrderSide } from '~/market/types'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { useReduceMotion } from '~/ui/useReduceMotion'
import { ChainHeader } from '../components/ChainHeader'
import { ChainSkeleton } from '../components/ChainSkeleton'
import { CountPicker, ExpiryPicker } from '../components/ExpiryPicker'
import { LegSheet } from '../components/LegSheet'
import {
  rowHeight,
  type Side,
  SpotMarker,
  StrikeRow,
  type StrikeRowProps,
} from '../components/StrikeRow'
import { UnderlyingPicker } from '../components/UnderlyingPicker'
import { useChainFeed } from '../hooks/useChainFeed'
import { useOptionChain } from '../hooks/useOptionChain'
import {
  CHAIN_LINK_INCOMPLETE,
  type ChainTarget,
  type ChainView,
  chainSession,
  DEFAULT_TARGET,
  footerLine,
  type Greek,
  type GreekPair,
  type LadderItem,
  ladderItems,
  legTicket,
  maxOi,
  noExpiries,
  noStrikes,
  pickGreek,
  refreshFailed,
} from '../model'

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }
/** The footer's height at font scale 1: a 12 sp line and its padding. */
const FOOTER_LINE = 28

type Sheet =
  | { kind: 'underlying' }
  | { kind: 'expiry' }
  | { kind: 'count' }
  | { kind: 'leg'; strike: number; side: Side }

const keyOf = (i: LadderItem) => (i.kind === 'spot' ? 'spot' : `r${i.row.strike}`)
const typeOf = (i: LadderItem) => i.kind

/** `initial` null opens NIFTY on NFO. */
export function OptionChainScreen({ initial }: { initial: ChainTarget | null }) {
  const router = useRouter()
  const s = useServices()
  const { c } = useTheme()
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS
  const { height: windowHeight, fontScale } = useWindowDimensions()
  const active = useScreenActive()
  const polling = useConnection((st) => st.feed === 'polling')
  const live = !polling
  const feeding = active && live
  const stale = useFeedStale()
  const reduceMotion = useReduceMotion()

  const [target, setTarget] = useState<ChainTarget>(initial ?? DEFAULT_TARGET)
  const [picked, setPicked] = useState<string | null>(null)
  const [count, setCount] = useState<number>(DEFAULT_STRIKE_COUNT)
  const [view, setViewState] = useState<ChainView>(chainSession.view)
  const [greeks, setGreeks] = useState<GreekPair>(chainSession.greeks)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [lots, setLots] = useState(1)

  const read = useOptionChain({ target, picked, count, active, live })
  const { chain, expiry } = read
  const feed = useChainFeed({ chain, target, active, live })

  const setView = (v: ChainView) => {
    chainSession.view = v
    setViewState(v)
  }
  const onGreek = (g: Greek) => {
    const next = pickGreek(greeks, g)
    chainSession.greeks = next
    setGreeks(next)
  }

  // Android's back closes a sheet before it leaves the screen (ux G12).
  const open = sheet !== null
  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSheet(null)
      return true
    })
    return () => sub.remove()
  }, [open])

  // --- The ladder ---------------------------------------------------------------------------
  const height = rowHeight(fontScale)
  const spot = feed.pricing?.spot ?? chain?.underlying_ltp ?? 0
  const ladder = useMemo(() => ladderItems(chain?.chain ?? [], spot), [chain, spot])
  const oiMax = useMemo(() => maxOi(chain?.chain ?? []), [chain])
  // The body is laid out while its skeleton shows, so the first list knows where its middle is.
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  const onBodyLayout = (e: LayoutChangeEvent) => setBodyHeight(e.nativeEvent.layout.height)
  const listRef = useRef<FlashListRef<LadderItem>>(null)
  const [atmInView, setAtmInView] = useState(true)
  const onViewable = useRef((info: { viewableItems: ViewToken<LadderItem>[] }) => {
    setAtmInView(info.viewableItems.some((v) => v.item?.kind === 'row' && v.item.atm))
  }).current

  const onLeg = useCallback((strike: number, side: Side) => {
    setLots(1)
    setSheet({ kind: 'leg', strike, side })
  }, [])
  const rowProps: Omit<StrikeRowProps, 'item'> = {
    underlying: target.underlying,
    optionsExchange: target.optionsExchange,
    view,
    greeks,
    pricing: feed.pricing,
    feeding,
    stale,
    maxOi: oiMax,
    height,
    reduceMotion,
    onLeg,
  }
  const renderItem = ({ item }: { item: LadderItem }) =>
    item.kind === 'spot' ? <SpotMarker spot={item.spot} /> : <StrikeRow item={item} {...rowProps} />

  // Centred on ATM at the first layout of each underlying, expiry and count (a new list).
  const listKey = `${target.optionsExchange}:${target.underlying}|${expiry}|${count}`
  // less the footer's line
  const viewHeight = (bodyHeight ?? windowHeight * 0.6) - FOOTER_LINE * Math.min(fontScale, 1.3)
  const jumpToAtm = () =>
    void listRef.current?.scrollToIndex({
      index: ladder.atmIndex,
      animated: !reduceMotion,
      viewPosition: 0.5,
    })

  // --- What the body shows -------------------------------------------------------------------
  let body: ReactNode
  if (read.expiriesError) {
    body = (
      <View testID="oc-error">
        <ErrorState error={read.expiriesError} onRetry={read.retry} />
      </View>
    )
  } else if (read.expiries !== undefined && read.expiries.length === 0) {
    // the server answers no expiries while it reloads its symbols (the day's first broker
    // login): reading the list again is the way back, not only another underlying
    body = (
      <EmptyState
        title={noExpiries(target.underlying)}
        action={
          <View style={styles.emptyActions}>
            <Button testID="oc-empty-retry" title="Try again" onPress={read.retry} />
            <Button
              testID="oc-empty-underlying"
              title="Pick another underlying"
              variant="secondary"
              onPress={() => setSheet({ kind: 'underlying' })}
            />
          </View>
        }
      />
    )
  } else if (read.chainError) {
    body = (
      <View testID="oc-error">
        <ErrorState error={read.chainError} onRetry={read.retry} />
      </View>
    )
  } else if (!chain || read.chainPending) {
    body = <ChainSkeleton height={height} />
  } else if (chain.chain.length === 0) {
    body = (
      <EmptyState
        title={noStrikes(target.underlying, expiry ?? chain.expiry_date)}
        action={
          <Button
            testID="oc-empty-expiry"
            title="Pick another expiry"
            variant="secondary"
            onPress={() => setSheet({ kind: 'expiry' })}
          />
        }
      />
    )
  } else {
    body = (
      <>
        {read.refreshFailedAt !== null ? (
          <Text
            testID="oc-refresh-error"
            style={[styles.refresh, { color: c.foreground, backgroundColor: c.muted }]}
          >
            {refreshFailed(read.refreshFailedAt)}
          </Text>
        ) : null}
        <View style={styles.fill}>
          <FlashList
            key={listKey}
            ref={listRef}
            testID="oc-ladder"
            data={ladder.items}
            keyExtractor={keyOf}
            getItemType={typeOf}
            renderItem={renderItem}
            extraData={rowProps}
            initialScrollIndex={ladder.atmIndex >= 0 ? ladder.atmIndex : undefined}
            initialScrollIndexParams={{ viewOffset: -(viewHeight - height) / 2 }}
            onViewableItemsChanged={onViewable}
          />
          {atmInView || ladder.atmIndex < 0 ? null : (
            <Pressable
              testID="oc-jump-atm"
              accessibilityRole="button"
              accessibilityLabel="Back to ATM"
              hitSlop={4}
              onPress={jumpToAtm}
              style={[styles.jump, { backgroundColor: c.primary }]}
            >
              <Text style={[styles.jumpText, { color: c.primaryForeground }]}>ATM</Text>
            </Pressable>
          )}
        </View>
        <Text testID="oc-footer" tone="muted" numberOfLines={1} style={styles.footer}>
          {footerLine(chain.chain, read.updatedAt)}
        </Text>
      </>
    )
  }

  // --- Sheets -------------------------------------------------------------------------------
  const close = () => setSheet(null)
  const selectedLeg: ChainLeg | null =
    sheet?.kind === 'leg'
      ? (chain?.chain.find((r) => r.strike === sheet.strike)?.[sheet.side] ?? null)
      : null
  const trade = (leg: ChainLeg, side: OrderSide) =>
    router.push(ticketHref(legTicket(leg, side, lots, target.optionsExchange)) as Href)

  return (
    <View testID="oc-screen" style={[styles.fill, { backgroundColor: c.background }]}>
      <ChainHeader
        topInset={insets.top}
        target={target}
        chain={chain}
        underlyingKey={feed.underlyingKey}
        feeding={feeding}
        expiries={read.expiries}
        expiry={expiry}
        nowMs={s.clock.now()}
        count={count}
        view={view}
        greeks={greeks}
        pollMs={read.pollMs}
        onBack={() => router.back()}
        onUnderlying={() => setSheet({ kind: 'underlying' })}
        onExpiry={setPicked}
        onMoreExpiries={() => setSheet({ kind: 'expiry' })}
        onCount={() => setSheet({ kind: 'count' })}
        onView={setView}
        onGreek={onGreek}
      />
      <BrokerBanner />
      <View style={[styles.fill, { paddingBottom: insets.bottom }]} onLayout={onBodyLayout}>
        {body}
      </View>

      {sheet?.kind === 'underlying' ? (
        <UnderlyingPicker
          target={target}
          onClose={close}
          onPick={(t) => {
            setTarget(t)
            setPicked(null)
            close()
          }}
        />
      ) : null}
      {sheet?.kind === 'expiry' && read.expiries ? (
        <ExpiryPicker
          expiries={read.expiries}
          selected={expiry}
          nowMs={s.clock.now()}
          onClose={close}
          onPick={(e) => {
            setPicked(e)
            close()
          }}
        />
      ) : null}
      {sheet?.kind === 'count' ? (
        <CountPicker
          count={count}
          onClose={close}
          onPick={(n) => {
            setCount(n)
            close()
          }}
        />
      ) : null}
      {sheet?.kind === 'leg' && selectedLeg && expiry ? (
        <LegSheet
          leg={selectedLeg}
          strike={sheet.strike}
          side={sheet.side}
          underlying={target.underlying}
          optionsExchange={target.optionsExchange}
          expiry={expiry}
          pricing={feed.pricing}
          feeding={feeding}
          lots={lots}
          onLots={setLots}
          onTrade={trade}
          onChart={(leg) => router.push(chartHref(target.optionsExchange, leg.symbol) as Href)}
          onDepth={(leg) => router.push(depthHref(target.optionsExchange, leg.symbol) as Href)}
          onClose={close}
        />
      ) : null}
    </View>
  )
}

/** A link that names no chain: it says so, with a way back (the route has no header). */
export function ChainLinkIncomplete() {
  const router = useRouter()
  const { c } = useTheme()
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS
  return (
    <View
      testID="oc-screen-incomplete"
      style={[styles.fill, { backgroundColor: c.background, paddingTop: insets.top + 8 }]}
    >
      <EmptyState title={CHAIN_LINK_INCOMPLETE} />
      <View style={styles.back}>
        <Button testID="oc-back" title="Back" variant="secondary" onPress={() => router.back()} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  back: { paddingHorizontal: 16 },
  refresh: { fontSize: 12, paddingHorizontal: 12, paddingVertical: 4 },
  footer: {
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontVariant: ['tabular-nums'],
  },
  jump: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    minHeight: 36,
    minWidth: 56,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpText: { fontWeight: '700', fontSize: 13 },
  emptyActions: { alignSelf: 'stretch', gap: 12 },
})
