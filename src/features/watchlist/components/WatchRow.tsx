// One watchlist row, plain as in Kite (design 17.1): the symbol over its exchange and the held
// quantity, the LTP in the day change's colour over the change. A press opens the instrument
// sheet; a left swipe asks to remove. It reads only its own symbol, so a tick re-renders this row
// alone. An expired or unknown contract renders statically: no feed, no poll (ruling 8). In edit
// mode, as in Kite, the row is the symbol and the edit controls: the price column (or the expired
// badge) does not shrink, and beside four 44 pt controls it would leave the symbol a letter or two.
import { type Href, useRouter } from 'expo-router'
import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type AccessibilityActionEvent,
  Animated,
  PanResponder,
  type PanResponderGestureState,
  Pressable,
  StyleSheet,
  View,
} from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useFeedStale } from '~/core/realtime/useQuote'
import { exchangeLabel } from '~/market/instruments/exchanges'
import { useIsUnknown } from '~/market/instruments/useInstrument'
import { instrumentHref } from '~/market/links'
import { Badge } from '~/ui/Badge'
import { Change } from '~/ui/Change'
import { signOf } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { Price } from '~/ui/Price'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ROW_HEIGHT } from '../rows'
import { EditControls } from './EditControls'

export { ROW_HEIGHT }
export const FLASH_MS = 400
/** How far left a row must be dragged to ask to remove it. */
export const SWIPE_REMOVE_PX = 80
/** Horizontal travel before a drag counts as a swipe, not a tap or a scroll. */
const SWIPE_SLOP = 10
const BRIEFCASE: IconName = { ios: 'briefcase.fill', android: 'work' }

type Props = {
  exchange: string
  symbol: string
  /** The quantity held (holdings, else the net open position), for the briefcase marker. */
  held?: number
  reduceMotion?: boolean
  /** Edit mode: the edit controls show, and a press opens nothing. */
  editing?: boolean
  /** First and last within the row's group, where up and down stop. */
  first?: boolean
  last?: boolean
  /** Asks to remove the row (it confirms); without it there is no swipe and no remove action. */
  onRemove?: (exchange: string, symbol: string) => void
  onMove?: (exchange: string, symbol: string, by: -1 | 1) => void
  /** Edit mode: offers to move the row to a group. */
  onRegroup?: (exchange: string, symbol: string) => void
}

export const WatchRow = memo(function WatchRow(p: Props) {
  const { exchange, symbol, editing = false, onRegroup } = p
  const unknown = useIsUnknown(exchange, symbol)
  const id = `${exchange}-${symbol}`
  const remove = p.onRemove ? () => p.onRemove?.(exchange, symbol) : undefined
  const body = { id, exchange, symbol, held: p.held, editing, onRemove: remove }
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
          onRegroup={onRegroup ? () => onRegroup(exchange, symbol) : undefined}
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
  held?: number
  editing: boolean
  onRemove?: () => void
}

/** A priced row: the live LTP, coloured by the day change, over the change. */
function LiveBody(p: BodyProps & { reduceMotion?: boolean }) {
  const q = useLiveQuote(p.exchange, p.symbol, 2)
  const stale = useFeedStale()
  // Edit mode keeps the quote held (the hooks above), so leaving it asks the server for nothing.
  if (p.editing) return <Main {...p} dim={stale} />
  return (
    <>
      {p.reduceMotion ? null : <Flash id={p.id} ltp={q?.ltp} />}
      <Main {...p} dim={stale}>
        <View style={styles.right}>
          <Price value={q?.ltp} sign={signOf(q?.change)} testID={`watch-ltp-${p.id}`} />
          <Change change={q?.change} pct={q?.changePct} />
        </View>
      </Main>
    </>
  )
}

/** An expired or unknown contract: its name and a badge, nothing that would call the server. */
function UnknownBody(p: BodyProps) {
  return (
    <Main {...p}>
      {p.editing ? null : (
        <Badge testID={`watch-unknown-${p.id}`} label="Expired or unknown" tone="warning" />
      )}
    </Main>
  )
}

const REMOVE_ACTION = [{ name: 'remove', label: 'Remove' }]

/** The pressable part: the symbol and what follows it; a press opens the instrument sheet. */
function Main(p: BodyProps & { dim?: boolean; children?: ReactNode }) {
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
        <View style={styles.sub}>
          <Text testID={`watch-ex-${p.id}`} variant="caption" tone="muted">
            {exchangeLabel(p.exchange)}
          </Text>
          {p.held === undefined ? null : <Held id={p.id} quantity={p.held} />}
        </View>
      </View>
      {p.children}
    </Pressable>
  )
}

/** A fraction keeps 4 significant digits, to a satoshi's 8 decimals at most. */
const HELD_SIGNIFICANT = 4
const HELD_MAX_DECIMALS = 8

/**
 * A held quantity: a whole one as it is, a fractional one (CRYPTO) with up to 4 significant
 * decimals and no trailing zeros, so 0.004 stays 0.004 and 1.234567 reads 1.2346. A negative one
 * is signed, unless it reads as zero: never "-0".
 */
function fmtHeld(n: number): string {
  if (!Number.isFinite(n)) return '--'
  const abs = Math.abs(n)
  const frac = abs - Math.trunc(abs)
  // the fraction's leading zeros, then its significant digits
  const zeros = frac > 0 ? Math.max(0, Math.ceil(-Math.log10(frac)) - 1) : 0
  const decimals = frac > 0 ? Math.min(HELD_MAX_DECIMALS, zeros + HELD_SIGNIFICANT) : 0
  const body = abs.toLocaleString('en-IN', { maximumFractionDigits: decimals })
  return n < 0 && /[1-9]/.test(body) ? `-${body}` : body
}

/** The briefcase and the quantity held; a short position's is negative. */
function Held({ id, quantity }: { id: string; quantity: number }) {
  const { c } = useTheme()
  const text = fmtHeld(quantity)
  // the briefcase is decorative, so the label says what the number is
  const label = text.startsWith('-') ? `Short ${text.slice(1)}` : `Held ${text}`
  return (
    <View style={styles.held}>
      <Icon name={BRIEFCASE} size={11} color={c.mutedForeground} />
      <Text testID={`watch-held-${id}`} accessibilityLabel={label} variant="caption" tone="muted">
        {text}
      </Text>
    </View>
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
  sub: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  held: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  right: { alignItems: 'flex-end', justifyContent: 'center' },
})
