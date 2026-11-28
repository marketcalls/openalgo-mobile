// A multi-leg basket's review and its outcome (design 7.10, ux-bar BR-1..BR-7): the content of a
// sheet its host provides (a tool page's held basket, Arbitrage's trade sheet). A head with the
// strategy and the one mode badge; the legs as Kite rows, scrolling; a footer pinned below them
// with the net premium, the margin, the legging warning, why confirm waits, and confirm, which
// counts what it sends and stays neutral (a basket mixes sides). Once the basket has gone, the
// same rows each tell their leg's outcome, and the way on is the order book or the Action
// Center: nothing here sends the basket, or a leg of it, again.
import { type Href, useRouter } from 'expo-router'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ApiError, userMessage } from '~/core/http/errors'
import { quoteKey } from '~/core/realtime/protocol'
import { useLiveQuote } from '~/core/realtime/useLive'
import { useServices } from '~/core/services/services'
import { LiveSurpriseNotice } from '~/market/components/LiveSurpriseNotice'
import { ModeBadge } from '~/market/components/ModeBadge'
import { useInstrument } from '~/market/instruments/useInstrument'
import { ordersHref } from '~/market/links'
import { parseOptionSymbol } from '~/market/options/expiry'
import { type BasketLeg, type BasketSpec, LEGGING_RISK, netPremium } from '~/market/orders/basket'
import { CHECKING, NOT_CHECKED, sandboxed } from '~/market/orders/outcome'
import { waitText } from '~/market/orders/result'
import { liveSurpriseText } from '~/market/orders/submit'
import { openServerPage } from '~/market/session'
import { Button } from '~/ui/Button'
import { ErrorState } from '~/ui/ErrorState'
import { fmtPrice, fmtQty } from '~/ui/format'
import { Icon, type IconName } from '~/ui/Icon'
import { Skeleton } from '~/ui/Skeleton'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { type BasketOutcome, useBasketSubmit } from '../hooks/useBasketSubmit'
import { useBasketMargin } from '../hooks/useMarginPreview'
import { canConfirm, earlierOutcome, OTHER_OUT } from './ReviewStep'

