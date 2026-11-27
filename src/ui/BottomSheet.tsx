// A sheet over a dimmed backdrop that rests at snap points, each a share of the height. Only the
// header drags, so a drag in the body (a depth ladder, a list) scrolls the body instead. Screen
// readers and Maestro cannot drag: the handle is a button and the backdrop closes (RF 5).
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native'
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler'
import Animated, {
  SnappySpringConfig,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { type EdgeInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'
import { SHEET_CLOSE_MS, sheetOffsets, snapIndexFor } from './sheetMath'
import { useTheme } from './theme'
import { useReduceMotionRef } from './useReduceMotion'

const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 }
const HALF_AND_FULL = [0.5, 1] as const

type Props = {
  testID: string
  /** Shares of the height the sheet rests at, smallest first. */
  snapPoints?: readonly number[]
  /** The snap point it opens at. */
  initial?: number
  /** Called once the sheet has slid down: the owner removes it (a route goes back). */
  onClose(): void
  onSnap?(index: number): void
  /** The drag area, under the handle. */
  header: ReactNode
  children: ReactNode
}

export function BottomSheet({
  testID,
  snapPoints = HALF_AND_FULL,
  initial = 0,
  onClose,
  onSnap,
  header,
  children,
}: Props) {
  const { c } = useTheme()
  const { height: windowHeight } = useWindowDimensions()
  // Read without the throwing hook, so a sheet renders without a provider (tests) as if insetless.
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS
  const [boxHeight, setBoxHeight] = useState<number | null>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [index, setIndex] = useState(initial)
  // The panel runs from below the status bar to the bottom; snap points are shares of that.
  const height = (boxHeight ?? windowHeight) - insets.top
  const offsets = sheetOffsets(snapPoints, height)
  const offsetOf = (i: number) => offsets[i] ?? 0
  const top = Math.min(...offsets)

  const y = useSharedValue(offsetOf(initial))
  const start = useSharedValue(0)
  const closing = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reduceMotion = useReduceMotionRef()

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  function snapTo(i: number) {
    if (closing.current) return
    y.value = reduceMotion.current ? offsetOf(i) : withSpring(offsetOf(i), SnappySpringConfig)
    setIndex(i)
    onSnap?.(i)
  }

  // onClose runs from a JS timer, never from the animation's callback, so fake timers decide it.
  function close() {
    if (closing.current) return
    closing.current = true
    if (reduceMotion.current) {
      y.value = height
      onClose()
      return
    }
    y.value = withTiming(height, { duration: SHEET_CLOSE_MS })
    closeTimer.current = setTimeout(onClose, SHEET_CLOSE_MS)
  }

  function release(at: number, vy: number) {
    const to = snapIndexFor(at, vy, offsets)
    if (to === 'close') close()
    else snapTo(to)
  }

  const pan = usePanGesture({
    testID: `${testID}-pan`,
    activeOffsetY: [-10, 10],
    onActivate: () => {
      start.value = y.value
    },
    onUpdate: (e) => {
      y.value = Math.max(top, start.value + e.translationY)
    },
    onDeactivate: (e) => {
      scheduleOnRN(release, y.value, e.velocityY)
    },
  })

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }))

  function onBoxLayout(e: LayoutChangeEvent) {
    const box = e.nativeEvent.layout.height
    setBoxHeight(box)
    if (!closing.current) y.value = sheetOffsets(snapPoints, box - insets.top)[index] ?? 0
  }

  const last = snapPoints.length - 1
  return (
    <GestureHandlerRootView
      testID={testID}
      style={styles.root}
      onLayout={onBoxLayout}
      accessibilityViewIsModal
      onAccessibilityEscape={close}
    >
      <Pressable
        testID={`${testID}-backdrop`}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[StyleSheet.absoluteFill, styles.backdrop]}
        onPress={close}
      />
      <Animated.View
        testID={`${testID}-panel`}
        style={[styles.panel, { top: insets.top, height, backgroundColor: c.card }, slide]}
      >
        <GestureDetector gesture={pan}>
          <View
            testID={`${testID}-header`}
            onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
          >
            <Pressable
              testID={`${testID}-handle`}
              accessibilityRole="button"
              accessibilityLabel={index === 0 ? 'Expand' : 'Collapse'}
              hitSlop={8}
              style={styles.handle}
              onPress={() => snapTo(index === 0 ? last : 0)}
            >
              <View style={[styles.grip, { backgroundColor: c.ring }]} />
            </Pressable>
            {header}
          </View>
        </GestureDetector>
        <ScrollView
          testID={`${testID}-body`}
          style={{ maxHeight: Math.max(0, height * (snapPoints[index] ?? 1) - headerHeight) }}
          contentContainerStyle={{ paddingBottom: insets.bottom }}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { backgroundColor: '#00000080' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  handle: { alignItems: 'center', paddingVertical: 12 },
  grip: { width: 36, height: 4, borderRadius: 2 },
})
