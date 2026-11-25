// The modify sheet (design 7.10), a form sheet over the Orders tab: a working order's quantity
// (lots on a derivative), type, price and trigger, checked with the ticket's rules (one order, so no
// split). It reads the server's mode on opening and shows it, LIVE or ANALYZE; modify sends
// modifyorder once with the row's other fields as they are (C3), never retried. An outcome that
// may hide the change is checked against the order book, never sent again.
//
// The sheet is held while the change is on its way (T12's hold), and the session holds the order
// until the change's outcome is known, the check included (Global 4): another sheet for the same
// order, or the tab's Modify and Cancel on it, wait meanwhile. An outcome that reached only the
// toast, because its sheet had gone, is shown by the next sheet for that order before it sends.
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { notifySuccess, notifyWarning } from '~/core/platform/haptics'
import { qk } from '~/core/query/keys'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { isWorking, type OrderRow } from '~/market/books/schemas'
import { BrokerBanner, SemiAutoBlockedBanner } from '~/market/components/SessionBanners'
import type { InstrumentMeta } from '~/market/instruments/meta'
import { fmtTick, snapTick } from '~/market/instruments/tick'
import { useInstrument, useIsUnknown } from '~/market/instruments/useInstrument'
import type { AnalyzerMode } from '~/market/orders/analyzerGate'
import { confirmLiveOrder } from '~/market/orders/confirmLive'
import { MODE_LABEL } from '~/market/orders/confirmWrite'
import { useSubmitGuard } from '~/market/orders/guard'
import {
  holdOrder,
  onOrder,
  otherOrderOut,
  takeUnseenOutcome,
  useOtherOrderOut,
  useUnseenOutcome,
} from '~/market/orders/pending'
import type { ModifyChange } from '~/market/orders/schemas'
import { readMode, submitOrderAction } from '~/market/orders/submit'
import { issueText, planOrder, type TicketState, validateTicket } from '~/market/orders/ticket'
import { useHoldSheet } from '~/market/orders/useHoldSheet'
import { useBrokerBlocked } from '~/market/session'
import { useTrading } from '~/market/trading'
import { PRICE_TYPES, type PriceType, type Product } from '~/market/types'
import { useToneColors } from '~/ui/Badge'
import { Banner } from '~/ui/Banner'
import { Button } from '~/ui/Button'
import { EmptyState } from '~/ui/EmptyState'
import { ErrorState } from '~/ui/ErrorState'
import { fmtQty } from '~/ui/format'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { toast } from '~/ui/Toast'
import { useTheme } from '~/ui/theme'
import {
  CHECKING,
  checkOrder,
  earlierChange,
  MODIFIED,
  modeChanged,
  NOT_READ,
  ORDER_OUT,
  settle,
  useFreshBook,
} from '../hooks/useOrderWrites'

const GONE = 'This order is no longer open.'

/** Modify changes one order; above the freeze limit the ticket's rules refuse it. */
const NO_SPLIT = { splitAvailable: false }

const NO_TYPE = 'Choose an order type.'

/** A dismissal refused while the change is on its way. */
export const MODIFY_HOLD = 'The change is being sent. Wait for its outcome.'
/** The sheet went while the change was on its way (an Android sheet can always be swiped away). */
export const MODIFY_STILL_SENDING = 'The change is still being sent. Its outcome will show here.'

export function ModifySheet({ orderid }: { orderid: string }) {
  return (
    <View style={styles.fill} testID="modify-screen">
      <BrokerBanner />
      <OpenOrder orderid={orderid} />
    </View>
  )
}

/**
 * The row from the orderbook cache, read once when the cache lacks it. While another write on
 * this order is out (a sheet that went, or the tab's cancel), the sheet waits for its outcome.
 * Once that is known, or when the sheet opens on an earlier write's outcome only a toast said,
 * the row is read afresh before the form shows: a modify sets absolute values, so a form from
 * before that write would undo it.
 */
