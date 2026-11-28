// A tool (design 7.8): the web's own page in a DOM view, fed through the key-free bridge, under a
// native header. The page gets tool.init once it has loaded: its tool and the broker store it is
// seeded with (the server's broker and what it trades on this server version).
// - A page-shaped cover on the theme's background shows until the page is ready, and for an
//   option tool until its first figures (or 3 s); it fades out, at once under reduced motion.
// - A page that is not ready in 20 s (while in front), fails its first load, or whose WebView the
//   OS killed shows a message and Reload, which lets go of what it held and starts a new page.
//   A page's own render error stays in the page, which offers its own way on.
// - Back (the button, Android's, the iOS swipe on the tool's main view) goes to the page first:
//   it closes a picker or a dialog, or leaves a report for its builder. The screen goes only when
//   the page says it did nothing, or does not answer in 150 ms. A pass still running asks first.
// - A held order from the page opens its review sheet (HeldOrderSheet), a held basket its own
//   (HeldBasketSheet), over the page.

import { useFocusEffect, useNavigation, usePreventRemove, useRouter } from 'expo-router'
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from 'zustand'
import { log } from '~/core/log/logger'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useServices } from '~/core/services/services'
import { DomHost } from '~/dom/bridge/DomHost'
import { createOutbox, type Outbox } from '~/dom/bridge/outbox'
import {
  type DomEvent,
  type JSONValue,
  TOOL_TOPICS,
  type ToolDomProps,
  type ToolInit,
  type ToolPageId,
} from '~/dom/bridge/protocol'
import { TOOL_PUSH_TOPICS } from '~/dom/bridge/schemas'
import { brokerCaps } from '~/market/brokers/seed'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { currentBroker } from '~/market/session'
import { Button } from '~/ui/Button'
import { confirm } from '~/ui/confirm'
import { EmptyState } from '~/ui/EmptyState'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { tokens } from '~/ui/tokens'
import { useReduceMotion } from '~/ui/useReduceMotion'
import { HeldBasketSheet } from '../components/HeldBasketSheet'
import { HeldOrderSheet } from '../components/HeldOrderSheet'
import { ToolHeader } from '../components/ToolHeader'
import { ToolSkeleton } from '../components/ToolSkeleton'
import { TOOL_ENTRY } from '../entries'
import { useKeyboardPad } from '../hooks/useKeyboardPad'
import { useToolGateway } from '../hooks/useToolGateway'
import {
  mainPath,
  PRIMARY_ROUTE,
  STOP_BACKTEST,
  STOP_BACKTEST_BODY,
  TOOL_GONE_COPY,
  TOOL_READY_TIMEOUT_MS,
  TOOL_TIMEOUT_COPY,
  toolOf,
} from '../model'

/** How long back waits for the page to say whether it went back itself. */
export const BACK_WAIT_MS = 150
/** An option tool's cover waits this long after ready for the page's first figures. */
export const COVER_HOLD_MS = 3_000
const FADE_MS = 150
/** At most one line per 10 s for the errors a ready page reports. */
const ERROR_LOG_EVERY_MS = 10_000

// The wrapper gives the WebView no size without a style, and a new object each render would
// render the page again (DomHost): one constant per scheme, on the theme's background so the page
// never flashes white. The page scrolls its own document.
const webview = (backgroundColor: string) => ({
  style: { flex: 1, backgroundColor },
  containerStyle: { flex: 1, backgroundColor },
  scrollEnabled: true,
})
export const TOOL_WEBVIEW = {
  dark: webview(tokens.dark.background),
  light: webview(tokens.light.background),
} as const

/** One page: a host's key, its outbox, and when it started (the open time is logged). */
type Page = { n: number; outbox: Outbox; at: number }
const newPage = (n: number): Page => ({ n, outbox: createOutbox(), at: Date.now() })

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; copy: string }
const LOADING: Phase = { kind: 'loading' }

/** A removal that goes back one screen: what back on the page is asked about first. */
function isBack(action: { type: string; payload?: object }): boolean {
  if (action.type === 'GO_BACK') return true
  const count = (action.payload as { count?: number } | undefined)?.count ?? 1
  return action.type === 'POP' && count === 1
}

const twoFrames = (fn: () => void) =>
  requestAnimationFrame(() => {
    requestAnimationFrame(fn)
  })

