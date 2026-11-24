// One watchlist row. It reads only its own symbol, so a tick re-renders this row alone.
import { memo, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useFeedStale } from '~/core/realtime/useQuote'
import { Change } from '~/ui/Change'
import { Price } from '~/ui/Price'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'

export const ROW_HEIGHT = 56
export const FLASH_MS = 400

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

type Props = { exchange: string; symbol: string; reduceMotion?: boolean }

export const WatchRow = memo(function WatchRow({ exchange, symbol, reduceMotion = false }: Props) {
  const { c } = useTheme()
  const q = useLiveQuote(exchange, symbol, 2)
  const stale = useFeedStale()
  const id = `${exchange}-${symbol}`
  return (
    <View
      testID={`watch-row-${id}`}
      style={[styles.row, { borderBottomColor: c.border, opacity: stale ? 0.5 : 1 }]}
    >
      {reduceMotion ? null : <Flash id={id} ltp={q?.ltp} />}
      <View style={styles.left}>
        <Text variant="body" numberOfLines={1} style={styles.symbol}>
          {symbol}
        </Text>
        <Text variant="caption" tone="muted" style={[styles.tag, { borderColor: c.border }]}>
          {exchange}
        </Text>
      </View>
      <View style={styles.right}>
        <Price value={q?.ltp} testID={`watch-ltp-${id}`} />
        <Change change={q?.change} pct={q?.changePct} />
      </View>
    </View>
  )
})

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
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
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
})