function OpenOrder({ orderid }: { orderid: string }) {
  const s = useServices()
  const trading = useTrading()
  const blocked = useBrokerBlocked()
  const readBook = useFreshBook()
  const scope = onOrder(orderid)
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me, scope)
  const unseen = useUnseenOutcome(trading, scope)
  const [earlier, setEarlier] = useState<string | null>(null)
  /** The row is to be read afresh (`wanted`), or that read failed. */
  const [renew, setRenew] = useState<'no' | 'wanted' | { error: unknown }>('no')
  useEffect(() => {
    if (otherOut) setRenew('wanted')
  }, [otherOut])
  // On iOS the toast that carried it is beneath this sheet, so the sheet says it.
  useEffect(() => {
    if (unseen === null) return
    const line = takeUnseenOutcome(trading, scope)
    if (line === null) return
    setEarlier(line)
    setRenew('wanted')
  }, [unseen, trading, scope])

  const q = useQuery({
    queryKey: qk.orderbook(s.profile.get().id),
    queryFn: () => trading.orders.orderbook(),
    enabled: false,
  })
  const cached = q.data?.orders.find((r) => r.orderid === orderid)
  // The row the sheet opened on: a later read neither resets the form nor ends a check. A fresh
  // read after an earlier write replaces it ('gone' when that read lacks it).
  const [held, setHeld] = useState<{ row: OrderRow | 'gone'; read: number } | null>(null)
  const row = held ? held.row : cached
  useEffect(() => {
    if (held === null && cached) setHeld({ row: cached, read: 0 })
  }, [held, cached])
  const [asked, setAsked] = useState(false)
  const { refetch } = q
  const waiting = otherOut || renew !== 'no'
  useEffect(() => {
    if (row || blocked || asked || waiting) return
    setAsked(true)
    void refetch()
  }, [row, blocked, asked, waiting, refetch])
  useEffect(() => {
    if (renew !== 'wanted' || otherOut || unseen !== null || blocked) return
    let live = true
    readBook().then(
      (b) => {
        if (!live) return
        const now = b.orders.find((r) => r.orderid === orderid)
        setHeld((h) => ({ row: now ?? 'gone', read: (h?.read ?? 0) + 1 }))
        setRenew('no')
      },
      (error: unknown) => {
        if (live) setRenew({ error })
      },
    )
    return () => {
      live = false
    }
  }, [renew, otherOut, unseen, blocked, readBook, orderid])

  const body = () => {
    if (otherOut) {
      return (
        <View style={styles.body}>
          <Text testID="modify-wait" tone="muted">
            {ORDER_OUT}
          </Text>
          <Skeleton rows={1} />
        </View>
      )
    }
    if (typeof renew === 'object') {
      return <ErrorState error={renew.error} onRetry={() => setRenew('wanted')} />
    }
    if (renew === 'wanted') return blocked ? <EmptyState title={NOT_READ} /> : <Skeleton />
    if (row === 'gone') return <EmptyState title={GONE} />
    if (row) {
      // a fresh read starts the form again from that row
      return isWorking(row) ? (
        <Instrument key={held?.read ?? 0} row={row} me={me} />
      ) : (
        <EmptyState title={GONE} />
      )
    }
    if (!asked) return blocked ? <EmptyState title={NOT_READ} /> : <Skeleton />
    if (q.isFetching) return <Skeleton />
    if (q.isError) return <ErrorState error={q.error} onRetry={() => void refetch()} />
    return <EmptyState title={GONE} />
  }

  return (
    <>
      {earlier !== null ? (
        <Banner testID="modify-earlier" tone="neutral" text={earlierChange(earlier)} />
      ) : null}
      {body()}
    </>
  )
}

/** The contract's metadata decides the rest: unknown shows only that, and takes no feed slot. */
function Instrument({ row, me }: { row: OrderRow; me: object }) {
  const s = useServices()
  const refused = useIsUnknown(row.exchange, row.symbol)
  const inst = useInstrument(row.exchange, row.symbol)
  if (refused || inst.unknown) {
    const ticket = ticketOf(row, { pricetype: 'MARKET', qty: 1 })
    return (
      <View style={styles.body}>
        <Title row={row} />
        <Text testID="modify-refused">
          {issueText('unknown_instrument', { ticket, meta: 'unknown' })}
        </Text>
      </View>
    )
  }
  if (inst.meta) return <ModifyForm row={row} meta={inst.meta} me={me} />
  if (inst.loading) return <Skeleton />
  const queryKey = qk.symbol(s.profile.get().id, row.exchange, row.symbol)
  return (
    <ErrorState
      error={s.queryClient.getQueryState(queryKey)?.error}
      onRetry={() => void s.queryClient.refetchQueries({ queryKey })}
    />
  )
}

/** What the user can change; null `pricetype` when the row's could not be read. */
type Form = { pricetype: PriceType | null; qty: number; price?: number; trigger?: number }

const positive = (n: number | undefined): n is number => n !== undefined && n > 0

