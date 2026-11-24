// One watchlist row. It reads only its own symbol, so a tick re-renders this row alone. An
// expired or unknown contract renders statically: no feed, no poll, no B/S (ruling 8).
import { type Href, useRouter } from 'expo-router'
import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type AccessibilityActionEvent,
  AccessibilityInfo,
  Animated,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  View,
} from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useFeedStale } from '~/core/realtime/useQuote'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import { useIsUnknown } from '~/market/instruments/useInstrument'
import { instrumentHref, ticketHref } from '~/market/links'
import { useBrokerBlocked } from '~/market/session'
import type { Side } from '~/market/types'
import { Badge } from '~/ui/Badge'
import { Change } from '~/ui/Change'
import { Price } from '~/ui/Price'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { EditControls } from './EditControls'

export const ROW_HEIGHT = 56
export const FLASH_MS = 400
/** How far left a row must be dragged to ask to remove it. */
export const SWIPE_REMOVE_PX = 80
/** Horizontal travel before a drag counts as a swipe, not a tap or a scroll. */
const SWIPE_SLOP = 10

/** The system's reduce-motion setting, read once per screen. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => live && setOn(v))
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn)
    return () => {
      live = false
      sub.remove()
    }
  }, [])
  return on
}

type Props = {
  exchange: string
  symbol: string
  reduceMotion?: boolean
  /** Edit mode: up, down and remove replace B/S, and a press opens nothing. */
  editing?: boolean
  first?: boolean
  last?: boolean
  /** Asks to remove the row (it confirms); without it there is no swipe and no remove action. */
  onRemove?: (exchange: string, symbol: string) => void
  onMove?: (exchange: string, symbol: string, by: -1 | 1) => void
}

export const WatchRow = memo(function WatchRow(p: Props) {
  const { exchange, symbol, editing = false } = p
  const unknown = useIsUnknown(exchange, symbol)
  const id = `${exchange}-${symbol}`
  const remove = p.onRemove ? () => p.onRemove?.(exchange, symbol) : undefined
  const body = { id, exchange, symbol, editing, onRemove: remove }
  return (
    <Swipe id={id} onRemove={editing ? undefined : remove}>
      {unknown ? <UnknownBody {...body} /> : <LiveBody {...body} reduceMotion={p.reduceMotion} />}
      {editing && remove ? (
        <EditControls
          id={id}
          symbol={symbol}
          first={p.first ?? true}
          last={p.last ?? true}
          onUp={() => p.onMove?.(exchange, symbol, -1)}
          onDown={() => p.onMove?.(exchange, symbol, 1)}
          onRemove={remove}
        />
      ) : null}
    </Swipe>
  )
})

type BodyProps = {
  id: string
  exchange: string
  symbol: string
  editing: boolean
  onRemove?: () => void
}

/** A priced row: the live quote, and B/S unless the exchange is quote-only or editing. */
function LiveBody(p: BodyProps & { reduceMotion?: boolean }) {
  const q = useLiveQuote(p.exchange, p.symbol, 2)
  const stale = useFeedStale()
  return (
    <>
      {p.reduceMotion ? null : <Flash id={p.id} ltp={q?.ltp} />}
      <Main {...p} dim={stale}>
        <View style={styles.right}>
          <Price value={q?.ltp} testID={`watch-ltp-${p.id}`} />
          <Change change={q?.change} pct={q?.changePct} />
        </View>
      </Main>
      {p.editing || isQuoteOnly(p.exchange) ? null : <TradeButtons {...p} />}
    </>
  )
}

/** An expired or unknown contract: its name and a badge, nothing that would call the server. */
function UnknownBody(p: BodyProps) {
  return (
    <Main {...p}>
      <Badge testID={`watch-unknown-${p.id}`} label="Expired or unknown" tone="warning" />
    </Main>
  )
}

const REMOVE_ACTION = [{ name: 'remove', label: 'Remove' }]

/** The pressable part: the symbol and what follows it; a press opens the instrument sheet. */
function Main(p: BodyProps & { dim?: boolean; children: ReactNode }) {
  const { c } = useTheme()
  const router = useRouter()
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'remove') p.onRemove?.()
  }
  return (
    <Pressable
      testID={`watch-row-${p.id}`}
      accessibilityRole="button"
      accessibilityActions={p.onRemove ? REMOVE_ACTION : undefined}
      onAccessibilityAction={p.onRemove ? onAction : undefined}
      onPress={
        p.editing ? undefined : () => router.push(instrumentHref(p.exchange, p.symbol) as Href)
      }
      style={[styles.main, { opacity: p.dim ? 0.5 : 1 }]}
    >
      <View style={styles.left}>
        <Text variant="body" numberOfLines={1} style={styles.symbol}>
          {p.symbol}
        </Text>
        <Text variant="caption" tone="muted" style={[styles.tag, { borderColor: c.border }]}>
          {p.exchange}
        </Text>
      </View>
      {p.children}
    </Pressable>
  )
}

