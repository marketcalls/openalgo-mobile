// The chart (design 7.9): openalgo-charts in a DOM page that native feeds through pushes, with the
// chart's own header and the notices of the writes that start on it, as on Orders.
// - The page gets chart.init once it has loaded, from the route's instrument, the interval list,
//   the session calendar and the instrument's metadata. A source still out 3 s after the load
//   goes as its fallback, and the calendar and metadata are pushed when they come. The books'
//   lines follow whenever they change, and are drawn again each time the chart is back in
//   front, so a line dragged to a modify that never happened is back at its price (RF 6).
// - The widget's own symbol box changes the instrument here at once, without a new page; the
//   intents then act only on the new one (RF 1).
// - A page that does not get ready in 20 s, fails its first load, or whose WebView the OS killed
//   (RF 3) gives a message and Reload, which lets go of what it held and starts a new page. A
//   first load that failed while the chart was hidden (its requests wait for the chart) loads
//   again once the chart is back in front. Any other page error is only logged.
import { type Href, useFocusEffect, useRouter } from 'expo-router'
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePrefs } from '~/core/config/prefs'
import { log } from '~/core/log/logger'
import { quoteKey } from '~/core/realtime/protocol'
import { useScreenActive } from '~/core/realtime/useScreenActive'
import { useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import { DomHost } from '~/dom/bridge/DomHost'
import { createOutbox, type Outbox } from '~/dom/bridge/outbox'
import {
  CHART_TOPICS,
  type ChartDomProps,
  type ChartInit,
  type ChartMeta,
  type DomEvent,
  type DomIntentMsg,
  type Inst,
  type JSONValue,
} from '~/dom/bridge/protocol'
import ChartDom from '~/dom/chart/ChartDom'
import { DEFAULT_CALENDARS } from '~/market/chart/calendar'
import { FALLBACK_INTERVALS } from '~/market/chart/intervals'
import { useChartIntervals, useSessionCalendars } from '~/market/chart/queries'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { OutcomeLine } from '~/market/components/OutcomeLine'
import {
  BrokerBanner,
  SemiAutoBanner,
  SemiAutoBlockedBanner,
} from '~/market/components/SessionBanners'
import { ALL_EXCHANGES } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { useInstrument } from '~/market/instruments/useInstrument'
import { depthHref, ordersHref } from '~/market/links'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { Skeleton } from '~/ui/Skeleton'
import { StatusBadges } from '~/ui/StatusBadges'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { ChartHeader } from '../components/ChartHeader'
import { useChartBooks } from '../hooks/useChartBooks'
import { useChartGateway } from '../hooks/useChartGateway'
import { useChartIntents } from '../hooks/useChartIntents'

export const CHART_READY_TIMEOUT_MS = 20_000
export const POLLING_NOTE = 'Polling: the last candle updates every few seconds.'
export const GONE_COPY = 'The chart was closed to free memory.'
export const TIMEOUT_COPY = "The chart didn't load."

/** How long a loaded page waits for a source before it opens with that source's fallback. */
const SOURCE_WAIT_MS = 3_000
/** A symbol longer than the bridge's own bound is not one the app trades. */
const MAX_SYMBOL = 64
/** At most one line per 10 s for the errors a ready page reports. */
const ERROR_LOG_EVERY_MS = 10_000
const EXCHANGES: ReadonlySet<string> = new Set(ALL_EXCHANGES)

// The wrapper gives the WebView no size without a style, and a new object each render would
// render the page again (DomHost, spike CHANGES.chart.md §9): one constant.
const WEBVIEW = { style: { flex: 1 }, containerStyle: { flex: 1 } }

const sameInst = (a: Inst, b: Inst) => a.exchange === b.exchange && a.symbol === b.symbol

/** What the page is told of an instrument: the trading facts, not its names. */
function chartMetaOf(m: InstrumentMeta | undefined): ChartMeta | null {
  if (!m) return null
  return {
    exchange: m.exchange,
    symbol: m.symbol,
    tick: m.tick,
    lotsize: m.lotsize,
    lots: m.lots,
    quoteOnly: m.quoteOnly,
    freezeQty: m.freezeQty,
  }
}

/** One page: a host's key, its outbox, and when it started (the open time is logged). */
type Page = { n: number; outbox: Outbox; at: number }
const newPage = (n: number): Page => ({ n, outbox: createOutbox(), at: Date.now() })

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; bars: number }
  | { kind: 'failed'; copy: string }