/** The row as the form shows it: lots on a derivative, and only the prices it carries. */
function initialForm(row: OrderRow, meta: InstrumentMeta): Form {
  const pt = row.pricetype.trim().toUpperCase()
  return {
    pricetype: PRICE_TYPES.find((t) => t === pt) ?? null,
    qty: meta.lots ? row.quantity / meta.lotsize : row.quantity,
    price: positive(row.price) ? row.price : undefined,
    trigger: positive(row.trigger_price) ? row.trigger_price : undefined,
  }
}

/**
 * The order the ticket's rules check. The side and product stay the row's; a product the
 * segment does not offer is reported by `validateTicket`, so it is never sent unchecked.
 */
function ticketOf(row: OrderRow, f: Form & { pricetype: PriceType }): TicketState {
  return {
    exchange: row.exchange,
    symbol: row.symbol,
    action: row.action,
    product: row.product as Product,
    pricetype: f.pricetype,
    qty: f.qty,
    price: f.price,
    trigger: f.trigger,
  }
}

const withType = (f: Form): (Form & { pricetype: PriceType }) | null =>
  f.pricetype === null ? null : { ...f, pricetype: f.pricetype }

type Step =
  | { kind: 'edit'; error?: string; notice?: string; semiAuto?: string }
  | { kind: 'sending' }
  /** After an unknown outcome: `line` once the book says, null while it is read. */
  | { kind: 'check'; line: string | null }
  /** Modified: the sheet closes once it is no longer held. */
  | { kind: 'closing' }