export function ToolScreen({ page }: { page: ToolPageId }): JSX.Element {
  const s = useServices()
  const router = useRouter()
  const navigation = useNavigation()
  const insets = useSafeAreaInsets()
  const { scheme, c } = useTheme()
  const active = useScreenActive()
  const reduceMotion = useReduceMotion()
  const keyboardPad = useKeyboardPad(insets.bottom)
  const title = toolOf(page)?.title ?? page

  const [tab, setTab] = useState(() => newPage(0))
  const tabRef = useRef(tab)
  tabRef.current = tab
  const [phase, setPhase] = useState<Phase>(LOADING)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const activeRef = useRef(active)
  activeRef.current = active
  /** The first load failed while the tool was hidden: a new page once it is back in front. */
  const reloadInFront = useRef(false)
  const lastErrorLog = useRef(Number.NEGATIVE_INFINITY)
  const [violations, setViolations] = useState(0)
  const [overflow, setOverflow] = useState<number | null>(null)
  /** The path the page shows: back swipes only on its main view (a report has its own back). */
  const [route, setRoute] = useState<string | null>(null)

  const post = useCallback((topic: string, payload: JSONValue) => {
    tabRef.current.outbox.post({ kind: 'push', topic, payload })
  }, [])

  const backWait = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Asks the page about a back (set below, once the gateway is there). */
  const askBack = useRef(() => {})
  /** The stack's own back the page was asked about (a swipe): it goes on once the page says. */
  const pendingRepeat = useRef<(() => void) | null>(null)
  const [leaving, setLeaving] = useState(false)

  /** The page cannot be shown: its message instead, and what it held is let go of. */
  const fail = useRef<(copy: string) => void>(() => {})
  const onBackAnswer = useRef<(handled: boolean) => void>(() => {})
  const onEvent = (e: DomEvent) => {
    switch (e.name) {
      case 'loaded': {
        // a page that loads again on its host is a new page: init again, and ready again
        setPhase(LOADING)
        setRoute(null)
        setViolations(0)
        setOverflow(null)
        const broker = currentBroker(s)
        const init: ToolInit = {
          page,
          seed: { broker, capabilities: brokerCaps(broker, s.caps.get()?.version ?? null) },
        }
        post(TOOL_TOPICS.init, init)
        return
      }
      case 'toolReady': {
        if (phaseRef.current.kind !== 'loading') return
        const ms = Date.now() - tabRef.current.at
        const { csp, webgl } = e.info
        log.info(
          'tool',
          `open ${page} ${ms} ms, csp ${csp ? 'on' : 'off'}, webgl ${webgl ? 'yes' : 'no'}`,
        )
        // A release page with no CSP in force has lost a layer of design 7.7 (images, CSS url()
        // and links could reach the network): it is not shown. Dev builds run the dev policy.
        if (!csp && !__DEV__) {
          log.warn('tool', `${page} runs without its CSP: not shown`)
          fail.current(TOOL_TIMEOUT_COPY)
          return
        }
        setPhase({ kind: 'ready' })
        return
      }
      case 'violation':
        setViolations((n) => n + 1)
        return
      case 'layout':
        log.info('tool', `${page} overflow ${e.overflow}px`)
        setOverflow((n) => Math.max(n ?? 0, e.overflow))
        return
      case 'route':
        setRoute(e.path)
        return
      case 'back':
        onBackAnswer.current(e.handled)
        return
      case 'reload':
        reload()
        return
      case 'error':
      case 'pageError': {
        // A first load that failed (a refused tool.init among them) ends the page; any other
        // error is the page's own, which it goes on after: it is only logged.
        if (e.name === 'error' && e.load && phaseRef.current.kind === 'loading') {
          log.warn('tool', `${page} did not load: ${e.message}`)
          if (!activeRef.current) reloadInFront.current = true
          else fail.current(TOOL_TIMEOUT_COPY)
          return
        }
        const now = Date.now()
        if (now - lastErrorLog.current < ERROR_LOG_EVERY_MS) return
        lastErrorLog.current = now
        log.warn('tool', `${page} page error: ${e.message}`)
        return
      }
      default:
        return
    }
  }

  const gateway = useToolGateway({ page, outbox: tab.outbox, active, onEvent })
  const { reset, status, held } = gateway
  fail.current = (copy: string) => {
    reset()
    setPhase({ kind: 'failed', copy })
  }
  const onGone = useCallback(() => fail.current(TOOL_GONE_COPY), [])
  const reload = () => {
    reset()
    setViolations(0)
    setOverflow(null)
    setRoute(null)
    setTab((p) => newPage(p.n + 1))
    setPhase(LOADING)
  }

  useEffect(() => {
    if (!active || !reloadInFront.current) return
    reloadInFront.current = false
    reload()
  })

  // The timeout counts while the tool is in front: a hidden page's requests wait for it.
  useEffect(() => {
    if (phase.kind !== 'loading' || !active) return
    const t = setTimeout(() => fail.current(TOOL_TIMEOUT_COPY), TOOL_READY_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase.kind, active])

  // --- Back -------------------------------------------------------------------------------
  const heldNow = useStore(held, (st) => st.current)
  // The page is asked about a back only while it can answer, and no held order is on show (its
  // sheet takes the back, and holds the screen while its order is on its way).
  const intercept = phase.kind === 'ready' && !leaving && heldNow === null
  const disablePrevention = usePreventRemove(intercept, ({ data, repeat }) => {
    if (!isBack(data.action)) {
      // somewhere else (the order book after a held order): straight there
      setLeaving(true)
      repeat()
      return
    }
    pendingRepeat.current = repeat
    askBack.current()
  })

  /** The stop-the-pass confirm is up: another back meanwhile asks nothing more. */
  const confirming = useRef(false)
  const leave = async () => {
    if (status.getState().longSince !== null) {
      if (confirming.current) return
      confirming.current = true
      const ok = await confirm(STOP_BACKTEST, STOP_BACKTEST_BODY, 'Leave', {
        cancel: 'Stay',
        destructive: true,
      }).finally(() => {
        confirming.current = false
      })
      if (!ok) {
        pendingRepeat.current = null
        return
      }
      reset()
    }
    setLeaving(true)
    const repeat = pendingRepeat.current
    pendingRepeat.current = null
    if (repeat) repeat()
    else {
      disablePrevention()
      router.back()
    }
  }

  askBack.current = () => {
    if (backWait.current !== null) return
    if (phaseRef.current.kind !== 'ready') {
      void leave()
      return
    }
    post(TOOL_PUSH_TOPICS.back, null)
    backWait.current = setTimeout(() => {
      backWait.current = null
      void leave()
    }, BACK_WAIT_MS)
  }
  onBackAnswer.current = (handled) => {
    if (backWait.current === null) return
    clearTimeout(backWait.current)
    backWait.current = null
    if (handled) pendingRepeat.current = null
    else void leave()
  }
  useEffect(
    () => () => {
      if (backWait.current !== null) clearTimeout(backWait.current)
    },
    [],
  )

  // Android's back, while the tool is in front; a held order's sheet registers after it, and
  // so hears it first.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        askBack.current()
        return true
      })
      return () => sub.remove()
    }, []),
  )

  // The swipe back, on the main view only: on a report it would leave the tool, not the report.
  const onMain = route === null || route === mainPath(page)
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: onMain })
  }, [navigation, onMain])

  // --- The cover --------------------------------------------------------------------------
  const [lift, setLift] = useState(false)
  const [coverGone, setCoverGone] = useState(false)
  const [fade] = useState(() => new Animated.Value(1))
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page covers anew
  useEffect(() => {
    setLift(false)
    setCoverGone(false)
    fade.setValue(1)
  }, [tab.n, fade])
  useEffect(() => {
    if (phase.kind !== 'ready' || lift) return
    if (PRIMARY_ROUTE[page] === undefined) {
      setLift(true)
      return
    }
    // an option tool shows its figures, not an empty chart, behind the cover
    let live = true
    const up = () => {
      if (live) setLift(true)
    }
    const hold = setTimeout(up, COVER_HOLD_MS)
    const off = status.subscribe((st) => {
      if (st.last !== null) twoFrames(up)
    })
    if (status.getState().last !== null) twoFrames(up)
    return () => {
      live = false
      clearTimeout(hold)
      off()
    }
  }, [phase.kind, lift, page, status])
  useEffect(() => {
    if (!lift) return
    if (reduceMotion) {
      setCoverGone(true)
      return
    }
    Animated.timing(fade, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start()
    // gone once the fade is over, whatever the animation's own callback does
    const t = setTimeout(() => setCoverGone(true), FADE_MS)
    return () => clearTimeout(t)
  }, [lift, reduceMotion, fade])

  const props = useMemo<ToolDomProps>(
    () => ({ scheme, page, reduceMotion }),
    [scheme, page, reduceMotion],
  )

  return (
    <View
      testID="tool-screen"
      style={[styles.fill, { backgroundColor: c.background, paddingBottom: insets.bottom }]}
    >
      <ToolHeader
        title={title}
        topInset={insets.top}
        status={status}
        onBack={() => askBack.current()}
        onTitle={() => {
          if (phaseRef.current.kind === 'ready') post(TOOL_PUSH_TOPICS.top, null)
        }}
      />
      <BrokerBanner />
      <HeldOrderSheet held={held} />
      <KeyboardAvoidingView
        testID="tool-body"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.fill, { paddingBottom: keyboardPad }]}
      >
        {phase.kind === 'failed' ? (
          <EmptyState
            title={phase.copy}
            action={<Button testID="tool-reload" title="Reload" onPress={reload} />}
          />
        ) : (
          <>
            <DomHost
              key={tab.n}
              Dom={TOOL_ENTRY[page]}
              props={props}
              handlers={gateway.handlers}
              outbox={tab.outbox}
              webview={TOOL_WEBVIEW[scheme]}
              testID="tool-dom"
              onGone={onGone}
            />
            {coverGone ? null : (
              <Animated.View pointerEvents="none" style={[styles.cover, { opacity: fade }]}>
                <ToolSkeleton />
              </Animated.View>
            )}
            {phase.kind === 'ready' ? (
              // Maestro waits on these: a hidden, zero-size or off-screen view is never seen.
              <>
                <Text testID="tool-ready" accessibilityLabel={`page ${page}`} style={styles.probe}>
                  {`page ${page}`}
                </Text>
                <Text
                  testID="tool-csp"
                  accessibilityLabel={`violations ${violations}`}
                  style={styles.probe}
                >
                  {`violations ${violations}`}
                </Text>
                {overflow !== null ? (
                  <Text
                    testID="tool-layout"
                    accessibilityLabel={`overflow ${overflow}`}
                    style={styles.probe}
                  >
                    {`overflow ${overflow}`}
                  </Text>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </KeyboardAvoidingView>
      <HeldBasketSheet held={held} />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cover: StyleSheet.absoluteFill,
  probe: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    overflow: 'hidden',
  },
})
