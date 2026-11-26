// One-tap mode (design 7.10, 7.9.4): with the Account switch on, BUY and SELL on the chart place
// a market order at once, and the header's mode badge stands for the review. The rest of the
// order safety stays: the mode on the badge re-read before the send and checked against it, the
// live confirm when that is on, one order at a time with the 120 ms cooldown, the session's hold
// on a new order, sent once and never again, and an outcome that may hide the order checked
// against the order book (rulings 5). It refuses what the ticket would not send as one order
// (a quote-only instrument, above the freeze limit, preflight conflict 29), and anything while
// the badge cannot show the mode (conflict 7) or another order's outcome is not known yet.
import { useIsFocused } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { usePrefs } from '~/core/config/prefs'
import { ApiError, type ApiErrorKind, userMessage } from '~/core/http/errors'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { type ConnectionState, useConnection } from '~/core/services/connection'
import { useServices } from '~/core/services/services'
import type { ChartMeta, Inst } from '~/dom/bridge/protocol'
import { useIsEvented } from '~/market/books/queries'
import type { Orderbook } from '~/market/books/schemas'
import type { WriteOutcome } from '~/market/components/OutcomeLine'
import { QUEUED_COPY } from '~/market/components/SessionBanners'
import { defaultProduct, isQuoteOnly } from '~/market/instruments/exchanges'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { useSubmitGuard } from '~/market/orders/guard'
import { CHECKING, modeChanged } from '~/market/orders/outcome'
import { holdOrder, NEW_ORDER, otherOrderOut, useOtherOrderOut } from '~/market/orders/pending'
import { placementOutcome, reconcileText, resultLine, type Sent } from '~/market/orders/result'
import { liveSurpriseText, readMode, submitOrderAction } from '~/market/orders/submit'
import { planOrder, QUOTE_ONLY_COPY } from '~/market/orders/ticket'
import { useFreshBook } from '~/market/orders/useFreshBook'
import { useReviewBook } from '~/market/orders/useReviewBook'
import { useTrading } from '~/market/trading'
import type { Side } from '~/market/types'
import { toast } from '~/ui/Toast'

export const ABOVE_FREEZE = (n: number) => `Above the freeze quantity of ${n}: use the ticket.`
export const EARLIER_OUT = "An earlier order's outcome isn't known yet. Tap again once it is."
/** The badge cannot show the mode yet (preflight conflict 7): it is read, and nothing is sent. */
export const MODE_UNKNOWN = "Checking the server's mode. Tap again once the badge shows it."
const NOT_SENT = 'The order was not sent.'

const orderIds = (b: Orderbook | undefined): string[] => b?.orders.map((o) => o.orderid) ?? []

/**
 * Why broker-backed calls cannot succeed now, in the words the app says it elsewhere; null when
 * nothing blocks them (`useBrokerBlocked`'s rule, read at the tap).
 */
function blockedReason(c: ConnectionState): string | null {
  const kind: ApiErrorKind | null =
    c.banned !== null
      ? 'IpBanned'
      : c.keyState === 'invalid'
        ? 'KeyInvalid'
        : c.brokerSession === 'logged_out'
          ? 'BrokerLoggedOut'
          : null
  return kind === null
    ? null
    : userMessage(new ApiError({ kind, status: 0, endpoint: 'placeorder' }))
}

const line = (text: string): WriteOutcome => ({ text, tone: 'neutral' })
const warn = (text: string): WriteOutcome => ({ text, tone: 'warning' })
/** An outcome the order book settles: the line links there. */
const unsettled = (text: string): WriteOutcome => ({ text, tone: 'warning', orderbook: true })

/**
 * `place` sends one order for `lots` (whole lots of a derivative, shares otherwise) at market,
 * in the exchange's default product, as 'mobile-chart'. `semiBlocked` is the reason of an order
 * Semi-Auto refused, `liveSurprise` the notice for one the server took LIVE while the badge said
 * ANALYZE, `outcome` the last order's line; each lasts until dismissed or the next tap.
 */
