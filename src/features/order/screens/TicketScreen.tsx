// The order ticket (design 7.10), a form sheet: edit, then a review that reads the server's mode
// again and shows it, then one send, then what came of it. The send goes through the order safety
// of T10: the mode read before it, the live confirm, one request at a time, never retried. An
// outcome that may hide a placed order is checked against the order book and never re-sent.
import { type Href, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { hasEndpoint } from '~/core/capabilities/gates'
import { ENDPOINTS } from '~/core/http/endpoints'
import { userMessage } from '~/core/http/errors'
import { notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { useIsEvented } from '~/market/books/queries'
import type { Orderbook } from '~/market/books/schemas'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { defaultProduct, isQuoteOnly } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { ordersHref } from '~/market/links'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { useSubmitGuard } from '~/market/orders/guard'
import { reconcilePlacement, reconcileSplit } from '~/market/orders/reconcile'
import type { PlaceReply, SplitReply } from '~/market/orders/schemas'
import { type Outcome, submitOrderAction } from '~/market/orders/submit'
import {
  initialTicket,
  issueText,
  type OrderPlan,
  planOrder,
  type TicketIssue,
  type TicketState,
  ticketSummary,
  validateTicket,
} from '~/market/orders/ticket'
import { openServerPage, useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import type { TicketParams } from '~/market/types'
import { ErrorState } from '~/ui/ErrorState'
import { fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { ResultView, type TicketResult } from '../components/ResultView'
import { MODE_LABEL, ReviewStep } from '../components/ReviewStep'
import { snapPrice, TicketForm } from '../components/TicketForm'
import { useMarginPreview } from '../hooks/useMarginPreview'

type Step =
  | { kind: 'edit'; error?: string }
  | { kind: 'review'; mode: AnalyzerMode | null; readError?: unknown; notice?: string }
  | { kind: 'sending'; mode: AnalyzerMode }
  | { kind: 'result'; result: TicketResult }

/** The endpoints a ticket sends on: a Server error from one of them may hide a placed order. */
const SENDS: ReadonlySet<string> = new Set(['placeorder', 'splitorder'])

const SPLIT_WAIT_SEC = Math.round(ENDPOINTS.splitorder.timeoutMs / 1000)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const modeChanged = (mode: AnalyzerMode) =>
  `The server is now in ${MODE_LABEL[mode]} mode. Review again.`

/** "1,755 + 65": the full children, counted when there are several, then the rest. */
function breakdown(plan: Extract<OrderPlan, { kind: 'split' }>): string {
  const full = plan.children.filter((q) => q === plan.splitsize).length
  const rest = plan.children.filter((q) => q !== plan.splitsize)
  const head = full > 1 ? `${full} × ${fmtQty(plan.splitsize)}` : fmtQty(plan.splitsize)
  return [head, ...rest.map(fmtQty)].join(' + ')
}

export function TicketScreen({ params }: { params: TicketParams }) {
  return (
    <View style={styles.fill} testID="ticket-screen">
      <BrokerBanner />
      {isQuoteOnly(params.exchange) ? (
        <Refused params={params} issue="quote_only" />
      ) : (
        <Listed params={params} />
      )}
    </View>
  )
}

/** The contract's metadata decides the rest: unknown shows only that, and takes no feed slot. */
function Listed({ params }: { params: TicketParams }) {
  const { exchange, symbol } = params
  const s = useServices()
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  if (refused || inst.unknown) return <Refused params={params} issue="unknown_instrument" />
  if (inst.meta) return <Ticket params={params} meta={inst.meta} />
  if (inst.loading) return <Skeleton />
  const queryKey = qk.symbol(s.profile.get().id, exchange, symbol)
  return (
    <ErrorState
      error={s.queryClient.getQueryState(queryKey)?.error}
      onRetry={() => void s.queryClient.refetchQueries({ queryKey })}
    />
  )
}

/** An index or an unlisted contract: its issue text, and nothing to fill in. */
function Refused({ params, issue }: { params: TicketParams; issue: TicketIssue }) {
  const ticket: TicketState = {
    exchange: params.exchange,
    symbol: params.symbol,
    action: params.action,
    product: params.product ?? defaultProduct(params.exchange),
    pricetype: params.pricetype ?? 'MARKET',
    qty: 1,
  }
  return (
    <View style={styles.body}>
      <Title exchange={params.exchange} symbol={params.symbol} />
      <Text testID="ticket-refused">{issueText(issue, { ticket, meta: 'unknown' })}</Text>
    </View>
  )
}

function Title({ exchange, symbol, name }: { exchange: string; symbol: string; name?: string }) {
  return (
    <View style={styles.title}>
      <Text variant="heading" numberOfLines={1}>
        {symbol}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {name && name !== symbol ? `${name} · ${exchange}` : exchange}
      </Text>
    </View>
  )
}

function Ticket({ params, meta }: { params: TicketParams; meta: InstrumentMeta }) {
  const { exchange, symbol } = params
  const s = useServices()
  const trading = useTrading()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const blocked = useBrokerBlocked()
  const isEvented = useIsEvented()
  const guard = useSubmitGuard()
  const ltp = useLiveQuote(exchange, symbol, 1)?.ltp
  const [ticket, setTicket] = useState(() => initialTicket(params, meta))
  const [step, setStep] = useState<Step>({ kind: 'edit' })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  /** Each opening of the review; a mode read for an earlier one is dropped. */
  const reviews = useRef(0)
  const pid = s.profile.get().id

  const caps = s.caps.get()
  // Ruling 25: allowed unless the server is known to lack it.
  const splitAvailable = caps === null || hasEndpoint(caps, 'splitorder') !== false
  const issueCodes = validateTicket(ticket, meta, ltp, { splitAvailable })
  const issues = issueCodes.map((issue) => ({
    issue,
    text: issueText(issue, { ticket, meta, ltp }),
  }))
  const plan = issueCodes.length === 0 ? planOrder(ticket, meta) : null
  const margin = useMarginPreview(plan ? plan.spec : null)

  const readMode = (seq: number) => {
    trading.analyzer.read().then(
      (mode) => {
        if (alive.current && reviews.current === seq) {
          setStep((st) => (st.kind === 'review' ? { ...st, mode, readError: undefined } : st))
        }
      },
      (e: unknown) => {
        if (alive.current && reviews.current === seq) {
          setStep((st) => (st.kind === 'review' ? { ...st, readError: e } : st))
        }
      },
    )
  }

  const openReview = () => {
    const seq = ++reviews.current
    setTicket((t) => ({
      ...t,
      price: snapPrice(t.price, meta),
      trigger: snapPrice(t.trigger, meta),
    }))
    setStep({ kind: 'review', mode: null })
    // Ruling 26: the book as it stands, so a check after an unknown outcome can tell the orders
    // already in it from the one sent.
    s.queryClient
      .ensureQueryData({
        queryKey: qk.orderbook(pid),
        queryFn: () => trading.orders.orderbook(),
        revalidateIfStale: true,
      })
      .catch(() => {})
    readMode(seq)
  }

  const retryRead = () => {
    setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
    readMode(++reviews.current)
  }

  /** The order ids the orderbook cache holds now: those orders are not the one being sent. */
  const bookIds = (): ReadonlySet<string> =>
    new Set(
      s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid))?.orders.map((o) => o.orderid) ?? [],
    )

  type Sent = { at: number; knownIds: ReadonlySet<string> }

  /** It may have gone: the order book says what happened. Nothing is sent again. */
  const reconcile = async (p: OrderPlan, sent: Sent) => {
    notifyWarning()
    setStep({ kind: 'result', result: { kind: 'maybe', check: null } })
    const common = {
      // nothing more is read once the ticket has closed
      fetchOrders: () =>
        alive.current ? trading.orders.orderbook() : Promise.reject(new Error('closed')),
      spec: p.spec,
      sentAt: sent.at,
      knownIds: sent.knownIds,
      sleep,
    }
    const show = (check: Extract<TicketResult, { kind: 'maybe' }>['check']) => {
      if (alive.current) setStep({ kind: 'result', result: { kind: 'maybe', check } })
    }
    if (p.kind === 'split') {
      const of = p.children.length
      const r = await reconcileSplit({ ...common, children: p.children }).catch(() => null)
      show({ kind: 'split', checked: r?.checked ?? false, found: r?.found.length ?? 0, of })
    } else {
      const r = await reconcilePlacement(common).catch(() => null)
      show({ kind: 'single', checked: r?.checked ?? false, status: r?.found?.status ?? null })
    }
  }

  const settle = async (
    out: Outcome<PlaceReply | SplitReply>,
    p: OrderPlan,
    sent: Sent,
    shownMode: AnalyzerMode,
  ) => {
    switch (out.kind) {
      case 'done': {
        const reply = out.reply
        if (reply.kind === 'no_id') return reconcile(p, sent)
        if (reply.kind === 'placed') {
          notifySuccess()
          // Ruling 12 and T11: the app's own order, so its event should follow.
          if (isEvented()) trading.eventWatch.expect(reply.orderid)
          setStep({ kind: 'result', result: reply })
        } else if (reply.kind === 'split') {
          if (reply.children.every((c) => c.ok)) notifySuccess()
          else notifyWarning()
          setStep({ kind: 'result', result: { kind: 'split', reply } })
        } else {
          setStep({ kind: 'result', result: { kind: 'queued' } })
        }
        return
      }
      case 'maybe':
        return reconcile(p, sent)
      case 'error':
        // Rulings 5: a server error from the send itself may hide a placed order.
        if (out.error.kind === 'Server' && SENDS.has(out.error.endpoint)) return reconcile(p, sent)
        notifyWarning()
        setStep({ kind: 'edit', error: userMessage(out.error) })
        return
      case 'semi_auto_blocked':
        notifyWarning()
        setStep({ kind: 'edit', error: out.message })
        return
      case 'mode_changed':
        setStep({ kind: 'review', mode: out.now, notice: modeChanged(out.now) })
        return
      case 'cancelled':
        setStep({ kind: 'review', mode: shownMode, notice: out.message })
        return
    }
  }

  /** The whole of confirm runs inside the guard: one at a time, then the cooldown. */
  const confirm = (shownMode: AnalyzerMode) =>
    void guard.run(async () => {
      // The LTP may have moved since the review: a stop now on the wrong side goes back to edit.
      if (validateTicket(ticket, meta, ltp, { splitAvailable }).length > 0) {
        setStep({ kind: 'edit' })
        return
      }
      const p = planOrder(ticket, meta)
      setStep({ kind: 'sending', mode: shownMode })
      const sent: Sent = { at: 0, knownIds: new Set() }
      const send = (): Promise<PlaceReply | SplitReply> => {
        sent.at = Date.now()
        sent.knownIds = bookIds()
        return p.kind === 'split'
          ? trading.orders.split(p.spec, p.splitsize)
          : trading.orders.place(p.spec)
      }
      const out = await submitOrderAction({
        kind: p.kind === 'split' ? 'split' : 'place',
        shownMode,
        send,
        gate: trading.analyzer,
        confirmLive: confirmLiveOrder,
        books: s.books,
      })
      if (alive.current) await settle(out, p, sent, shownMode)
    })

  const body = () => {
    switch (step.kind) {
      case 'edit':
        return (
          <TicketForm
            ticket={ticket}
            meta={meta}
            ltp={ltp}
            issues={issues}
            splitNote={
              plan?.kind === 'split'
                ? `Sent as ${plan.orders} orders (freeze limit ${fmtQty(meta.freezeQty)})`
                : null
            }
            margin={margin}
            error={step.error}
            canReview={issueCodes.length === 0 && !blocked}
            onChange={(patch) => setTicket((t) => ({ ...t, ...patch }))}
            onReview={openReview}
          />
        )
      case 'review':
      case 'sending': {
        const p = planOrder(ticket, meta)
        const sending = step.kind === 'sending'
        return (
          <ReviewStep
            summary={ticketSummary(ticket, meta)}
            split={p.kind === 'split' ? { orders: p.orders, breakdown: breakdown(p) } : null}
            side={ticket.action}
            mode={step.mode}
            readError={step.kind === 'review' ? step.readError : undefined}
            onRetryRead={retryRead}
            notice={step.kind === 'review' ? step.notice : undefined}
            sending={sending}
            splitWaitSec={p.kind === 'split' ? SPLIT_WAIT_SEC : undefined}
            blocked={blocked || guard.busy()}
            onConfirm={() => {
              if (step.mode !== null) confirm(step.mode)
            }}
            onBack={() => setStep({ kind: 'edit' })}
          />
        )
      }
      case 'result':
        return (
          <ResultView
            result={step.result}
            onDone={() => router.back()}
            onViewOrderbook={() => router.dismissTo(ordersHref() as Href)}
            onOpenActionCenter={() => openServerPage(s.profile.get().restOrigin, '/action-center')}
          />
        )
    }
  }

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.body, { paddingBottom: 16 + insets.bottom }]}
    >
      <Title exchange={exchange} symbol={symbol} name={meta.name} />
      {body()}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 16 },
  title: { gap: 2 },
})
