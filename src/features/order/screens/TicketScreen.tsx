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
import { toast } from '~/ui/Toast'
import { ResultView, resultLine, type TicketResult } from '../components/ResultView'
import { MODE_LABEL, ReviewStep } from '../components/ReviewStep'
import { snapPrice, TicketForm } from '../components/TicketForm'
import { useHoldSheet } from '../hooks/useHoldSheet'
import { useMarginPreview } from '../hooks/useMarginPreview'
import { holdOrder, useOtherOrderOut } from '../pendingOrders'

type Step =
  | { kind: 'edit'; error?: string }
  | { kind: 'review'; mode: AnalyzerMode | null; readError?: unknown; notice?: string }
  | { kind: 'sending'; mode: AnalyzerMode }
  | { kind: 'result'; result: TicketResult }

/** The endpoints a ticket sends on: a Server error from one of them may hide a placed order. */
const SENDS: ReadonlySet<string> = new Set(['placeorder', 'splitorder'])

const SPLIT_WAIT_SEC = Math.round(ENDPOINTS.splitorder.timeoutMs / 1000)

/**
 * How long confirm waits for the review's orderbook read (ruling 26). A read still out then
 * leaves the snapshot incomplete unless it lands before the send; a failing read retries twice
 * and a slow one can take 15 s a try, which would otherwise hold every confirm.
 */
export const BOOK_WAIT_MS = 5_000

/** The toast when the sheet goes while the order is on its way. */
export const STILL_SENDING = 'Your order is still being sent. Its outcome will show here.'

const NOT_SENT = 'The order was not sent.'

const MOVED = 'The price moved since the review. The order was not sent.'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const modeChanged = (mode: AnalyzerMode) =>
  `The server is now in ${MODE_LABEL[mode]} mode. Review again.`