export function useOneTap() {
  const s = useServices()
  const trading = useTrading()
  const guard = useSubmitGuard()
  const isEvented = useIsEvented()
  const on = usePrefs((p) => p.chartOneTap)
  const focused = useIsFocused()
  /** This chart, as the session's writes still out know it. */
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me, NEW_ORDER)
  const readFresh = useFreshBook()
  const pid = s.profile.get().id
  const readIds = useCallback(async () => orderIds(await readFresh()), [readFresh])
  const cachedIds = useCallback(
    () => orderIds(s.queryClient.getQueryData<Orderbook>(qk.orderbook(pid))),
    [s, pid],
  )
  // The book a one-tap order is told apart from (preflight conflict 8, ruling 26): read when the
  // chart has focus, again once another ticket's order is released, and after each one-tap.
  const book = useReviewBook({ owner: me, otherOut, onReview: on && focused, readIds, cachedIds })
  const { read } = book
  useEffect(() => {
    if (on && focused) read()
  }, [on, focused, read])
  const [semiBlocked, setSemiBlocked] = useState<string | null>(null)
  const [liveSurprise, setLiveSurprise] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null)

  /** The line on the chart, and as a toast (which a screen reader hears). */
  const tell = (o: WriteOutcome) => {
    setOutcome(o)
    toast(o.text)
  }
  const refuse = (text: string) => {
    notifyWarning()
    toast(text)
  }

  const place = (inst: Inst, meta: ChartMeta, side: Side, lots: number) =>
    void guard.run(async () => {
      setSemiBlocked(null)
      setLiveSurprise(null)
      setOutcome(null)
      // What the ticket refuses first (`validateTicket`), on the same exchange test. The page
      // hides BUY and SELL on an index, but the bridge is not trusted, and the server would take
      // the order: its VALID_EXCHANGES lists the index exchanges (utils/constants.py at c8b2896).
      if (meta.quoteOnly || isQuoteOnly(inst.exchange)) return refuse(QUOTE_ONLY_COPY)
      const conn = useConnection.getState()
      const blocked = blockedReason(conn)
      if (blocked !== null) return refuse(blocked)
      const plan = planOrder(
        {
          exchange: inst.exchange,
          symbol: inst.symbol,
          action: side,
          product: defaultProduct(inst.exchange),
          pricetype: 'MARKET',
          qty: lots,
        },
        meta,
      )
      // The ticket would split it; one tap is one order, as the web's armed path refuses it.
      if (plan.kind === 'split') return refuse(ABOVE_FREEZE(meta.freezeQty))
      if (otherOrderOut(trading, me, NEW_ORDER)) return refuse(EARLIER_OUT)
      const shownMode = conn.analyzer
      if (shownMode === 'unknown') {
        // the read lands on the badge (the tabs layout's useAnalyzer); the next tap can go
        readMode(trading.analyzer).catch(() => {})
        return refuse(MODE_UNKNOWN)
      }
      const release = holdOrder(trading, me, NEW_ORDER)
      try {
        // `send` takes the book's snapshot just before the request; until then nothing is known.
        const sent: Sent = { at: Date.now(), knownIds: new Set(), complete: false }
        const out = await submitOrderAction({
          kind: 'place',
          shownMode,
          send: () => {
            Object.assign(sent, book.snapshot(), { at: Date.now() })
            return trading.orders.place({ ...plan.spec, strategy: 'mobile-chart' })
          },
          gate: trading.analyzer,
          confirmLive: confirmLiveOrder,
          books: s.books,
        })
        const r = placementOutcome(out, {
          plan,
          sent,
          // Each check read goes out after the order, never joined to one sent before it.
          fetchOrders: () => trading.orders.orderbook({ fresh: true }),
        })
        switch (r.kind) {
          case 'result': {
            const res = r.result
            if (res.kind === 'queued') {
              // the connection marked Semi-Auto from the reply; its banner opens the Action Center
              notifySuccess()
              tell(line(QUEUED_COPY))
              return
            }
            if (res.liveSurprise) {
              notifyError()
              setLiveSurprise(liveSurpriseText('place'))
            } else notifySuccess()
            // Ruling 12: the app's own order, so its event should follow.
            if (res.kind === 'placed' && isEvented()) trading.eventWatch.expect(res.orderid)
            tell(line(resultLine(res)))
            return
          }
          case 'unknown':
            notifyWarning()
            tell(unsettled(CHECKING))
            tell(unsettled(reconcileText(await r.check())))
            return
          case 'refused':
            notifyWarning()
            tell(warn(r.message))
            return
          case 'semi_auto_blocked':
            notifyWarning()
            setSemiBlocked(r.message)
            return
          case 'mode_changed':
            notifyWarning()
            tell(warn(modeChanged(r.now)))
            return
          case 'cancelled':
            tell(warn(r.message ?? NOT_SENT))
            return
        }
      } finally {
        release()
        // the next one-tap's book holds this order
        read()
      }
    })

  return {
    place,
    outcome,
    dismissOutcome: () => setOutcome(null),
    semiBlocked,
    liveSurprise,
    dismissLiveSurprise: () => setLiveSurprise(null),
  }
}