/** `me` is this sheet, as the session's writes still out know it. */
function ModifyForm({ row, meta, me }: { row: OrderRow; meta: InstrumentMeta; me: object }) {
  const s = useServices()
  const trading = useTrading()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const blocked = useBrokerBlocked()
  const guard = useSubmitGuard()
  const readBook = useFreshBook()
  const ltp = useLiveQuote(row.exchange, row.symbol, 1)?.ltp
  const [form, setForm] = useState(() => initialForm(row, meta))
  const [step, setStep] = useState<Step>({ kind: 'edit' })
  const [mode, setMode] = useState<{ now: AnalyzerMode | null; error?: unknown }>({ now: null })
  /** This sheet's change is held on the order for the session until its outcome is known. */
  const scope = onOrder(row.orderid)
  /** Where this sheet's change is: on its way, or being checked after an unknown outcome. */
  const phase = useRef<'idle' | 'sending' | 'checking'>('idle')
  /** The last outcome line this sheet's change sent to the toast, once the sheet had gone. */
  const goneLine = useRef<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (phase.current === 'sending') toast(MODIFY_STILL_SENDING)
    }
  }, [])
  useHoldSheet(step.kind === 'sending', MODIFY_HOLD)
  // Closing waits for the render that lifts the hold, on iOS a held sheet refuses the pop, and
  // then a task more: expo-router keeps the hold in a provider's state, set in a layout effect.
  useEffect(() => {
    if (step.kind !== 'closing') return
    const t = setTimeout(() => router.back(), 0)
    return () => clearTimeout(t)
  }, [step.kind, router])

  /** Each mode read; one an earlier read started is dropped. */
  const reads = useRef(0)
  const read = useCallback(() => {
    const seq = ++reads.current
    const current = () => alive.current && reads.current === seq
    setMode({ now: null })
    readMode(trading.analyzer).then(
      (now) => current() && setMode({ now }),
      (error: unknown) => current() && setMode({ now: null, error }),
    )
  }, [trading])
  useEffect(() => read(), [read])

  const typed = withType(form)
  const ticket = typed ? ticketOf(row, typed) : null
  const issues = ticket
    ? validateTicket(ticket, meta, ltp, NO_SPLIT).map((issue) => ({
        id: issue as string,
        text: issueText(issue, { ticket, meta, ltp }),
      }))
    : [{ id: 'type', text: NO_TYPE }]

  /**
   * On the sheet, or as a toast once the sheet has gone (an Android sheet can be swiped away);
   * the session then keeps the line for the next sheet on this order, since on iOS a presented
   * sheet hides that toast.
   */
  const show = (next: Step, line?: string) => {
    if (alive.current) setStep(next)
    else if (line) {
      goneLine.current = line
      toast(line)
    }
  }

  /**
   * The whole of confirm runs inside the guard: one at a time, then the cooldown. The session
   * holds the order until the change's outcome is known, the check after an unknown one
   * included, so no other sheet or the tab sends on it meanwhile, even once this sheet has gone.
   */
  const confirm = (shownMode: AnalyzerMode) =>
    void guard.run(async () => {
      // The button is disabled while the rules refuse the order, and the form gives way to the wait
      // while another write on it is out; this keeps one from ever going.
      if (!ticket || validateTicket(ticket, meta, ltp, NO_SPLIT).length > 0) return
      if (otherOrderOut(trading, me, scope)) return
      const { spec } = planOrder(ticket, meta)
      const change: ModifyChange = {
        quantity: spec.quantity,
        pricetype: spec.pricetype,
        price: spec.price,
        trigger_price: spec.trigger_price,
      }
      const release = holdOrder(trading, me, scope)
      goneLine.current = null
      phase.current = 'sending'
      setStep({ kind: 'sending' })
      try {
        const out = await submitOrderAction({
          kind: 'modify',
          shownMode,
          send: () => trading.orders.modify(row, change),
          gate: trading.analyzer,
          confirmLive: confirmLiveOrder,
          books: s.books,
        })
        const r = settle(out, 'modifyorder', (reply) => reply.kind === 'no_id')
        switch (r.kind) {
          case 'ok':
            notifySuccess()
            toast(MODIFIED)
            if (alive.current) setStep({ kind: 'closing' })
            else goneLine.current = MODIFIED
            return
          case 'maybe': {
            phase.current = 'checking'
            notifyWarning()
            show({ kind: 'check', line: null }, CHECKING)
            const line = await checkOrder(readBook, row.orderid)
            show({ kind: 'check', line }, line)
            return
          }
          case 'refused':
            notifyWarning()
            show({ kind: 'edit', error: r.message }, r.message)
            return
          case 'semi_auto_blocked':
            notifyWarning()
            show({ kind: 'edit', semiAuto: r.message }, r.message)
            return
          case 'mode_changed':
            if (alive.current) setMode({ now: r.now })
            show({ kind: 'edit', notice: modeChanged(r.now) }, modeChanged(r.now))
            return
          case 'cancelled':
            show({ kind: 'edit', notice: r.message }, r.message)
            return
        }
      } finally {
        phase.current = 'idle'
        // An outcome only the toast carried goes to the next sheet for this order.
        release(goneLine.current)
      }
    })

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const edit = step.kind === 'edit' ? step : null

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.body, { paddingBottom: 16 + insets.bottom }]}
    >
      <Title row={row} />
      <View style={styles.modeRow}>
        <Text variant="heading">Modify order</Text>
        {mode.now ? <ModeBadge mode={mode.now} /> : null}
      </View>
      {mode.error !== undefined ? (
        <ErrorState error={mode.error} onRetry={read} />
      ) : mode.now === null ? (
        <Skeleton rows={1} />
      ) : null}
      {step.kind === 'closing' ? (
        <Text testID="modify-closing">{MODIFIED}</Text>
      ) : step.kind === 'check' ? (
        <View style={styles.form}>
          <Text testID="modify-check">{step.line ?? CHECKING}</Text>
          {step.line === null ? <Skeleton rows={1} /> : null}
          <Button testID="modify-done" title="Done" onPress={() => router.back()} />
        </View>
      ) : (
        <View style={styles.form}>
          <Fields form={form} meta={meta} ltp={ltp} onChange={set} />
          {issues.map(({ id, text }) => (
            <Text key={id} testID={`modify-issue-${id}`} tone="loss">
              {text}
            </Text>
          ))}
          {edit?.notice ? (
            <Text testID="modify-notice" tone="loss">
              {edit.notice}
            </Text>
          ) : null}
          {edit?.error ? (
            <Text testID="modify-error" tone="loss">
              {edit.error}
            </Text>
          ) : null}
          {edit?.semiAuto ? <SemiAutoBlockedBanner message={edit.semiAuto} /> : null}
          <Button
            testID="modify-confirm"
            title="Modify order"
            loading={step.kind === 'sending'}
            disabled={issues.length > 0 || mode.now === null || blocked || guard.busy()}
            onPress={() => {
              if (mode.now !== null) confirm(mode.now)
            }}
          />
        </View>
      )}
    </ScrollView>
  )
}

function Title({ row }: { row: OrderRow }) {
  const { trade } = useTheme()
  return (
    <View style={styles.title}>
      <Text variant="heading" numberOfLines={1}>
        {row.symbol}
      </Text>
      <View style={styles.line}>
        <Text
          variant="caption"
          style={[styles.side, { color: row.action === 'BUY' ? trade.buy : trade.sell }]}
        >
          {row.action}
        </Text>
        <Text variant="caption" tone="muted">
          {`${row.exchange} · ${row.product || '--'} · ${row.orderid}`}
        </Text>
      </View>
    </View>
  )
}