const idsOf = (b: Orderbook | undefined): string[] => b?.orders.map((o) => o.orderid) ?? []

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
  /** This ticket, as the session's list of orders still out knows it. */
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me)
  /** Where this ticket's order is: on its way, or being checked after an unknown outcome. */
  const phase = useRef<'idle' | 'sending' | 'checking'>('idle')
  const alive = useRef(true)
  /** The review's orderbook read: its ids once it lands, for the review it was made for. */
  const bookRead = useRef<{ review: number; ids: ReadonlySet<string> } | null>(null)
  const bookTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [bookPending, setBookPending] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(bookTimer.current)
      // The sheet went while the order was on its way (an Android sheet can always be swiped
      // away): what comes of it shows as a toast.
      if (phase.current === 'sending') toast(STILL_SENDING)
    }
  }, [])
  useHoldSheet(step.kind === 'sending')
  /** Each opening of the review; the book read for an earlier one is dropped. */
  const reviews = useRef(0)
  /** Each mode read; one for an earlier opening, or before a retry, is dropped. */
  const modeReads = useRef(0)
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
        if (alive.current && modeReads.current === seq) {
          setStep((st) => (st.kind === 'review' ? { ...st, mode, readError: undefined } : st))
        }
      },
      (e: unknown) => {
        if (alive.current && modeReads.current === seq) {
          setStep((st) => (st.kind === 'review' ? { ...st, readError: e } : st))
        }
      },
    )
  }

  /**
   * Ruling 26: the order book as it stands at this review, so a check after an unknown outcome
   * can tell the orders already in it from the one sent. It is always read afresh: the cache can
   * hold a book from before an order the last ticket placed (a write only marks it stale), and
   * that order would then match. Confirm waits for the read, up to `BOOK_WAIT_MS`.
   */
  const readBook = (review: number) => {
    bookRead.current = null
    setBookPending(true)
    clearTimeout(bookTimer.current)
    const settled = () => {
      if (!alive.current || reviews.current !== review) return
      clearTimeout(bookTimer.current)
      setBookPending(false)
    }
    bookTimer.current = setTimeout(settled, BOOK_WAIT_MS)
    s.queryClient
      .fetchQuery({
        queryKey: qk.orderbook(pid),
        queryFn: () => trading.orders.orderbook(),
        staleTime: 0,
      })
      .then(
        (b) => {
          if (reviews.current === review) bookRead.current = { review, ids: new Set(idsOf(b)) }
        },
        () => {},
      )
      .finally(settled)
  }

  const openReview = () => {
    const review = ++reviews.current
    setTicket((t) => ({
      ...t,
      price: snapPrice(t.price, meta),
      trigger: snapPrice(t.trigger, meta),
    }))
    setStep({ kind: 'review', mode: null })
    readBook(review)
    readMode(++modeReads.current)
  }

  const retryRead = () => {
    setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
    readMode(++modeReads.current)
  }

  /**
   * What the send knows of the book: the ids of the orders already in it, which are not the one
   * sent, and whether this review's read landed first (`complete`). Only replies already in hand
   * count; a read still out may be answered after the order is placed, and would hide it.
   */
  type Sent = { at: number; knownIds: ReadonlySet<string>; complete: boolean }

  const snapshot = (review: number): Sent => {
    const read = bookRead.current?.review === review ? bookRead.current : null
    const cached = idsOf(s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid)))
    return {
      at: Date.now(),
      knownIds: new Set([...(read?.ids ?? []), ...cached]),
      complete: read !== null,
    }
  }

  /** Shows `result` on the sheet, or as a toast once the sheet has gone (it may, mid-send). */
  const show = (result: TicketResult) => {
    if (alive.current) setStep({ kind: 'result', result })
    else toast(resultLine(result))
  }

  /** Back to edit with `error`, or the error as a toast once the sheet has gone. */
  const refused = (error: string) => {
    if (alive.current) setStep({ kind: 'edit', error })
    else toast(error)
  }

  /**
   * It may have gone: the order book says what happened. Nothing is sent again. The check runs
   * to its end even when the sheet has closed, and then shows as a toast.
   */
  const reconcile = async (p: OrderPlan, sent: Sent) => {
    phase.current = 'checking'
    notifyWarning()
    show({ kind: 'maybe', check: null })
    const common = {
      fetchOrders: () => trading.orders.orderbook(),
      spec: p.spec,
      sentAt: sent.at,
      knownIds: sent.knownIds,
      sleep,
    }
    // Without the review's book, a match may be an earlier identical order (ruling 26).
    const earlier = !sent.complete
    if (p.kind === 'split') {
      const of = p.children.length
      const r = await reconcileSplit({ ...common, children: p.children }).catch(() => null)
      const found = r?.found.length ?? 0
      show({
        kind: 'maybe',
        check: { kind: 'split', checked: r?.checked ?? false, found, of, earlier },
      })
    } else {
      const r = await reconcilePlacement(common).catch(() => null)
      const status = r?.found?.status ?? null
      show({
        kind: 'maybe',
        check: { kind: 'single', checked: r?.checked ?? false, status, earlier },
      })
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
          show(reply)
        } else if (reply.kind === 'split') {
          if (reply.children.every((c) => c.ok)) notifySuccess()
          else notifyWarning()
          show({ kind: 'split', reply })
        } else {
          show({ kind: 'queued' })
        }
        return
      }
      case 'maybe':
        return reconcile(p, sent)
      case 'error':
        // Rulings 5: a server error from the send itself may hide a placed order.
        if (out.error.kind === 'Server' && SENDS.has(out.error.endpoint)) return reconcile(p, sent)
        notifyWarning()
        refused(userMessage(out.error))
        return
      case 'semi_auto_blocked':
        notifyWarning()
        refused(out.message)
        return
      case 'mode_changed':
        if (alive.current) setStep({ kind: 'review', mode: out.now, notice: modeChanged(out.now) })
        else toast(`The server is now in ${MODE_LABEL[out.now]} mode. ${NOT_SENT}`)
        return
      case 'cancelled':
        if (alive.current) setStep({ kind: 'review', mode: shownMode, notice: out.message })
        else toast(NOT_SENT)
        return
    }
  }

  /**
   * The whole of confirm runs inside the guard: one at a time, then the cooldown. The session
   * holds the order as out until its outcome is known, the check after an unknown one included,
   * so no other ticket sends meanwhile, even once this sheet has gone.
   */
  const confirm = (shownMode: AnalyzerMode) =>
    void guard.run(async () => {
      // The LTP may have moved since the review: a stop now on the wrong side goes back to edit,
      // which shows the issue, and says why it is back there.
      if (validateTicket(ticket, meta, ltp, { splitAvailable }).length > 0) {
        notifyWarning()
        setStep({ kind: 'edit', error: MOVED })
        return
      }
      const p = planOrder(ticket, meta)
      const review = reviews.current
      const release = holdOrder(trading, me)
      phase.current = 'sending'
      setStep({ kind: 'sending', mode: shownMode })
      try {
        // `send` takes the snapshot just before the request; until then nothing is known.
        const sent: Sent = { at: Date.now(), knownIds: new Set(), complete: false }
        const send = (): Promise<PlaceReply | SplitReply> => {
          Object.assign(sent, snapshot(review))
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
        await settle(out, p, sent, shownMode)
      } finally {
        phase.current = 'idle'
        release()
      }
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
            bookPending={bookPending}
            otherOut={otherOut}
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
