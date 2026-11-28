// A tool page's basket, held for review (design 7.7, 7.10; plan F Review Focus 2): the page's
// basketorder waits in the gateway until this sheet settles it. The basket is read strictly, so
// the review shows it as it will go (BasketReview); confirm goes with the ticket's safety, and the
// page gets the server's own reply, or a 200 `{status:'error', message}` for every outcome without
// one (ux-bar XL-1: ExecuteBasketDialog toasts it and keeps Execute enabled).
// - The send begins (held.begin) once confirm has passed the guard. Until then a page that gives
//   up, or a tool that is left, answers "cancelled" and nothing goes, then or later; from then on
//   the page gets the basket's real outcome, and if the tool goes meanwhile it shows as a toast.
// - Before the send, Back, the backdrop, a drag down and Android's back cancel; while it is on its
//   way none of them does anything (ui/BottomSheet's `dismissible`, useHoldSheet). A backdrop tap
//   or a drag down slides the sheet out first: a confirm tapped while it slides wins, the sheet
//   springs back and the page gets the basket's real outcome, never "cancelled".
// - It sits in the tool screen, under the app's lock cover, on every platform: a confirm never
//   goes while locked, and a back on the cover cancels nothing.
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'
import { useStore } from 'zustand'
import { useServices } from '~/core/services/services'
import type { DomReply } from '~/dom/bridge/protocol'
import {
  CANCELLED_COPY,
  type HeldWrite,
  type HeldWrites,
  heldRefusal,
} from '~/dom/gateway/heldWrites'
import { type BasketOutcome, BasketReview } from '~/features/order'
import { parseHeldBasket } from '~/market/orders/basket'
import { CHECKING } from '~/market/orders/outcome'
import { BottomSheet } from '~/ui/BottomSheet'
import { UNREADABLE_ORDER } from '../model'

/** One full-height snap: the legs and the pinned confirm get the whole screen (BR-1). */
const FULL = [1] as const

/** The page's answer for an outcome, or null while the review goes on (it shows again). */
function replyFor(o: BasketOutcome): DomReply | null {
  switch (o.kind) {
    case 'placed':
      return { status: 200, body: o.raw }
    case 'queued':
      // the server's own queued reply (order_router_service.py queue_order)
      return {
        status: 200,
        body: {
          status: 'success',
          mode: 'semi_auto',
          pending_order_id: o.pendingId,
          message: o.message,
        },
      }
    case 'checking':
      // it may have placed legs: the page hears the app's MaybePlaced copy, never "failed"
      return heldRefusal('basketorder', 502, CHECKING)
    case 'refused':
      return heldRefusal('basketorder', o.status, o.message)
    case 'semi_auto_blocked':
      return heldRefusal('basketorder', 403, o.message)
    case 'cancelled':
      // the trader said no; a live check that failed leaves the review up, to try again
      return o.message === undefined ? heldRefusal('basketorder', 400, CANCELLED_COPY) : null
    case 'mode_changed':
      return null
  }
}

/**
 * The review of the basket a tool page holds, one at a time: the next held write shows once this
 * one is done with. Null while no basket is held.
 */
export function HeldBasketSheet({ held }: { held: HeldWrites }): JSX.Element | null {
  const current = useStore(held, (st) =>
    st.current?.endpoint === 'basketorder' ? st.current : null,
  )
  /** The write on the sheet: it stays there after it is settled, while its outcome shows. */
  const [pinned, setPinned] = useState<HeldWrite | null>(null)
  useEffect(() => {
    if (pinned !== null || current === null) return
    // Only a write the store still holds is pinned: an unreadable one is settled by its view's
    // mount effect, which runs before this one in the same commit (as HeldOrderSheet).
    if (held.getState().current?.id === current.id) setPinned(current)
  }, [pinned, current, held])
  const done = useCallback(() => setPinned(null), [])
  const write = pinned ?? current
  if (write === null) return null
  return (
    <HeldBasketView
      key={write.id}
      held={held}
      write={write}
      live={current?.id === write.id}
      onDone={done}
    />
  )
}

function HeldBasketView({
  held,
  write,
  live,
  onDone,
}: {
  held: HeldWrites
  write: HeldWrite
  /** The gateway still holds it: false once answered, or cancelled before its send began. */
  live: boolean
  onDone: () => void
}) {
  const s = useServices()
  const spec = useMemo(() => parseHeldBasket(write.body), [write])
  /** Whether the page has been answered: an outcome after the first never answers it again. */
  const answered = useRef(false)
  const answer = useCallback(
    (reply: DomReply) => {
      if (answered.current) return
      answered.current = true
      held.settle(write.id, reply)
    },
    [held, write],
  )
  // A basket the review cannot show as it would go is answered at once, and nothing is sent.
  useEffect(() => {
    if (spec !== null) return
    answer(heldRefusal('basketorder', 400, UNREADABLE_ORDER))
    onDone()
  }, [spec, answer, onDone])

  /** Its send began: until an outcome lands, nothing closes the sheet. */
  const [sending, setSending] = useState(false)
  /**
   * The same, as a close reads it when it runs: set as the send begins, not at the next render,
   * so a close from an earlier render (one that began before the confirm) never cancels it.
   */
  const sendingNow = useRef(false)
  const begin = () => {
    const ok = held.begin(write.id)
    if (ok) {
      sendingNow.current = true
      setSending(true)
    }
    return ok
  }
  const onOutcome = (o: BasketOutcome) => {
    sendingNow.current = false
    setSending(false)
    const reply = replyFor(o)
    if (reply === null) return
    answer(reply)
    if (o.kind === 'cancelled') onDone()
  }

  /** Back, the backdrop, a drag down or Android's back: cancelled before the send, else put away. */
  const close = () => {
    if (sendingNow.current) return
    answer(heldRefusal('basketorder', 400, CANCELLED_COPY))
    onDone()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  // Android's back reaches the sheet before the page or the stack; while the basket is on its way
  // the review's hold takes it first (useHoldSheet), and a back on the lock cover does nothing.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!s.lock.isLocked()) closeRef.current()
      return true
    })
    return () => sub.remove()
  }, [s])

  // The hold went before a send began (the page gave up, or the tool reset it): nothing to review.
  useEffect(() => {
    if (!live && !answered.current && !sending) onDone()
  }, [live, sending, onDone])

  if (spec === null) return null
  return (
    <View style={StyleSheet.absoluteFill}>
      <BottomSheet
        testID="tool-held-basket"
        snapPoints={FULL}
        dismissible={!sending}
        bodyScrolls={false}
        onClose={close}
        header={null}
      >
        <BasketReview
          spec={spec}
          title={spec.strategy}
          onBegin={begin}
          onOutcome={onOutcome}
          onClose={close}
        />
      </BottomSheet>
    </View>
  )
}