/** Dense numeric rows stop growing with the OS font scale here (G9). */
const MAX_SCALE = 1.3
const INFO: IconName = { ios: 'info.circle', android: 'info' }
const READING_BOOK = 'Reading the order book'
const UNKNOWN_LEG = 'A leg is expired or unknown here, so the basket cannot be sent.'
const LOGGED_OUT = userMessage(
  new ApiError({ kind: 'BrokerLoggedOut', status: 0, endpoint: 'app' }),
)
const MONTHS = new Set('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' '))
/** OpenAlgo's future symbol: underlying, DDMMMYY, FUT. */
const FUTURE = /^([A-Z0-9&-]+?)(\d{2})([A-Z]{3})\d{2}FUT$/

/** A contract as a trader reads it: "NIFTY 01 DEC 24500 CE", "NIFTY 01 DEC FUT", else as sent. */
export function legLabel(symbol: string): string {
  const o = parseOptionSymbol(symbol)
  if (o) {
    return `${o.underlying} ${o.expiry.slice(0, 2)} ${o.expiry.slice(2, 5)} ${o.strike} ${o.type}`
  }
  const f = FUTURE.exec(symbol.toUpperCase())
  if (f && MONTHS.has(f[3] ?? '')) return `${f[1]} ${f[2]} ${f[3]} FUT`
  return symbol
}

/** What every leg shares, else "mixed". */
const shared = (legs: readonly BasketLeg[], of: (l: BasketLeg) => string) => {
  const first = legs[0] ? of(legs[0]) : ''
  return legs.every((l) => of(l) === first) ? first : 'mixed'
}

/** A quantity: whole numbers grouped; a crypto leg's fraction kept. */
const qty = (n: number) =>
  Number.isInteger(n) ? fmtQty(n) : n.toLocaleString('en-IN', { maximumFractionDigits: 8 })

/** The leg's price with its type, as the row's second line reads it (MARKET aside). */
function terms(l: BasketLeg): { short: string; spoken: string } {
  switch (l.pricetype) {
    case 'LIMIT':
      return { short: `LMT ${fmtPrice(l.price)}`, spoken: `limit ${fmtPrice(l.price)}` }
    case 'SL':
      return {
        short: `SL ${fmtPrice(l.price)} · trg ${fmtPrice(l.trigger_price)}`,
        spoken: `stop-loss limit ${fmtPrice(l.price)}, trigger ${fmtPrice(l.trigger_price)}`,
      }
    case 'SL-M':
      return {
        short: `SL-M trg ${fmtPrice(l.trigger_price)}`,
        spoken: `stop-loss market, trigger ${fmtPrice(l.trigger_price)}`,
      }
    case 'MARKET':
      return { short: 'MKT', spoken: 'market' }
  }
}

const legsWord = (n: number) => (n === 1 ? 'leg' : 'legs')

/** BR-4: neutral words for the net, whichever way it goes. */
function netLine(net: ReturnType<typeof netPremium>, atMarket: number): string {
  if (net === null) {
    return atMarket > 0
      ? `Net premium at market (${atMarket} ${legsWord(atMarket)} at market)`
      : 'Net premium --'
  }
  if (net.kind === 'flat') return 'Net premium ₹0.00'
  return `Net ${net.kind} ₹${fmtPrice(net.value)}`
}

/** The line above the legs once the basket has gone. */
function resultText(o: BasketOutcome, legs: number): string {
  const total = `${legs} ${legsWord(legs)}`
  switch (o.kind) {
    case 'placed': {
      const n = o.legs.filter((l) => l.state === 'placed').length
      return sandboxed(`${n} of ${total} placed`, o.analyze)
    }
    case 'checking': {
      if (o.found === null) return CHECKING
      if (!o.checked) return NOT_CHECKED
      const n = o.found.filter((r) => r !== null).length
      if (o.earlier && n > 0) {
        return `Found ${n} of ${legs} matching orders in the order book, but they may be earlier ones. Check the order book before trying again.`
      }
      return n < legs
        ? `Found ${n} of ${total} in the order book. The server may still be sending the rest, so check the order book before placing any again.`
        : `Found ${n} of ${total} in the order book.`
    }
    case 'queued':
    case 'refused':
    case 'semi_auto_blocked':
      return o.message
    // the review shows again for these: never a result
    case 'cancelled':
    case 'mode_changed':
      return ''
  }
}

type LegLine = { text: string; tone: 'placed' | 'failed' | 'unclear' }
const UNCLEAR: LegLine = { text: 'Unclear · check the order book', tone: 'unclear' }
const MISSING: LegLine = { text: 'Missing · check the order book', tone: 'unclear' }

/** What came of leg `i`, once the basket has gone. */
function legLine(o: BasketOutcome | null, i: number): LegLine | null {
  if (o?.kind === 'placed') {
    const l = o.legs[i]
    if (!l) return null
    switch (l.state) {
      case 'placed':
        // legs that share a contract get the state, but not whose id is whose
        return { text: l.orderid ? `Placed · #${l.orderid}` : 'Placed', tone: 'placed' }
      case 'failed':
        return { text: l.message ? `Failed · ${l.message}` : 'Failed', tone: 'failed' }
      case 'unclear':
        return UNCLEAR
      case 'missing':
        return MISSING
    }
  }
  if (o?.kind !== 'checking') return null
  if (o.found === null) return UNCLEAR
  const row = o.found[i]
  // a row the review's book could not rule out may be an earlier identical order (ruling 26)
  if (row && !o.earlier) return { text: `Placed · #${row.orderid}`, tone: 'placed' }
  return row || !o.checked ? UNCLEAR : MISSING
}

export function BasketReview(p: {
  spec: BasketSpec
  /** The head's one line: the strategy, or what the host calls the basket. */
  title: string
  /** The host's go-ahead once confirm has passed the guard; false sends nothing. */
  onBegin?: () => boolean
  /** Each outcome, as it lands, whether the review is still shown or not. */
  onOutcome(o: BasketOutcome): void
  /** Back before the send, Done after it. */
  onClose(): void
}): JSX.Element {
  const { spec } = p
  const legs = spec.legs
  const s = useServices()
  const router = useRouter()
  const { c, status } = useTheme()
  const sub = useBasketSubmit({ spec, onBegin: p.onBegin, onOutcome: p.onOutcome })
  const margin = useBasketMargin(legs)
  /** The MARKET legs' LTPs, by quote key, as their rows hear them. */
  const [ltps, setLtps] = useState<ReadonlyMap<string, number>>(() => new Map())
  const onLtp = useCallback((key: string, ltp: number | undefined) => {
    setLtps((m) => {
      if (m.get(key) === ltp) return m
      const next = new Map(m)
      if (ltp === undefined) next.delete(key)
      else next.set(key, ltp)
      return next
    })
  }, [])
  /** The legs this server says are expired or unknown: the basket cannot go with one. */
  const [unknown, setUnknown] = useState<ReadonlySet<number>>(() => new Set())
  const onUnknown = useCallback((i: number, is: boolean) => {
    setUnknown((u) => {
      if (u.has(i) === is) return u
      const next = new Set(u)
      if (is) next.add(i)
      else next.delete(i)
      return next
    })
  }, [])

  const { outcome } = sub
  const atMarket = legs.filter((l) => l.pricetype === 'MARKET').length
  const net = netPremium(spec, (key) => ltps.get(key))
  const ready =
    !sub.sending &&
    unknown.size === 0 &&
    canConfirm({
      mode: sub.mode,
      bookPending: sub.bookPending,
      otherOut: sub.otherOut,
      blocked: sub.brokerOut || sub.busy,
    })

  const viewOrders = (primary: boolean) => (
    <Button
      key="orders"
      testID="basket-view-orders"
      title="View in order book"
      variant={primary ? 'primary' : 'secondary'}
      onPress={() => {
        p.onClose()
        router.dismissTo(ordersHref({ segment: 'all' }) as Href)
      }}
    />
  )
  const done = (primary: boolean) => (
    <Button
      key="done"
      testID="basket-done"
      title="Done"
      variant={primary ? 'primary' : 'secondary'}
      onPress={p.onClose}
    />
  )
  const actionCenter = (
    <Button
      key="action-center"
      testID="basket-action-center"
      title="Open Action Center"
      onPress={() => openServerPage(s.profile.get().restOrigin, '/action-center')}
    />
  )

  /** Once the basket has gone: the way on, first; never a way to send it again. */
  const after = (o: BasketOutcome) => {
    switch (o.kind) {
      case 'placed':
        return o.legs.every((l) => l.state === 'placed')
          ? [done(true), viewOrders(false)]
          : [viewOrders(true), done(false)]
      case 'checking':
        return [viewOrders(true), done(false)]
      case 'queued':
      case 'semi_auto_blocked':
        return [actionCenter, done(false)]
      default:
        return [done(true)]
    }
  }

  /** Why confirm waits, when it does (BR-3). */
  const reason = () => {
    if (sub.sending || ready) return null
    if (sub.readError !== undefined) {
      return <ErrorState error={sub.readError} onRetry={sub.retryRead} />
    }
    if (sub.mode === null) return <Skeleton rows={1} />
    const why = sub.bookPending
      ? READING_BOOK
      : sub.otherOut
        ? OTHER_OUT
        : sub.brokerOut
          ? LOGGED_OUT
          : unknown.size > 0
            ? UNKNOWN_LEG
            : null
    return why === null ? null : (
      <Text testID="basket-reason" tone="muted">
        {why}
      </Text>
    )
  }

  const leggingColor = sub.mode === 'live' ? status.onWarning : c.mutedForeground
  return (
    <View testID="basket-review" style={styles.fill}>
      {outcome?.kind === 'placed' && outcome.liveSurprise ? (
        <View style={styles.gutter}>
          <LiveSurpriseNotice text={liveSurpriseText('basket')} />
        </View>
      ) : null}
      <View testID="basket-head" style={[styles.head, styles.gutter]}>
        <View style={styles.titleRow}>
          <Text testID="basket-title" variant="heading" numberOfLines={1} style={styles.title}>
            {p.title}
          </Text>
          {sub.mode ? <ModeBadge mode={sub.mode} testID="basket-mode-badge" /> : null}
        </View>
        <Text testID="basket-meta" tone="muted" numberOfLines={1}>
          {[
            shared(legs, (l) => l.exchange),
            shared(legs, (l) => l.product),
            shared(legs, (l) => l.pricetype),
          ].join(' · ')}
        </Text>
      </View>
      {outcome ? (
        <View style={[styles.result, styles.gutter]}>
          <Text testID="basket-result-text" style={styles.resultText}>
            {resultText(outcome, legs.length)}
          </Text>
          {outcome.kind === 'checking' && outcome.found === null && outcome.waitSec ? (
            <Text testID="basket-wait" variant="caption" tone="muted">
              {waitText(outcome.waitSec)}
            </Text>
          ) : null}
        </View>
      ) : null}
      <ScrollView testID="basket-legs" style={styles.fill} contentContainerStyle={styles.gutter}>
        {legs.map((leg, i) => (
          <LegRow
            // a basket's legs never reorder
            // biome-ignore lint/suspicious/noArrayIndexKey: the leg's place is its identity
            key={i}
            leg={leg}
            n={i + 1}
            line={legLine(outcome, i)}
            onLtp={onLtp}
            onUnknown={onUnknown}
          />
        ))}
      </ScrollView>
      <View
        testID="basket-footer"
        style={[styles.footer, styles.gutter, { borderColor: c.border }]}
      >
        {outcome ? (
          after(outcome)
        ) : (
          <>
            <Text testID="basket-net" variant="mono" maxFontSizeMultiplier={MAX_SCALE}>
              {netLine(net, atMarket)}
            </Text>
            {margin !== null ? (
              <Text
                testID="basket-margin"
                variant="mono"
                tone="muted"
                maxFontSizeMultiplier={MAX_SCALE}
              >
                {`Margin ≈ ₹${fmtPrice(margin)}`}
              </Text>
            ) : null}
            {legs.length >= 2 ? (
              <View testID="basket-legging" style={styles.legging}>
                <Icon name={INFO} size={14} color={leggingColor} />
                <Text variant="caption" style={[styles.leggingText, { color: leggingColor }]}>
                  {LEGGING_RISK}
                </Text>
              </View>
            ) : null}
            {sub.notice ? (
              <Text testID="basket-notice" tone="loss">
                {sub.notice}
              </Text>
            ) : null}
            {sub.earlier !== null ? (
              <Text testID="basket-earlier">{earlierOutcome(sub.earlier)}</Text>
            ) : null}
            {reason()}
            <Button
              testID="basket-confirm"
              title={
                sub.sending
                  ? 'Placing…'
                  : `Place ${legs.length} ${legs.length === 1 ? 'order' : 'orders'}`
              }
              variant="primary"
              disabled={!ready}
              onPress={sub.confirm}
            />
            <Button
              testID="basket-back"
              title="Back"
              variant="secondary"
              disabled={sub.sending}
              onPress={p.onClose}
            />
          </>
        )}
      </View>
    </View>
  )
}

/** One leg as Kite lists it (BR-2), and what came of it once the basket has gone (BR-6). */
function LegRow(p: {
  leg: BasketLeg
  /** Its place in the basket, from 1. */
  n: number
  line: LegLine | null
  onLtp(key: string, ltp: number | undefined): void
  onUnknown(i: number, unknown: boolean): void
}) {
  const { leg, n, onUnknown } = p
  const { c, trade, status } = useTheme()
  const inst = useInstrument(leg.exchange, leg.symbol)
  useEffect(() => onUnknown(n - 1, inst.unknown), [onUnknown, n, inst.unknown])
  const [open, setOpen] = useState(false)
  const lotsize = inst.meta?.lots ? inst.meta.lotsize : 0
  const lots = lotsize > 0 ? leg.quantity / lotsize : Number.NaN
  const quantity =
    Number.isInteger(lots) && lots > 0
      ? `${qty(leg.quantity)} · ${fmtQty(lots)} ${lots === 1 ? 'lot' : 'lots'}`
      : qty(leg.quantity)
  const label = legLabel(leg.symbol)
  const t = terms(leg)
  const side = leg.action === 'BUY' ? 'Buy' : 'Sell'
  const line = p.line
  const lineColor =
    line?.tone === 'failed'
      ? c.destructive
      : line?.tone === 'unclear'
        ? status.onWarning
        : c.foreground
  return (
    <View testID={`basket-leg-${n}`} style={[styles.legWrap, { borderColor: c.border }]}>
      <View
        accessible
        accessibilityLabel={`${side} ${qty(leg.quantity)} ${label}, ${t.spoken}`}
        style={styles.leg}
      >
        <View style={styles.contract}>
          <View style={styles.contractLine}>
            <Text
              testID={`basket-leg-side-${n}`}
              maxFontSizeMultiplier={MAX_SCALE}
              style={[styles.side, { color: leg.action === 'BUY' ? trade.buy : trade.sell }]}
            >
              {leg.action}
            </Text>
            <Text
              variant="mono"
              numberOfLines={1}
              maxFontSizeMultiplier={MAX_SCALE}
              style={styles.symbol}
            >
              {label}
            </Text>
          </View>
          <Text tone="muted" maxFontSizeMultiplier={MAX_SCALE} style={styles.sub}>
            {inst.unknown ? `${leg.exchange} · Expired or unknown` : leg.exchange}
          </Text>
        </View>
        <View style={styles.terms}>
          <Text variant="mono" maxFontSizeMultiplier={MAX_SCALE}>
            {quantity}
          </Text>
          {leg.pricetype === 'MARKET' ? (
            <MarketPrice leg={leg} onLtp={p.onLtp} />
          ) : (
            <Text variant="mono" maxFontSizeMultiplier={MAX_SCALE}>
              {t.short}
            </Text>
          )}
        </View>
      </View>
      {line ? (
        <Pressable
          disabled={line.tone !== 'failed'}
          accessibilityRole={line.tone === 'failed' ? 'button' : undefined}
          accessibilityHint={line.tone === 'failed' ? 'Shows the whole message' : undefined}
          onPress={() => setOpen((v) => !v)}
        >
          <Text
            testID={`basket-result-leg-${n}`}
            variant={line.tone === 'placed' ? 'mono' : 'body'}
            numberOfLines={line.tone === 'failed' && !open ? 3 : undefined}
            maxFontSizeMultiplier={MAX_SCALE}
            style={{ color: lineColor }}
          >
            {line.text}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** A MARKET leg's price: its LTP while the review shows, which the net premium takes too. */
function MarketPrice({
  leg,
  onLtp,
}: {
  leg: BasketLeg
  onLtp(key: string, ltp: number | undefined): void
}) {
  const ltp = useLiveQuote(leg.exchange, leg.symbol, 1)?.ltp
  const key = quoteKey(leg.exchange, leg.symbol)
  useEffect(() => onLtp(key, ltp), [onLtp, key, ltp])
  return (
    <Text variant="mono" maxFontSizeMultiplier={MAX_SCALE}>
      {ltp !== undefined && ltp > 0 ? `MKT ≈ ${fmtPrice(ltp)}` : 'MKT'}
    </Text>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  gutter: { paddingHorizontal: 16 },
  head: { gap: 2, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, minWidth: 0 },
  result: { gap: 4, paddingBottom: 8 },
  resultText: { fontWeight: '600' },
  legWrap: { paddingVertical: 8, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  leg: { flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 12 },
  contract: { flex: 1, minWidth: 0, gap: 2 },
  contractLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  side: { fontSize: 12, fontWeight: '700' },
  symbol: { flexShrink: 1 },
  sub: { fontSize: 12 },
  terms: { alignItems: 'flex-end', gap: 2 },
  footer: { gap: 8, paddingTop: 12, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth },
  legging: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  leggingText: { flexShrink: 1 },
})