const LOADING: Phase = { kind: 'loading' }

/** What the current page was last sent of each topic, as JSON; unset: not yet. */
type Sent = { init?: true } & Partial<Record<'calendars' | 'meta' | 'orders' | 'positions', string>>

export function ChartScreen({ initial }: { initial: Inst }): JSX.Element {
  // A later route param is the chart's own symbol change (setParams): the screen already has it.
  const [opening] = useState(initial)
  const instrument = useInstrument(opening.exchange, opening.symbol)
  if (instrument.unknown) return <Unknown inst={opening} />
  return <Chart opening={opening} />
}

/** An expired or mistyped contract: said so, with no page and no feed slot. */
function Unknown({ inst }: { inst: Inst }) {
  const router = useRouter()
  return (
    <Frame>
      <ChartHeader
        inst={inst}
        priced={false}
        mode="unknown"
        oneTap={false}
        onBack={() => router.back()}
        onDepth={() => {}}
      />
      <EmptyState title="Expired or unknown" />
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View
      testID="chart-screen"
      style={[styles.fill, { backgroundColor: c.background, paddingTop: insets.top }]}
    >
      {children}
    </View>
  )
}

function Chart({ opening }: { opening: Inst }) {
  const s = useServices()
  const router = useRouter()
  const { scheme, c } = useTheme()
  const active = useScreenActive()
  const conn = useConnection()
  const polling = conn.feed === 'polling'
  const oneTap = usePrefs((p) => p.chartOneTap)

  // The instrument on screen: the ref for the intents (a symbol change applies at once), the
  // state for what renders and reads.
  const [inst, setInst] = useState(opening)
  const current = useRef(opening)
  const instrument = useInstrument(inst.exchange, inst.symbol)
  const meta = useMemo(() => chartMetaOf(instrument.meta), [instrument.meta])
  const metaPending = instrument.loading
  const intervals = useChartIntervals(polling)
  const calendars = useSessionCalendars()
  const books = useChartBooks(inst)

  const [page, setPage] = useState(() => newPage(0))
  const pageRef = useRef(page)
  pageRef.current = page
  const [phase, setPhase] = useState<Phase>(LOADING)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  /** Each 'loaded' of a page counts one: the page wants its init again. */
  const [loads, setLoads] = useState(0)
  /** The load whose 3 s wait for its sources is over. */
  const [waited, setWaited] = useState(0)
  const sent = useRef<Sent>({})
  const lastErrorLog = useRef(Number.NEGATIVE_INFINITY)
  const activeRef = useRef(active)
  activeRef.current = active
  /** The first load failed while the chart was hidden: a new page once it is back in front. */
  const reloadInFront = useRef(false)

  const post = useCallback((topic: string, payload: JSONValue) => {
    pageRef.current.outbox.post({ kind: 'push', topic, payload })
  }, [])
  /** Posts `payload` unless it is what the page was last sent on `topic`. */
  const offer = useCallback(
    (topic: 'calendars' | 'meta' | 'orders' | 'positions', payload: JSONValue) => {
      const json = JSON.stringify(payload)
      if (sent.current[topic] === json) return
      sent.current[topic] = json
      post(CHART_TOPICS[topic], payload)
    },
    [post],
  )

  const latestBooks = useRef(books)
  latestBooks.current = books
  /** The lines again, as the books are now: an order or position the page drew is gone. */
  const redraw = useCallback(() => {
    if (!sent.current.init) return
    sent.current.orders = undefined
    sent.current.positions = undefined
    offer('orders', latestBooks.current.orders)
    offer('positions', latestBooks.current.positions)
  }, [offer])

  const intents = useChartIntents({
    current: () => current.current,
    meta,
    ltp: () => {
      const { exchange, symbol } = current.current
      return s.store.get(quoteKey(exchange, symbol))?.ltp ?? null
    },
    redraw,
  })

  /** The widget's symbol box chose another instrument: the screen follows it, on the same page. */
  const switchTo = (next: Inst) => {
    if (!EXCHANGES.has(next.exchange) || next.symbol === '' || next.symbol.length > MAX_SYMBOL)
      return
    if (sameInst(next, current.current)) return
    current.current = next
    setInst(next)
    // the segment as chartHref writes it, which the route's parseKey decodes
    router.setParams({ key: encodeURIComponent(`${next.exchange}:${next.symbol}`) })
    // the new instrument's meta and lines go even when they equal the last ones
    sent.current.meta = undefined
    sent.current.orders = undefined
    sent.current.positions = undefined
  }

  const onIntent = (m: DomIntentMsg) => {
    if (m.intent.type === 'symbol') switchTo(m.intent.inst)
    else intents.onIntent(m)
  }

  /** The page cannot be shown: its message instead, and what it held is let go of. */
  const fail = useRef<(copy: string) => void>(() => {})
  const onEvent = (e: DomEvent) => {
    switch (e.name) {
      case 'loaded':
        // a page that loads again on its host is a new widget: init again, and ready again
        sent.current = {}
        setLoads((n) => n + 1)
        setPhase(LOADING)
        return
      case 'ready': {
        if (phaseRef.current.kind !== 'loading') return
        const ms = Date.now() - pageRef.current.at
        const { bars, csp } = e.info
        log.info('chart', `open ${ms} ms, bars ${bars}, csp ${csp ? 'on' : 'off'}`)
        setPhase({ kind: 'ready', bars })
        return
      }
      case 'error': {
        // The library's own words for a failed first load, whatever the server said (preflight
        // conflict 24). A page's own error (a window error, Chromium's harmless ResizeObserver
        // warning among them) ends nothing, before ready or after: it is only logged.
        if (phaseRef.current.kind === 'loading' && e.load) {
          log.warn('chart', `the chart did not load: ${e.message}`)
          // its requests waited for the chart to be in front, and timed out meanwhile
          if (!activeRef.current) reloadInFront.current = true
          else fail.current(TIMEOUT_COPY)
          return
        }
        const now = Date.now()
        if (now - lastErrorLog.current < ERROR_LOG_EVERY_MS) return
        lastErrorLog.current = now
        log.warn('chart', `page error: ${e.message}`)
        return
      }
      case 'link':
        return
    }
  }

  const gateway = useChartGateway({ outbox: page.outbox, polling, active, onIntent, onEvent })
  const { reset } = gateway
  fail.current = (copy: string) => {
    reset()
    setPhase({ kind: 'failed', copy })
  }
  const onGone = useCallback(() => fail.current(GONE_COPY), [])
  const reload = () => {
    reset()
    sent.current = {}
    setPage((p) => newPage(p.n + 1))
    setPhase(LOADING)
  }

  useEffect(() => {
    if (!active || !reloadInFront.current) return
    reloadInFront.current = false
    reload()
  })

  // The timeout counts while the chart is in front: a hidden page's requests wait for it.
  useEffect(() => {
    if (phase.kind !== 'loading' || !active) return
    const t = setTimeout(() => fail.current(TIMEOUT_COPY), CHART_READY_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase.kind, active])

  useEffect(() => {
    if (loads === 0) return
    const t = setTimeout(() => setWaited(loads), SOURCE_WAIT_MS)
    return () => clearTimeout(t)
  }, [loads])

  // chart.init once every source is in, or the wait is over; then what changes after it.
  useEffect(() => {
    if (loads === 0) return
    const k = sent.current
    if (!k.init) {
      const pending = intervals === undefined || calendars === undefined || metaPending
      if (pending && waited !== loads) return
      const { exchange, symbol } = current.current
      const init: ChartInit = {
        inst: { exchange, symbol },
        intervals: [...(intervals ?? FALLBACK_INTERVALS)],
        calendars: { ...(calendars?.calendars ?? DEFAULT_CALENDARS) },
        meta,
        ltp: s.store.get(quoteKey(exchange, symbol))?.ltp ?? null,
        polling,
      }
      post(CHART_TOPICS.init, init)
      sent.current = {
        init: true,
        calendars: JSON.stringify(init.calendars),
        meta: JSON.stringify(meta),
      }
    }
    if (calendars) offer('calendars', calendars.calendars)
    offer('meta', meta)
    offer('orders', books.orders)
    offer('positions', books.positions)
  }, [
    loads,
    waited,
    intervals,
    calendars,
    meta,
    metaPending,
    books.orders,
    books.positions,
    polling,
    s,
    post,
    offer,
  ])

  // Back in front (a dismissed modify sheet among others): the page draws its lines again.
  useFocusEffect(
    useCallback(() => {
      if (sent.current.init) post(CHART_TOPICS.redraw, null)
    }, [post]),
  )

  const props = useMemo<ChartDomProps>(() => ({ scheme }), [scheme])

  return (
    <Frame>
      <ChartHeader
        inst={inst}
        priced
        mode={conn.analyzer}
        oneTap={oneTap}
        onBack={() => router.back()}
        onDepth={() => router.push(depthHref(inst.exchange, inst.symbol) as Href)}
      />
      <View style={styles.badges}>
        <StatusBadges
          transport={conn.transport}
          feed={conn.feed}
          brokerSession={conn.brokerSession}
          analyzer={conn.analyzer}
        />
      </View>
      <BrokerBanner />
      {polling ? (
        <Text testID="chart-polling-note" variant="caption" tone="muted" style={styles.note}>
          {POLLING_NOTE}
        </Text>
      ) : null}
      {intents.liveSurprise !== null ? (
        <View style={styles.notice}>
          <LiveSurpriseNotice text={intents.liveSurprise} onDismiss={intents.dismissLiveSurprise} />
        </View>
      ) : null}
      {intents.semiBlocked !== null ? (
        <SemiAutoBlockedBanner message={intents.semiBlocked} />
      ) : (
        <SemiAutoBanner />
      )}
      {intents.outcome !== null ? (
        <OutcomeLine
          outcome={intents.outcome}
          onDismiss={intents.dismissOutcome}
          onViewOrderbook={() => router.dismissTo(ordersHref({ segment: 'all' }) as Href)}
        />
      ) : null}
      <View style={styles.chart}>
        {phase.kind === 'failed' ? (
          <EmptyState
            title={phase.copy}
            action={<Button testID="chart-reload" title="Reload" onPress={reload} />}
          />
        ) : (
          <>
            <DomHost
              key={page.n}
              Dom={ChartDom}
              props={props}
              handlers={gateway.handlers}
              outbox={page.outbox}
              webview={WEBVIEW}
              testID="chart-dom"
              onGone={onGone}
            />
            {phase.kind === 'ready' ? (
              // Maestro waits on it: a hidden, zero-size or off-screen view would never be seen.
              <Text
                testID="chart-ready"
                accessibilityLabel={`bars ${phase.bars}`}
                style={styles.ready}
              >
                {`bars ${phase.bars}`}
              </Text>
            ) : (
              <View style={[styles.cover, { backgroundColor: c.background }]}>
                <Skeleton />
              </View>
            )}
          </>
        )}
      </View>
      {intents.sheet}
    </Frame>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  badges: { paddingHorizontal: 16, paddingBottom: 4 },
  note: { paddingHorizontal: 16, paddingBottom: 4 },
  notice: { paddingHorizontal: 16, paddingTop: 8 },
  chart: { flex: 1 },
  cover: StyleSheet.absoluteFill,
  ready: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    overflow: 'hidden',
  },
})
