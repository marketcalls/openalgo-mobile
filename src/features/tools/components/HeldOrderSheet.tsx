// A tool page's order, held for review (design 7.7, 7.10): the page's placeorder waits in the
// gateway until this sheet settles it, with the ticket's safety. The order is read strictly, so
// the review shows it as it will go; the server's mode is read for the review and again before
// the send; a live order asks for biometrics when that is on; one confirm at a time, held on the
// new-order scope until its outcome is known (another ticket's order waits for it, and it for
// theirs); sent once, never again. An outcome that may hide a placed order is checked against
// the order book, never re-sent. The page gets the server's own reply shape.
// - The send begins (held.begin) only once the mode and the live confirm have passed: until
//   then a page that gives up, or a tool that is left, answers "cancelled" and nothing goes.
// - While the order is on its way the sheet cannot be dismissed; if the tool goes meanwhile, the
//   outcome shows as a toast.
// - The page's next orders wait in the gateway, first in, first out; the sheet says how many
//   (`tool-held-queue`) and shows the next once this one is done with, each with its own review.
import { type Href, useRouter } from 'expo-router'
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { BackHandler, Platform, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from 'zustand'
import { ApiError } from '~/core/http/errors'
import { log } from '~/core/log/logger'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useServices } from '~/core/services/services'
import type { DomReply } from '~/dom/bridge/protocol'
import { CANCELLED_COPY, type HeldWrite, type HeldWrites } from '~/dom/gateway/heldWrites'
import { fromApiError } from '~/dom/gateway/requests'
import { canConfirm, ReviewStep } from '~/features/order'
import { useIsEvented } from '~/market/books/queries'
import type { Orderbook } from '~/market/books/schemas'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { useInstrument } from '~/market/instruments/useInstrument'
import { ordersHref } from '~/market/links'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { CHECKING, modeChanged, NOT_CHECKED, orderTerms } from '~/market/orders/outcome'
import {
  placementOutcome,
  type Reconcile,
  reconcileText,
  resultLine,
  type Sent,
  waitText,
} from '~/market/orders/result'
import { PlaceReplySchema } from '~/market/orders/schemas'
import { LIVE_SURPRISE, submitOrderAction } from '~/market/orders/submit'
import type { OrderPlan } from '~/market/orders/ticket'
import { useConfirmedReview } from '~/market/orders/useConfirmedReview'
import { useFreshBook } from '~/market/orders/useFreshBook'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { Button } from '~/ui/Button'
import { Sheet } from '~/ui/Sheet'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import { type HeldOrder, heldQueueLine, readHeldOrder, toolOf, UNREADABLE_ORDER } from '../model'

/** The toast when the tool goes while its order is on its way. */
export const STILL_SENDING = 'Your order is still being sent. Its outcome will show here.'
const NOT_SENT = 'The order was not sent.'
/** The page gave up on its order before the send began. */
export const WITHDRAWN = 'The tool withdrew this order, so it was not sent.'

/** The page's reply for an order the review did not send. */
const CANCELLED: DomReply = { status: 400, body: { status: 'error', message: CANCELLED_COPY } }

/**
 * What `send` throws when the hold is gone as the send would begin (the page gave up, or the
 * tool was left during the live confirm): nothing is sent. A Validation error, so
 * submitOrderAction answers it as an error that never went, not as an outcome to check.
 */
const NOT_HELD = new ApiError({ kind: 'Validation', status: 0, endpoint: 'placeorder' })

type Step =
  | { kind: 'review'; mode: AnalyzerMode | null; readError?: unknown; notice?: string }
  | { kind: 'sending'; mode: AnalyzerMode }
  /** The server took it LIVE after an ANALYZE review: the danger notice, until Done. */
  | { kind: 'surprise' }
  /** It may have gone: the order book is being read (`check` null) or has been. */
  | { kind: 'maybe'; check: Reconcile | null; waitSec?: number }

