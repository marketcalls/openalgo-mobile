// The GTT ticket (design 17.3), a form sheet for a new GTT or a modify of one in the GTT book:
// edit, then a review that reads the server's mode and the GTT book again, then one send, then
// what came of it. The send goes through the order safety of design 7.10: the mode read before
// it, the live confirm, one request at a time, never retried. An outcome that may hide the write
// is checked against the GTT book and never sent again.
//
// The session holds the write (`holdOrder`, on a new GTT or on this GTT) until its outcome is
// known, the check included, so no other GTT ticket sends on it meanwhile, even once this sheet
// has gone; an outcome only the toast carried is shown by the next review on that scope.
import { type Href, useRouter } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { notifyError, notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { snapPrice } from '~/market/components/OrderFields'
import { BrokerBanner } from '~/market/components/SessionBanners'
import { reconcileGttChange, reconcileGttPlacement } from '~/market/gtt/reconcile'
import type { GttBook, GttReply, GttRow, GttSpec } from '~/market/gtt/schemas'
import {
  type GttRowRefusal,
  type GttTicketState,
  gttIssueText,
  gttSummary,
  gttTicketFromRow,
  initialGttTicket,
  planGtt,
  validateGtt,
} from '~/market/gtt/ticket'
import { isQuoteOnly } from '~/market/instruments/exchanges'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import { type GttParams, ordersHref } from '~/market/links'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { MODE_LABEL } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import { settle, sleep } from '~/market/orders/outcome'
import {
  holdOrder,
  NEW_GTT,
  onGtt,
  takeUnseenOutcome,
  useOtherOrderOut,
  useUnseenOutcome,
} from '~/market/orders/pending'
import { noReplyDelays, RECONCILE_DELAYS_MS } from '~/market/orders/reconcile'
import { type Outcome, submitOrderAction } from '~/market/orders/submit'
import { useHoldSheet } from '~/market/orders/useHoldSheet'
import { type BookSnapshot, useReviewBook } from '~/market/orders/useReviewBook'
import { openServerPage, useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { ErrorState } from '~/ui/ErrorState'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { GttForm } from '../components/GttForm'
import {
  changeLine,
  type GttResult,
  GttResultView,
  gttResultLine,
  placementLine,
} from '../components/GttResultView'
import { GttReview } from '../components/GttReview'

type Step =
  | { kind: 'edit'; error?: string; semiAuto?: string }
  /** `spec` is the GTT as reviewed, planned with the LTP when the review opened. */
  | {
      kind: 'review'
      spec: GttSpec
      mode: AnalyzerMode | null
      readError?: unknown
      notice?: string
    }
  | { kind: 'sending'; spec: GttSpec; mode: AnalyzerMode }
  | { kind: 'result'; result: GttResult }

const NOT_SENT = 'The GTT was not sent.'
const MOVED = 'The price moved since the review. The GTT was not sent.'
/** The toast when the sheet goes while the GTT is on its way. */
export const STILL_SENDING = 'Your GTT is still being sent. Its outcome will show here.'
/** A dismissal refused while the GTT is on its way. */
const HOLD_COPY = 'The GTT is being sent. Wait for its outcome.'
const NOT_IN_BOOK = 'This GTT is no longer in the book.'
const NOT_ACTIVE = 'Only an active GTT can be modified.'
/** A modify replaces the GTT whole (G2), so it sends only what it can send as the row lists it. */
function refusalText(r: GttRowRefusal): string {
  switch (r.refused) {
    // A row without the legs its type needs: its side is not known.
    case 'legs':
      return "This GTT's legs can't be read, so it can't be modified here."
    case 'product':
      return r.product
        ? `This GTT's product (${r.product}) can't be modified here.`
        : "This GTT's product isn't listed, so it can't be modified here."
    case 'pricetype':
      return r.pricetype
        ? `This GTT places a ${r.pricetype} order, so it can't be modified here.`
        : "This GTT's order type isn't listed, so it can't be modified here."
  }
}

const modeChanged = (mode: AnalyzerMode) =>
  `The server is now in ${MODE_LABEL[mode]} mode. Review again.`

const triggerIds = (b: GttBook | undefined): string[] => b?.rows.map((r) => r.triggerId) ?? []

/** Two specs send the same request exactly when every value is the same. */
const sameSpec = (a: GttSpec, b: GttSpec) => JSON.stringify(a) === JSON.stringify(b)

/** Every price of the ticket on the tick, as `planGtt` sends it. */
const snapped = (t: GttTicketState, meta: InstrumentMeta): GttTicketState => ({
  ...t,
  trigger: snapPrice(t.trigger, meta),
  price: snapPrice(t.price, meta),
  slTrigger: snapPrice(t.slTrigger, meta),
  slPrice: snapPrice(t.slPrice, meta),
  tgTrigger: snapPrice(t.tgTrigger, meta),
  tgPrice: snapPrice(t.tgPrice, meta),
})

export function GttTicketScreen({
  mode,
}: {
  mode: { kind: 'new'; params: GttParams } | { kind: 'modify'; triggerId: string }
}) {
  return (
    <View style={styles.fill} testID="gtt-screen">
      <BrokerBanner />
      {mode.kind === 'new' ? (
        <NewGtt params={mode.params} />
      ) : (
        <ModifyGtt triggerId={mode.triggerId} />
      )}
    </View>
  )
}

function NewGtt({ params }: { params: GttParams }) {
  const { exchange, symbol } = params
  if (isQuoteOnly(exchange)) {
    return (
      <Refused at={{ exchange, symbol }} text={gttIssueText('quote_only', { meta: 'unknown' })} />
    )
  }
  return (
    <Listed exchange={exchange} symbol={symbol}>
      {(meta) => <Gtt meta={meta} initial={initialGttTicket(params, meta)} />}
    </Listed>
  )
}

type RowRead = { row: GttRow | null } | { error: unknown } | null

/**
 * The GTT as the book shows it now, read afresh when the sheet opens: a modify replaces the GTT
 * whole, so it starts from the GTT's own values, never from a list read before a change.
 */
function ModifyGtt({ triggerId }: { triggerId: string }) {
  const trading = useTrading()
  const [state, setState] = useState<RowRead>(null)
  /** Each read; one an earlier read or a closed sheet started is dropped. */
  const reads = useRef(0)
  const read = useCallback(() => {
    const seq = ++reads.current
    setState(null)
    trading.gtt.book({ fresh: true }).then(
      (b) => {
        if (reads.current === seq) {
          setState({ row: b.rows.find((r) => r.triggerId === triggerId) ?? null })
        }
      },
      (error: unknown) => {
        if (reads.current === seq) setState({ error })
      },
    )
  }, [trading, triggerId])
  useEffect(() => {
    read()
    return () => {
      reads.current++
    }
  }, [read])

  if (state === null) return <Skeleton />
  if ('error' in state) return <ErrorState error={state.error} onRetry={read} />
  const { row } = state
  if (!row) return <Refused text={NOT_IN_BOOK} />
  if (row.status !== 'active') return <Refused at={row} text={NOT_ACTIVE} />
  return (
    <Listed exchange={row.exchange} symbol={row.symbol}>
      {(meta) => {
        const initial = gttTicketFromRow(row, meta)
        return 'refused' in initial ? (
          <Refused at={row} text={refusalText(initial)} />
        ) : (
          <Gtt meta={meta} initial={initial} triggerId={triggerId} />
        )
      }}
    </Listed>
  )
}

/** The contract's metadata decides the rest: unknown shows only that, and takes no feed slot. */
function Listed({
  exchange,
  symbol,
  children,
}: {
  exchange: string
  symbol: string
  children: (meta: InstrumentMeta) => ReactNode
}) {
  const s = useServices()
  const refused = useIsUnknown(exchange, symbol)
  const inst = useInstrument(exchange, symbol)
  if (refused || inst.unknown) {
    return (
      <Refused
        at={{ exchange, symbol }}
        text={gttIssueText('unknown_instrument', { meta: 'unknown' })}
      />
    )
  }
  if (inst.meta) return children(inst.meta)
  if (inst.loading) return <Skeleton />
  const queryKey = qk.symbol(s.profile.get().id, exchange, symbol)
  return (
    <ErrorState
      error={s.queryClient.getQueryState(queryKey)?.error}
      onRetry={() => void s.queryClient.refetchQueries({ queryKey })}
    />
  )
}

/** Why there is no GTT to fill in, under the contract's name when there is one. */
function Refused({ at, text }: { at?: { exchange: string; symbol: string }; text: string }) {
  return (
    <View style={styles.body}>
      {at ? <Title exchange={at.exchange} symbol={at.symbol} /> : null}
      <Text testID="gtt-refused">{text}</Text>
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

/** `triggerId`: a modify of that GTT; else a new one. */
function Gtt({
  meta,
  initial,
  triggerId,
}: {
  meta: InstrumentMeta
  initial: GttTicketState
  triggerId?: string
}) {
  const { exchange, symbol } = initial
  const s = useServices()
  const trading = useTrading()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const blocked = useBrokerBlocked()
  const guard = useSubmitGuard()
  const ltp = useLiveQuote(exchange, symbol, 1)?.ltp
  const modify = triggerId !== undefined
  const scope = triggerId === undefined ? NEW_GTT : onGtt(triggerId)
  const pid = s.profile.get().id
  const [ticket, setTicket] = useState(initial)
  const [step, setStep] = useState<Step>({ kind: 'edit' })
  /** This ticket, as the session's writes still out know it. */
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me, scope)
  /** Where this ticket's GTT is: on its way, or being checked after an unknown outcome. */
  const phase = useRef<'idle' | 'sending' | 'checking'>('idle')
  const alive = useRef(true)
  /** The last outcome line this ticket's GTT sent to the toast, once its sheet had gone. */
  const goneLine = useRef<string | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // The sheet went while the GTT was on its way (an Android sheet can always be swiped away):
      // what comes of it shows as a toast.
      if (phase.current === 'sending') toast(STILL_SENDING)
    }
  }, [])
  useHoldSheet(step.kind === 'sending', HOLD_COPY)
  const onReview = step.kind === 'review'
  // The review's GTT book, read afresh: its trigger ids are not the GTT this review sends.
  const readIds = useCallback(
    async () => triggerIds(await trading.gtt.book({ fresh: true })),
    [trading],
  )
  const cachedIds = useCallback(
    () => triggerIds(s.queryClient.getQueryData<GttBook>(qk.gttbook(pid))),
    [s, pid],
  )
  const book = useReviewBook({ owner: me, otherOut, onReview, readIds, cachedIds, scope })
  // An earlier GTT write's outcome that only the toast carried: on iOS the toast is beneath this
  // sheet, so the review says it.
  const unseen = useUnseenOutcome(trading, scope)
  const [earlierLine, setEarlierLine] = useState<string | null>(null)
  useEffect(() => {
    if (!onReview || unseen === null) return
    const line = takeUnseenOutcome(trading, scope)
    if (line !== null) setEarlierLine(line)
  }, [onReview, unseen, trading, scope])
  /** Each mode read; one for an earlier opening, or before a retry, is dropped. */
  const modeReads = useRef(0)

  const issueCodes = validateGtt(ticket, meta, ltp)
  const issues = issueCodes.map((issue) => ({ issue, text: gttIssueText(issue, { meta, ltp }) }))

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

  /** The review plans the GTT with the LTP of now, and reads the mode and the GTT book afresh. */
  const openReview = () => {
    const t = snapped(ticket, meta)
    setTicket(t)
    setStep({ kind: 'review', spec: planGtt(t, meta, ltp), mode: null })
    book.read()
    readMode(++modeReads.current)
  }

  const retryRead = () => {
    setStep((st) => (st.kind === 'review' ? { ...st, readError: undefined } : st))
    readMode(++modeReads.current)
  }

  /**
   * An outcome once the sheet has gone: the toast says it, and the session keeps the line for the
   * next review on this scope, since on iOS a presented sheet hides that toast.
   */
  const tell = (line: string) => {
    goneLine.current = line
    toast(line)
  }

  /** Shows `result` on the sheet, or as a toast once the sheet has gone (it may, mid-send). */
  const show = (result: GttResult) => {
    if (alive.current) setStep({ kind: 'result', result })
    else tell(gttResultLine(result, modify))
  }

  /** Back to edit with `error`, or the error as a toast once the sheet has gone. */
  const refused = (error: string) => {
    if (alive.current) setStep({ kind: 'edit', error })
    else tell(error)
  }

  /**
   * It may have gone: the GTT book says what happened. Nothing is sent again. The check runs to
   * its end even when the sheet has closed, and then shows as a toast.
   */
  const reconcile = async (spec: GttSpec, sent: BookSnapshot, noReply: boolean) => {
    phase.current = 'checking'
    notifyWarning()
    show({ kind: 'maybe', line: null })
    const polling = {
      // Each check read goes out after the write, never joined to one sent before it.
      fetchBook: () => trading.gtt.book({ fresh: true }),
      sleep,
      // No reply: the server may still be sending it, so the check reads on past its broker timeout.
      delaysMs: noReply ? noReplyDelays() : RECONCILE_DELAYS_MS,
    }
    const line =
      triggerId === undefined
        ? placementLine(
            await reconcileGttPlacement({ ...polling, spec, knownIds: sent.knownIds }).catch(
              () => null,
            ),
            // Without the review's book, a match may be an earlier identical GTT (ruling 26).
            !sent.complete,
          )
        : changeLine(await reconcileGttChange({ ...polling, triggerId, spec }).catch(() => null))
    show({ kind: 'maybe', line })
  }

  /**
   * What came of the send (`settle`): `maybe`, a Server error from the write's own endpoint and a
   * success without an id may hide the write, so the GTT book is checked.
   */
  const showOutcome = async (
    out: Outcome<GttReply>,
    spec: GttSpec,
    sent: BookSnapshot,
    shownMode: AnalyzerMode,
  ) => {
    // Ruling 16, G3: a JSON 404 carries the server's reason (a modify's "No active GTT": it fired,
    // expired or was cancelled meanwhile), never a missing route, which answers HTML.
    if (out.kind === 'error' && out.error.status === 404 && out.error.serverMessage) {
      notifyWarning()
      if (modify) void s.queryClient.refetchQueries({ queryKey: qk.gttbook(pid) })
      refused(out.error.serverMessage)
      return
    }
    const endpoint = modify ? 'modifygttorder' : 'placegttorder'
    const r = settle(out, endpoint, (reply) => reply.kind === 'no_id')
    switch (r.kind) {
      case 'ok': {
        const reply = r.reply
        if (reply.kind === 'no_id') return reconcile(spec, sent, false)
        if (reply.kind === 'queued') {
          show({ kind: 'queued' })
          return
        }
        // The review showed ANALYZE, but the server took it LIVE: never told as a success.
        if (r.liveSurprise) notifyError()
        else notifySuccess()
        const live = r.liveSurprise ? { liveSurprise: true as const } : {}
        show({ kind: 'ok', triggerId: reply.triggerId, analyze: reply.analyze, ...live })
        return
      }
      case 'maybe':
        return reconcile(spec, sent, r.noReply)
      case 'refused':
        notifyWarning()
        refused(r.message)
        return
      case 'semi_auto_blocked':
        notifyWarning()
        if (alive.current) setStep({ kind: 'edit', semiAuto: r.message })
        else tell(r.message)
        return
      case 'mode_changed':
        if (alive.current) {
          setStep({ kind: 'review', spec, mode: r.now, notice: modeChanged(r.now) })
          // The review's book is the old mode's (the sandbox's, or the live one): its trigger ids
          // say nothing of the new mode's book, so a check after an unknown outcome would take a
          // GTT already in it for this one. Confirm waits for the new mode's book.
          book.read()
        } else tell(`The server is now in ${MODE_LABEL[r.now]} mode. ${NOT_SENT}`)
        return
      case 'cancelled':
        if (alive.current) setStep({ kind: 'review', spec, mode: shownMode, notice: r.message })
        else tell(NOT_SENT)
        return
    }
  }

  /**
   * The whole of confirm runs inside the guard: one at a time, then the cooldown. The session
   * holds the write until its outcome is known, the check after an unknown one included.
   */
  const confirm = (shownMode: AnalyzerMode, reviewed: GttSpec) =>
    void guard.run(async () => {
      // Ruling 26: the LTP may have moved since the review. Planned again with the LTP of now, the
      // GTT must be the one reviewed: a SINGLE the LTP has crossed would go the other way and
      // fire on the next tick (RF 6). Back to edit, which shows any issue and says why.
      const now = validateGtt(ticket, meta, ltp).length === 0 ? planGtt(ticket, meta, ltp) : null
      if (now === null || !sameSpec(now, reviewed)) {
        notifyWarning()
        setStep({ kind: 'edit', error: MOVED })
        return
      }
      const release = holdOrder(trading, me, scope)
      goneLine.current = null
      phase.current = 'sending'
      setStep({ kind: 'sending', spec: reviewed, mode: shownMode })
      try {
        // `send` takes the snapshot just before the request; until then nothing is known.
        const sent: BookSnapshot = { knownIds: new Set(), complete: false }
        const send = (): Promise<GttReply> => {
          Object.assign(sent, book.snapshot())
          return triggerId === undefined
            ? trading.gtt.place(reviewed)
            : trading.gtt.modify(triggerId, reviewed)
        }
        const out = await submitOrderAction({
          kind: modify ? 'gttModify' : 'gttPlace',
          shownMode,
          send,
          gate: trading.analyzer,
          confirmLive: confirmLiveOrder,
          books: s.books,
        })
        await showOutcome(out, reviewed, sent, shownMode)
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
          <GttForm
            ticket={ticket}
            meta={meta}
            ltp={ltp}
            issues={issues}
            fixed={modify}
            error={step.error}
            semiAuto={step.semiAuto}
            canReview={issueCodes.length === 0 && !blocked}
            onChange={(patch) => setTicket((t) => ({ ...t, ...patch }))}
            onReview={openReview}
          />
        )
      case 'review':
      case 'sending':
        return (
          <GttReview
            summary={gttSummary(step.spec, meta)}
            side={ticket.action}
            modify={modify}
            mode={step.mode}
            readError={step.kind === 'review' ? step.readError : undefined}
            onRetryRead={retryRead}
            bookPending={book.pending}
            otherOut={otherOut}
            earlier={earlierLine}
            notice={step.kind === 'review' ? step.notice : undefined}
            sending={step.kind === 'sending'}
            blocked={blocked || guard.busy()}
            onConfirm={() => {
              if (step.mode !== null) confirm(step.mode, step.spec)
            }}
            onBack={() => setStep({ kind: 'edit' })}
          />
        )
      case 'result':
        return (
          <GttResultView
            result={step.result}
            modify={modify}
            onDone={() => router.back()}
            onViewList={() => router.dismissTo(ordersHref({ segment: 'gtt' }) as Href)}
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