/** B and S open the ticket; disabled while the broker is blocked. */
function TradeButtons(p: BodyProps) {
  const router = useRouter()
  const blocked = useBrokerBlocked()
  const { trade } = useTheme()
  const open = (action: Side) =>
    router.push(ticketHref({ exchange: p.exchange, symbol: p.symbol, action }) as Href)
  return (
    <View style={styles.trade}>
      <SideButton
        testID={`watch-buy-${p.id}`}
        glyph="B"
        label={`Buy ${p.symbol}`}
        bg={trade.buy}
        fg={trade.onBuy}
        disabled={blocked}
        onPress={() => open('BUY')}
      />
      <SideButton
        testID={`watch-sell-${p.id}`}
        glyph="S"
        label={`Sell ${p.symbol}`}
        bg={trade.sell}
        fg={trade.onSell}
        disabled={blocked}
        onPress={() => open('SELL')}
      />
    </View>
  )
}

function SideButton(p: {
  testID: string
  glyph: string
  label: string
  bg: string
  fg: string
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: p.disabled }}
      disabled={p.disabled}
      onPress={p.onPress}
      hitSlop={4}
      style={[styles.side, { backgroundColor: p.bg }, p.disabled && styles.off]}
    >
      <Text style={[styles.sideGlyph, { color: p.fg }]}>{p.glyph}</Text>
    </Pressable>
  )
}

/**
 * A left swipe past `SWIPE_REMOVE_PX` asks to remove the row (React Native's PanResponder, not
 * gesture-handler: ruling 2). The row springs back either way; the confirm decides.
 */
function Swipe(p: { id: string; onRemove?: () => void; children: ReactNode }) {
  const { c } = useTheme()
  const [x] = useState(() => new Animated.Value(0))
  const onRemove = useRef(p.onRemove)
  useEffect(() => {
    onRemove.current = p.onRemove
  })
  const [pan] = useState(() => {
    const back = () =>
      Animated.timing(x, { toValue: 0, duration: 150, useNativeDriver: true }).start()
    const isSwipe = (g: PanResponderGestureState) =>
      onRemove.current !== undefined && g.dx < -SWIPE_SLOP && Math.abs(g.dx) > 2 * Math.abs(g.dy)
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => isSwipe(g),
      onPanResponderMove: (_e, g) => x.setValue(Math.min(0, g.dx)),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        back()
        if (g.dx <= -SWIPE_REMOVE_PX) onRemove.current?.()
      },
      onPanResponderTerminate: back,
    })
  })
  return (
    <View style={styles.swipe}>
      {p.onRemove ? (
        <View style={[StyleSheet.absoluteFill, styles.hint, { backgroundColor: c.destructive }]}>
          <Text style={styles.hintText}>Remove</Text>
        </View>
      ) : null}
      <Animated.View
        testID={`watch-swipe-${p.id}`}
        {...pan.panHandlers}
        style={[
          styles.row,
          {
            backgroundColor: c.background,
            borderBottomColor: c.border,
            transform: [{ translateX: x }],
          },
        ]}
      >
        {p.children}
      </Animated.View>
    </View>
  )
}

/** A tint that fades out over 400 ms after the price moves; mounted only while it shows. */
function Flash({ id, ltp }: { id: string; ltp: number | undefined }) {
  const { trade } = useTheme()
  const last = useRef(ltp)
  const fade = useRef(new Animated.Value(0)).current
  const [dir, setDir] = useState<1 | -1 | 0>(0)
  useEffect(() => {
    const prev = last.current
    last.current = ltp
    if (prev === undefined || ltp === undefined || ltp === prev) return
    setDir(ltp > prev ? 1 : -1)
    fade.setValue(1)
    Animated.timing(fade, { toValue: 0, duration: FLASH_MS, useNativeDriver: true }).start()
    const t = setTimeout(() => setDir(0), FLASH_MS)
    return () => clearTimeout(t)
  }, [ltp, fade])
  if (dir === 0) return null
  return (
    <Animated.View
      testID={`watch-flash-${id}`}
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          opacity: Animated.multiply(fade, 0.18),
          backgroundColor: dir > 0 ? trade.profit : trade.loss,
        },
      ]}
    />
  )
}

const styles = StyleSheet.create({
  swipe: { height: ROW_HEIGHT, overflow: 'hidden' },
  hint: { alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 16 },
  hintText: { color: '#ffffff', fontWeight: '700' },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
  },
  left: { flex: 1, minWidth: 0, justifyContent: 'center' },
  symbol: { fontWeight: '600' },
  tag: {
    alignSelf: 'flex-start',
    marginTop: 2,
    fontSize: 10,
    paddingHorizontal: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 3,
    overflow: 'hidden',
  },
  right: { alignItems: 'flex-end', justifyContent: 'center' },
  trade: { flexDirection: 'row', gap: 6 },
  side: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  sideGlyph: { fontWeight: '700' },
  off: { opacity: 0.4 },
})