/** The order book was never read for it: "Couldn't check the order book" (reconcileText). */
const UNCHECKED: Reconcile = { kind: 'single', checked: false, status: null, earlier: false }

const orderIds = (b: Orderbook | undefined): string[] => b?.orders.map((o) => o.orderid) ?? []

/** The order as the reconcile reads the book for it: the page's strategy is its own. */
const planOf = (o: HeldOrder): OrderPlan => ({
  kind: 'single',
  spec: {
    exchange: o.exchange,
    symbol: o.symbol,
    action: o.action,
    quantity: o.quantity,
    pricetype: o.pricetype,
    product: o.product,
    price: o.price,
    trigger_price: o.trigger_price,
  },
})

/**
 * The review of the order a tool page holds, one at a time: the next shows once this one is
 * done with. Null while nothing is held.
 */
export function HeldOrderSheet({ held }: { held: HeldWrites }): JSX.Element | null {
  // a held basket has its own review (HeldBasketSheet)
  const current = useStore(held, (st) =>
    st.current?.endpoint === 'placeorder' ? st.current : null,
  )
  const shownNow = useStore(held, (st) => st.current)
  const waiting = useStore(held, (st) => st.waiting)
  /** The write on the sheet: it stays there after it is settled, while its outcome shows. */
  const [pinned, setPinned] = useState<HeldWrite | null>(null)
  useEffect(() => {
    if (pinned !== null || current === null) return
    // Only a write the store still holds is pinned. An unreadable one is settled by its view's
    // mount effect, which runs before this one in the same commit: this render's `current` is
    // then already answered, and pinning it would hide every later write behind it.
    if (held.getState().current?.id === current.id) setPinned(current)
  }, [pinned, current, held])
  const done = useCallback(() => setPinned(null), [])
  const write = pinned ?? current
  if (write === null) return null
  // Behind the write on show: those waiting, and the next, once this one is answered while its
  // outcome still shows.
  const more = waiting + (shownNow !== null && shownNow.id !== write.id ? 1 : 0)
  return (
    <HeldWriteView
      key={write.id}
      held={held}
      write={write}
      live={current?.id === write.id}
      more={more}
      onDone={done}
    />
  )
}

function HeldWriteView(p: {
  held: HeldWrites
  write: HeldWrite
  live: boolean
  more: number
  onDone: () => void
}) {
  const order = useMemo(() => readHeldOrder(p.write.body), [p.write])
  const { held, write, onDone } = p
  // An order the review cannot show as it would go is answered at once, and nothing is sent.
  useEffect(() => {
    if (order !== null) return
    held.settle(write.id, {
      status: 400,
      body: { status: 'error', message: UNREADABLE_ORDER },
    })
    onDone()
  }, [order, held, write, onDone])
  if (order === null) return null
  return <HeldReview {...p} order={order} />
}