/** LIVE in the danger colours, ANALYZE in the analyzer's; the id is on the label, as on review. */
function ModeBadge({ mode }: { mode: AnalyzerMode }) {
  const { bg, fg } = useToneColors(mode === 'live' ? 'danger' : 'analyze')
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text testID="modify-mode-badge" variant="caption" style={[styles.badgeLabel, { color: fg }]}>
        {MODE_LABEL[mode]}
      </Text>
    </View>
  )
}

/** On the tick, with the price itself as the guard's reference, as the ticket rules send it. */
const snapped = (n: number | undefined, meta: InstrumentMeta) =>
  n === undefined ? undefined : snapTick(n, meta.tick, n)

/** A number, or nothing while the field is blank or not a number. */
const numberOf = (s: string): number | undefined => {
  const t = s.replace(/,/g, '').trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

const fieldText = (n: number | undefined) =>
  n === undefined || !Number.isFinite(n) ? '' : String(n)

function Fields(p: {
  form: Form
  meta: InstrumentMeta
  ltp: number | undefined
  onChange: (patch: Partial<Form>) => void
}) {
  const { form: f, meta } = p
  const [qty, setQty] = useState(() => fieldText(f.qty))
  const [price, setPrice] = useState(() => fieldText(f.price))
  const [trigger, setTrigger] = useState(() => fieldText(f.trigger))
  const pt = f.pricetype
  const lotsValid = Number.isInteger(f.qty) && f.qty >= 1

  const onBlur = (field: 'price' | 'trigger', setText: (s: string) => void) => () => {
    const n = snapped(f[field], meta)
    setText(fieldText(n))
    p.onChange({ [field]: n })
  }

  return (
    <>
      <Field label="Type">
        <TypeSegments value={pt} onChange={(pricetype) => p.onChange({ pricetype })} />
      </Field>
      <Field label={meta.lots ? 'Lots' : 'Quantity'}>
        <Input
          testID="modify-qty"
          value={qty}
          keyboardType="number-pad"
          onChangeText={(s) => {
            setQty(s)
            // blank is NaN, which the ticket rules refuse
            p.onChange({ qty: numberOf(s) ?? Number.NaN })
          }}
        />
        {meta.lots && lotsValid ? (
          <Text variant="caption" tone="muted" testID="modify-qty-units">
            {`${fmtQty(f.qty)} × ${fmtQty(meta.lotsize)} = ${fmtQty(f.qty * meta.lotsize)}`}
          </Text>
        ) : null}
      </Field>
      {pt === 'LIMIT' || pt === 'SL' ? (
        <Field label="Price">
          <Input
            testID="modify-price"
            value={price}
            keyboardType="decimal-pad"
            onChangeText={(s) => {
              setPrice(s)
              p.onChange({ price: numberOf(s) })
            }}
            onBlur={onBlur('price', setPrice)}
          />
        </Field>
      ) : null}
      {pt === 'SL' || pt === 'SL-M' ? (
        <Field label="Trigger price">
          <Input
            testID="modify-trigger"
            value={trigger}
            keyboardType="decimal-pad"
            onChangeText={(s) => {
              setTrigger(s)
              p.onChange({ trigger: numberOf(s) })
            }}
            onBlur={onBlur('trigger', setTrigger)}
          />
        </Field>
      ) : null}
      <Text variant="mono" tone="muted" testID="modify-ltp">
        {`LTP ${p.ltp === undefined ? '--' : fmtTick(p.ltp, meta.tick, p.ltp)}`}
      </Text>
    </>
  )
}

function TypeSegments(p: { value: PriceType | null; onChange: (t: PriceType) => void }) {
  const { c } = useTheme()
  return (
    <View style={[styles.segments, { borderColor: c.border }]}>
      {PRICE_TYPES.map((t) => {
        const on = p.value === t
        return (
          <Pressable
            key={t}
            testID={`modify-type-${t}`}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => p.onChange(t)}
            style={[styles.segment, { backgroundColor: on ? c.primary : 'transparent' }]}
          >
            <Text
              style={{
                color: on ? c.primaryForeground : c.foreground,
                fontWeight: on ? '700' : '400',
              }}
            >
              {t}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </View>
  )
}

function Input(p: React.ComponentProps<typeof TextInput>) {
  const { c } = useTheme()
  return (
    <TextInput
      {...p}
      selectTextOnFocus
      placeholderTextColor={c.mutedForeground}
      style={[styles.input, { color: c.foreground, borderColor: c.border }]}
    />
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 16 },
  title: { gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  side: { fontWeight: '700' },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeLabel: { fontWeight: '700' },
  form: { gap: 14 },
  field: { gap: 6 },
  segments: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
})
