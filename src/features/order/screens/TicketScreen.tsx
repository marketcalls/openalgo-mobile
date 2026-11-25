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
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { useIsEvented } from '~/market/books/queries'
import { snapPrice } from '~/market/components/OrderFields'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { defaultProduct, isQuoteOnly } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { ordersHref } from '~/market/links'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { MODE_LABEL } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import { settle, sleep } from '~/market/orders/outcome'
import {
  holdOrder,
  takeUnseenOutcome,
  useOtherOrderOut,
  useUnseenOutcome,
} from '~/market/orders/pending'
import { noReplyDelays, reconcilePlacement, reconcileSplit } from '~/market/orders/reconcile'
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
import { useHoldSheet } from '~/market/orders/useHoldSheet'
import { openServerPage, useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import type { TicketParams } from '~/market/types'
import { ErrorState } from '~/ui/ErrorState'
import { fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { ResultView, resultLine, type TicketResult } from '../components/ResultView'
import { ReviewStep } from '../components/ReviewStep'
import { TicketForm } from '../components/TicketForm'
import { useMarginPreview } from '../hooks/useMarginPreview'
import { type BookSnapshot, useReviewBook } from '../hooks/useReviewBook'

type Step =
  | { kind: 'edit'; error?: string }
  | { kind: 'review'; mode: AnalyzerMode | null; readError?: unknown; notice?: string }
  | { kind: 'sending'; mode: AnalyzerMode }
  | { kind: 'result'; result: TicketResult }

const SPLIT_WAIT_SEC = Math.round(ENDPOINTS.splitorder.timeoutMs / 1000)

/**
 * After "Order placed", the reads of the order book for its status: a broker's RMS can reject a
 * placed order a moment later (funds, price band), and that comes back only in the book. An order
 * event for it reads at once. They stop at a status the order cannot leave.
 */
export const PLACED_STATUS_DELAYS_MS: readonly number[] = [1500, 3000, 6000]
const FINAL: readonly string[] = ['complete', 'rejected', 'cancelled']

/** The toast when the sheet goes while the order is on its way. */
export const STILL_SENDING = 'Your order is still being sent. Its outcome will show here.'

const NOT_SENT = 'The order was not sent.'

const MOVED = 'The price moved since the review. The order was not sent.'

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
  /** This ticket, as the session's list of orders still out knows it. */
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me)
  /** Where this ticket's order is: on its way, or being checked after an unknown outcome. */
  const phase = useRef<'idle' | 'sending' | 'checking'>('idle')
  const alive = useRef(true)
  /** The last outcome line this ticket's order sent to the toast, once its sheet had gone. */
  const goneLine = useRef<string | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // The sheet went while the order was on its way (an Android sheet can always be swiped
      // away): what comes of it shows as a toast.
      if (phase.current === 'sending') toast(STILL_SENDING)
    }
  }, [])
  useHoldSheet(step.kind === 'sending')
  const onReview = step.kind === 'review'
  const book = useReviewBook({ owner: me, otherOut, onReview })
  // An earlier order's outcome that only the toast carried: on iOS the toast is beneath this
  // sheet, so the review says it, whether it lands while this review waits or came before.
  const unseen = useUnseenOutcome(trading)
  const [earlierLine, setEarlierLine] = useState<string | null>(null)
  useEffect(() => {
    if (!onReview || unseen === null) return
    const line = takeUnseenOutcome(trading)
    if (line !== null) setEarlierLine(line)
  }, [onReview, unseen, trading])
  /** Each mode read; one for an earlier opening, or before a retry, is dropped. */
  const modeReads = useRef(0)
  /** The placed order's status, once the book or its order event shows it. */
  const [placedStatus, setPlacedStatus] = useState<string | null>(null)
  const placedId =
    step.kind === 'result' && step.result.kind === 'placed' ? step.result.orderid : null
  useEffect(() => {
    if (placedId === null) return
    let on = true
    let wake = () => {}
    const seen = (status: string) => {
      if (!on) return
      setPlacedStatus(status)
      if (status === 'rejected') notifyError()
    }
    const off = s.orderEvents.subscribe((u) => {
      if (u.orderid === placedId) wake()
    })
    void (async () => {
      for (const ms of PLACED_STATUS_DELAYS_MS) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms)
          wake = () => {
            clearTimeout(t)
            resolve()
          }
        })
        if (!on) return
        let status: string | undefined
        try {
          const b = await trading.orders.orderbook({ fresh: true })
          status = b.orders.find((r) => r.orderid === placedId)?.status
        } catch {
          continue
        }
        if (status === undefined) continue
        seen(status)
        if (FINAL.includes(status)) return
      }
    })()
    return () => {
      on = false
      off()
    }
  }, [placedId, s, trading])

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
   * The review reads the server's mode and, afresh, the order book (ruling 26): the cache can
   * hold a book from before an order the last ticket placed (a write only marks it stale), and
   * that order would then match. Confirm waits for the book, up to `BOOK_WAIT_MS`.
   */
  const openReview = () => {
    setTicket((t) => ({
      ...t,
      price: snapPrice(t.price, meta),
      trigger: snapPrice(t.trigger, meta),
    }))
    setStep({ kind: 'review', mode: null })
    book.read()
    readMode(++modeReads.current)
  }

  const retryRead = () => {
    setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
    readMode(++modeReads.current)
  }

  /** When the send went, and what it knew of the book (`useReviewBook`'s snapshot). */
  type Sent = BookSnapshot & { at: number }

  /**
   * An outcome once the sheet has gone: the toast says it, and the session keeps the line for
   * the next review, since on iOS a presented sheet hides that toast.
   */
  const tell = (line: string) => {
    goneLine.current = line
    toast(line)
  }

  /** Shows `result` on the sheet, or as a toast once the sheet has gone (it may, mid-send). */
  const show = (result: TicketResult) => {
    if (alive.current) setStep({ kind: 'result', result })
    else tell(resultLine(result))
  }

  /** Back to edit with `error`, or the error as a toast once the sheet has gone. */
  const refused = (error: string) => {
    if (alive.current) setStep({ kind: 'edit', error })
    else tell(error)
  }

  /**
   * It may have gone: the order book says what happened. Nothing is sent again. The check runs
   * to its end even when the sheet has closed, and then shows as a toast.
   */
  const reconcile = async (p: OrderPlan, sent: Sent, noReply: boolean) => {
    phase.current = 'checking'
    notifyWarning()
    // No reply: the server may still be sending it, so the check reads on past its broker timeout.
    const delaysMs = noReply
      ? noReplyDelays(p.kind === 'split' ? p.children.length : undefined)
      : undefined
    const waitSec = delaysMs ? Math.round(delaysMs.reduce((a, b) => a + b, 0) / 1000) : undefined
    show({ kind: 'maybe', check: null, waitSec })
    const common = {
      // Each check read goes out after the order, never joined to one sent before it.
      fetchOrders: () => trading.orders.orderbook({ fresh: true }),
      spec: p.spec,
      sentAt: sent.at,
      knownIds: sent.knownIds,
      sleep,
      delaysMs,
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

  /**
   * What came of the send (`settle`, rulings 5): `maybe`, a Server error from the send itself and
   * a success without an id may hide a placed order, so the book is checked.
   */
  const showOutcome = async (
    out: Outcome<PlaceReply | SplitReply>,
    p: OrderPlan,
    sent: Sent,
    shownMode: AnalyzerMode,
  ) => {
    const r = settle(out, p.kind === 'split' ? 'splitorder' : 'placeorder')
    switch (r.kind) {
      case 'ok': {
        const reply = r.reply
        if (reply.kind === 'no_id') return reconcile(p, sent, false)
        if (reply.kind === 'queued') {
          show({ kind: 'queued' })
          return
        }
        // The review showed ANALYZE, but the server placed it LIVE: never told as a success.
        const live = r.liveSurprise ? { liveSurprise: true as const } : {}
        if (r.liveSurprise) notifyError()
        else if (reply.kind === 'split' && !reply.children.every((c) => c.ok)) notifyWarning()
        else notifySuccess()
        if (reply.kind === 'placed') {
          // Ruling 12 and T11: the app's own order, so its event should follow.
          if (isEvented()) trading.eventWatch.expect(reply.orderid)
          show({ ...reply, ...live })
        } else {
          show({ kind: 'split', reply, ...live })
        }
        return
      }
      case 'maybe':
        return reconcile(p, sent, r.noReply)
      case 'refused':
        notifyWarning()
        refused(r.message)
        return
      case 'semi_auto_blocked':
        notifyWarning()
        refused(r.message)
        return
      case 'mode_changed':
        if (alive.current) setStep({ kind: 'review', mode: r.now, notice: modeChanged(r.now) })
        else tell(`The server is now in ${MODE_LABEL[r.now]} mode. ${NOT_SENT}`)
        return
      case 'cancelled':
        if (alive.current) setStep({ kind: 'review', mode: shownMode, notice: r.message })
        else tell(NOT_SENT)
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
      const release = holdOrder(trading, me)
      goneLine.current = null
      phase.current = 'sending'
      setStep({ kind: 'sending', mode: shownMode })
      try {
        // `send` takes the snapshot just before the request; until then nothing is known.
        const sent: Sent = { at: Date.now(), knownIds: new Set(), complete: false }
        const send = (): Promise<PlaceReply | SplitReply> => {
          Object.assign(sent, book.snapshot(), { at: Date.now() })
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
        await showOutcome(out, p, sent, shownMode)
      } finally {
        phase.current = 'idle'
        // An outcome only the toast carried goes to the review that waits for it, or the next.
        release(goneLine.current)
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
            bookPending={book.pending}
            otherOut={otherOut}
            earlier={earlierLine}
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
            placedStatus={placedStatus}
            onDone={() => router.back()}
            onViewOrderbook={() => router.dismissTo(ordersHref({ segment: 'all' }) as Href)}
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