function HeldReview({
  held,
  write,
  order,
  live,
  more,
  onDone,
}: {
  held: HeldWrites
  write: HeldWrite
  order: HeldOrder
  live: boolean
  /** The held orders behind this one. */
  more: number
  onDone: () => void
}) {
  const s = useServices()
  const trading = useTrading()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { trade } = useTheme()
  const blocked = useBrokerBlocked()
  const isEvented = useIsEvented()
  const inst = useInstrument(order.exchange, order.symbol)
  const [step, setStep] = useState<Step>({ kind: 'review', mode: null })
  const stillHeld = useRef(live)
  stillHeld.current = live
  // Android draws a Modal in a window of its own, above the app's lock cover (LockOverlay.tsx;
  // iOS puts the cover above every window): while the app is locked the review is not shown, and
  // it comes back as it was once unlocked. A confirm never goes while locked, on any platform.
  const locked = useSyncExternalStore(s.lock.subscribe, s.lock.isLocked)
  const hidden = locked && Platform.OS === 'android'
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden

  const readFresh = useFreshBook()
  const pid = s.profile.get().id
  const readIds = useCallback(async () => orderIds(await readFresh()), [readFresh])
  const cachedIds = useCallback(
    () => orderIds(s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid))),
    [s, pid],
  )
  const sending = step.kind === 'sending'
  const shell = useConfirmedReview({
    onReview: step.kind === 'review',
    sending,
    stillSending: STILL_SENDING,
    readIds,
    cachedIds,
  })
  const { book, guard, otherOut, earlierLine } = shell

  const readMode = () =>
    shell.readMode((r) =>
      setStep((st) =>
        st.kind !== 'review'
          ? st
          : 'mode' in r
            ? { ...st, mode: r.mode, readError: undefined }
            : { ...st, readError: r.error },
      ),
    )
  // The review reads the server's mode and, afresh, the order book (ruling 26).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the review opens
  useEffect(() => {
    book.read()
    readMode()
  }, [])

  // The hold went before a send began (the page gave up, or the tool reset it): nothing to review.
  useEffect(() => {
    if (!live && step.kind === 'review') onDone()
  }, [live, step.kind, onDone])

  /** Whether this write has been answered: an unexpected throw never answers it twice. */
  const answered = useRef(false)
  const answer = (reply: DomReply) => {
    answered.current = true
    held.settle(write.id, reply)
  }

  /** Backdrop, Android back and Cancel: a review is cancelled; an outcome on show is put away. */
  const close = () => {
    if (step.kind === 'sending') return
    if (step.kind === 'review') answer(CANCELLED)
    onDone()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  // Android's back reaches the sheet first, never the page or the stack; while the order is on
  // its way the sheet's hold takes it (useHoldSheet).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // a back on the lock cover never cancels a review nobody can see
      if (!hiddenRef.current) closeRef.current()
      return true
    })
    return () => sub.remove()
  }, [])

  const viewOrderbook = () => {
    onDone()
    router.dismissTo(ordersHref({ segment: 'all' }) as Href)
  }

  /**
   * Something threw while the order was handled (a bug, never an outcome): the page is answered
   * and the sheet can go, so neither waits for ever. Before the send began nothing went; after,
   * it may have, so the page hears that, nothing is sent again, and the order book tells.
   */
  const afterThrow = (begun: boolean, e: unknown) => {
    log.warn('tool', `held order: ${e instanceof Error ? e.message : String(e)}`)
    notifyError()
    if (!begun) {
      if (!answered.current) answer(CANCELLED)
      shell.onSheet(onDone, NOT_SENT)
      return
    }
    if (!answered.current) answer({ status: 502, body: { status: 'error', message: CHECKING } })
    shell.onSheet(() => setStep({ kind: 'maybe', check: UNCHECKED }), NOT_CHECKED)
  }

  const confirm = (shownMode: AnalyzerMode) =>
    shell.confirm(
      () => stillHeld.current && !s.lock.isLocked(),
      async () => {
        let begun = false
        try {
          await sendHeld(shownMode, () => {
            begun = true
          })
        } catch (e) {
          afterThrow(begun, e)
        }
      },
    )

  const sendHeld = async (shownMode: AnalyzerMode, onBegun: () => void) => {
    setStep({ kind: 'sending', mode: shownMode })
    // `send` takes the snapshot just before the request; until then nothing is known.
    const sent: Sent = { at: Date.now(), knownIds: new Set(), complete: false }
    const send = () => {
      if (!held.begin(write.id)) throw NOT_HELD
      onBegun()
      Object.assign(sent, book.snapshot(), { at: Date.now() })
      return s.api.call('placeorder', order, PlaceReplySchema)
    }
    const out = await submitOrderAction({
      kind: 'place',
      shownMode,
      send,
      gate: trading.analyzer,
      confirmLive: confirmLiveOrder,
      books: s.books,
    })
    if (out.kind === 'error' && out.error === NOT_HELD) {
      // the page was answered "cancelled" when it gave up
      shell.onSheet(() => {
        toast(WITHDRAWN)
        onDone()
      }, WITHDRAWN)
      return
    }
    if (
      out.kind === 'error' &&
      !(out.error.kind === 'Server' && out.error.endpoint === 'placeorder')
    ) {
      // refused, or the mode could not be read: its status and the app's words for it
      notifyError()
      const reply = fromApiError(out.error)
      answer(reply)
      shell.onSheet(onDone, String((reply.body as { message: string }).message))
      return
    }
    const r = placementOutcome(out, {
      plan: planOf(order),
      sent,
      // Each check read goes out after the order, never joined to one sent before it.
      fetchOrders: () => trading.orders.orderbook({ fresh: true }),
    })
    switch (r.kind) {
      case 'result': {
        const res = r.result
        if (res.kind === 'queued') {
          // the server's own queued reply (order_router_service.py queue_order)
          const pendingId =
            out.kind === 'done' && out.reply.kind === 'queued' ? out.reply.pendingId : ''
          notifySuccess()
          answer({
            status: 200,
            body: {
              status: 'success',
              mode: 'semi_auto',
              pending_order_id: pendingId,
              message: QUEUED_COPY,
            },
          })
          shell.onSheet(onDone, resultLine(res))
          return
        }
        // a placeorder reply is never a split's (PlaceReplySchema): afterThrow, if it were
        if (res.kind !== 'placed') throw new Error(`a placeorder outcome of kind ${res.kind}`)
        answer({ status: 200, body: { status: 'success', orderid: res.orderid } })
        // Ruling 12 and T11: the app's own order, so its event should follow.
        if (isEvented()) trading.eventWatch.expect(res.orderid)
        if (res.liveSurprise) {
          // The review showed ANALYZE, but the server placed it LIVE: never a success.
          notifyError()
          shell.onSheet(() => setStep({ kind: 'surprise' }), resultLine(res))
          return
        }
        notifySuccess()
        shell.onSheet(onDone, resultLine(res))
        return
      }
      case 'unknown':
        // It may have gone: the order book says what happened. Nothing is sent again. The
        // check runs to its end even when the sheet has closed, and then shows as a toast.
        notifyWarning()
        answer({ status: 502, body: { status: 'error', message: CHECKING } })
        shell.checking()
        shell.onSheet(() => setStep({ kind: 'maybe', check: null, waitSec: r.waitSec }), CHECKING)
        {
          const check = await r.check()
          shell.onSheet(
            () => setStep({ kind: 'maybe', check }),
            resultLine({ kind: 'maybe', check }),
          )
        }
        return
      case 'semi_auto_blocked':
        notifyError()
        answer({ status: 403, body: { status: 'error', message: r.message } })
        shell.onSheet(onDone, r.message)
        return
      case 'mode_changed':
        // Nothing went: the review shows again in the new mode, and reads its book.
        shell.modeChanged(
          r.now,
          () => setStep({ kind: 'review', mode: r.now, notice: modeChanged(r.now) }),
          NOT_SENT,
        )
        return
      case 'cancelled':
        if (r.message !== undefined) {
          // the live check failed rather than the trader: the review stays, to try again
          shell.onSheet(
            () => setStep({ kind: 'review', mode: shownMode, notice: r.message }),
            NOT_SENT,
          )
          return
        }
        answer(CANCELLED)
        shell.onSheet(onDone, NOT_SENT)
        return
      case 'refused':
        // a refusal placementOutcome made of an error; errors are answered above
        notifyError()
        answer({ status: 400, body: { status: 'error', message: r.message } })
        shell.onSheet(onDone, r.message)
        return
    }
  }

  const title = toolOf(write.page)?.title ?? write.page
  const sideColor = order.action === 'BUY' ? trade.buy : trade.sell
  const reviewing = step.kind === 'review' || step.kind === 'sending'
  const mode = step.kind === 'review' || step.kind === 'sending' ? step.mode : null
  const ready =
    step.kind === 'review' &&
    !inst.loading &&
    !inst.unknown &&
    canConfirm({
      mode,
      bookPending: book.pending,
      otherOut,
      blocked: blocked || guard.busy(),
    })

  const head = (
    <View testID="tool-held-head" style={styles.head}>
      <Text style={styles.headline} numberOfLines={1}>
        <Text style={[styles.headline, { color: sideColor }]}>{order.action}</Text>
        {` ${order.symbol}`}
      </Text>
      {inst.loading ? (
        <Skeleton rows={1} />
      ) : (
        <Text tone="muted" style={styles.meta} numberOfLines={1}>
          {inst.unknown
            ? `${order.exchange} · Expired or unknown`
            : `${order.exchange} · ${order.product} · from ${title}`}
        </Text>
      )}
    </View>
  )

  return (
    <Sheet visible={!hidden} onClose={close} dismissible={!sending}>
      <View testID="tool-held-sheet" style={styles.sheet}>
        <ScrollView testID="tool-held-scroll" contentContainerStyle={styles.body}>
          {reviewing ? (
            <ReviewStep
              ids={{
                step: 'tool-held-review',
                mode: 'tool-held-mode',
                summary: 'tool-held-summary',
                notice: 'tool-held-notice',
                earlier: 'tool-held-earlier',
                wait: 'tool-held-wait',
              }}
              title={head}
              summary={orderTerms(order, inst.meta)}
              split={null}
              side={order.action}
              mode={mode}
              readError={step.kind === 'review' ? step.readError : undefined}
              onRetryRead={() => {
                setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
                readMode()
              }}
              bookPending={book.pending}
              otherOut={otherOut}
              earlier={earlierLine}
              notice={step.kind === 'review' ? step.notice : undefined}
              sending={sending}
              blocked={blocked || guard.busy()}
              onConfirm={() => {}}
              onBack={close}
              footer={null}
            />
          ) : step.kind === 'surprise' ? (
            <View style={styles.result}>
              {head}
              <LiveSurpriseNotice text={LIVE_SURPRISE} />
            </View>
          ) : (
            <View style={styles.result}>
              {head}
              <Text testID="tool-held-result">
                {step.check === null ? CHECKING : reconcileText(step.check)}
              </Text>
              {step.check === null && step.waitSec !== undefined ? (
                <Text variant="caption" tone="muted">
                  {waitText(step.waitSec)}
                </Text>
              ) : null}
            </View>
          )}
        </ScrollView>
        <View testID="tool-held-footer" style={[styles.footer, { paddingBottom: insets.bottom }]}>
          {more > 0 ? (
            <Text testID="tool-held-queue" variant="caption" tone="muted" numberOfLines={1}>
              {heldQueueLine(more)}
            </Text>
          ) : null}
          {reviewing ? (
            <>
              <Button
                testID="tool-held-confirm"
                title={`Place ${order.action} order`}
                variant={order.action === 'BUY' ? 'buy' : 'sell'}
                loading={sending}
                disabled={!ready}
                onPress={() => {
                  if (step.kind === 'review' && step.mode !== null) confirm(step.mode)
                }}
              />
              <Button
                testID="tool-held-cancel"
                title="Cancel"
                variant="secondary"
                disabled={sending}
                onPress={close}
              />
            </>
          ) : (
            <>
              {step.kind === 'maybe' ? (
                <Button
                  testID="tool-held-orderbook"
                  title="View in order book"
                  variant="secondary"
                  onPress={viewOrderbook}
                />
              ) : null}
              <Button testID="tool-held-done" title="Done" onPress={close} />
            </>
          )}
        </View>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  sheet: { flexShrink: 1 },
  body: { gap: 16, paddingBottom: 16 },
  head: { flex: 1, minWidth: 0, gap: 2 },
  headline: { fontSize: 18, fontWeight: '700' },
  meta: { fontSize: 13 },
  result: { gap: 12 },
  footer: { gap: 12, paddingTop: 8 },
})
