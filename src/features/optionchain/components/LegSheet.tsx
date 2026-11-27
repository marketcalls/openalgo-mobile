// One leg's sheet (design 17.4, ux OC-6): the contract and its live LTP, a lots stepper, BUY (green,
// left) and SELL (red, right), each captioned with the price its ticket opens at, the chart and the
// depth, then the leg's facts and its five Greeks. It follows the leg's own ticks. BUY and SELL
// open the order ticket (its review is where an order is checked and sent).
import { useEffect } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { quoteKey } from '~/core/realtime/protocol'
import { useQuoteFrom } from '~/core/realtime/useQuote'
import { useServices } from '~/core/services/services'
import { type ChainPricing, mergeLeg, priceRow } from '~/market/options/live'
import type { ChainLeg } from '~/market/options/schemas'
import { useBrokerBlocked } from '~/market/session'
import type { Side as OrderSide } from '~/market/types'
import { BottomSheet } from '~/ui/BottomSheet'
import { Button } from '~/ui/Button'
import { fmtOi, fmtPct, fmtPrice, fmtQty, fmtStrike, signOf } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import {
  changePct,
  clampLots,
  expiryLabel,
  GREEK_DP,
  GREEK_LABEL,
  GREEKS,
  greekOf,
  MAX_LOTS,
  MIN_LOTS,
  ticketCaption,
} from '../model'
import { MAX_SCALE, type Side } from './StrikeRow'

const SNAP_POINTS = [0.5, 1] as const

export function LegSheet(p: {
  leg: ChainLeg
  strike: number
  side: Side
  underlying: string
  optionsExchange: string
  expiry: string
  pricing: ChainPricing | null
  feeding: boolean
  lots: number
  onLots(n: number): void
  onTrade(leg: ChainLeg, side: OrderSide): void
  onChart(leg: ChainLeg): void
  onDepth(leg: ChainLeg): void
  onClose(): void
}) {
  const { c } = useTheme()
  const { store, realtime } = useServices()
  const blocked = useBrokerBlocked()
  // The sheet holds its own leg, as the chain does (mode 3, 5 levels): a refresh that drops the
  // strike from the chain's window releases the chain's hold, never the open sheet's prices.
  useEffect(() => {
    if (!p.feeding) return
    return realtime.acquire({
      exchange: p.optionsExchange,
      symbol: p.leg.symbol,
      mode: 3,
      depth: 5,
    })
  }, [p.feeding, p.optionsExchange, p.leg.symbol, realtime])
  const q = useQuoteFrom(store, quoteKey(p.optionsExchange, p.leg.symbol), p.feeding)
  const merged = p.feeding ? mergeLeg(p.leg, q) : p.leg
  const row = {
    strike: p.strike,
    ce: p.side === 'ce' ? merged : null,
    pe: p.side === 'pe' ? merged : null,
  }
  const priced = p.pricing ? priceRow(row, p.pricing) : row
  const leg = (p.side === 'ce' ? priced.ce : priced.pe) ?? merged
  const lot = Math.max(1, leg.lotsize)
  const pct = changePct(leg.ltp, leg.prev_close)
  const sign = signOf(pct)

  const facts: { label: string; value: string | undefined }[] = [
    { label: 'Bid', value: leg.bid > 0 ? fmtPrice(leg.bid) : undefined },
    { label: 'Ask', value: leg.ask > 0 ? fmtPrice(leg.ask) : undefined },
    { label: 'OI', value: fmtOi(leg.oi) },
    { label: 'Volume', value: fmtQty(leg.volume) },
    ...GREEKS.map((g) => {
      const v = greekOf(leg, g)
      return {
        label: GREEK_LABEL[g],
        value: v === undefined ? undefined : fmtPrice(v, GREEK_DP[g]),
      }
    }),
  ]

  return (
    <View style={StyleSheet.absoluteFill}>
      <BottomSheet
        testID="oc-leg-sheet"
        snapPoints={SNAP_POINTS}
        onClose={p.onClose}
        header={
          <View style={styles.head}>
            <Text testID="oc-leg-title" maxFontSizeMultiplier={MAX_SCALE} style={styles.title}>
              {`${p.underlying} ${fmtStrike(p.strike)} ${p.side === 'ce' ? 'CE' : 'PE'}`}
            </Text>
            <Text testID="oc-leg-sub" tone="muted" maxFontSizeMultiplier={MAX_SCALE}>
              {`${expiryLabel(p.expiry, true)} · ${p.optionsExchange} · Lot ${fmtQty(lot)}`}
            </Text>
            <View style={styles.ltpLine}>
              <Text testID="oc-leg-ltp" variant="mono" style={styles.ltp}>
                {leg.ltpMissing ? '--' : fmtPrice(leg.ltp)}
              </Text>
              <Text variant="mono" tone={sign > 0 ? 'profit' : sign < 0 ? 'loss' : 'muted'}>
                {fmtPct(pct)}
              </Text>
            </View>
          </View>
        }
      >
        <View style={styles.body}>
          <View style={styles.stepper}>
            <Step
              testID="oc-leg-lots-dec"
              label="−"
              hint="One lot less"
              disabled={p.lots <= MIN_LOTS}
              onPress={() => p.onLots(clampLots(p.lots - 1))}
            />
            <Text testID="oc-leg-lots" variant="mono" style={styles.lots}>
              {`${p.lots} ${p.lots === 1 ? 'lot' : 'lots'} · ${fmtQty(p.lots * lot)} qty`}
            </Text>
            <Step
              testID="oc-leg-lots-inc"
              label="+"
              hint="One lot more"
              disabled={p.lots >= MAX_LOTS}
              onPress={() => p.onLots(clampLots(p.lots + 1))}
            />
          </View>

          <View testID="oc-leg-trade" style={styles.pair}>
            {(['BUY', 'SELL'] as const).map((side) => (
              <View key={side} style={styles.fill}>
                <Button
                  testID={side === 'BUY' ? 'oc-leg-buy' : 'oc-leg-sell'}
                  title={side}
                  variant={side === 'BUY' ? 'buy' : 'sell'}
                  disabled={blocked}
                  onPress={() => p.onTrade(leg, side)}
                />
                <Text
                  testID={side === 'BUY' ? 'oc-leg-buy-caption' : 'oc-leg-sell-caption'}
                  tone="muted"
                  maxFontSizeMultiplier={MAX_SCALE}
                  style={styles.caption}
                >
                  {ticketCaption(leg, side)}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.links}>
            <Chip testID="oc-leg-chart" label="Chart" onPress={() => p.onChart(leg)} />
            <Chip testID="oc-leg-depth" label="Depth" onPress={() => p.onDepth(leg)} />
          </View>

          <View testID="oc-leg-greeks" style={styles.grid}>
            {facts.map((f) => (
              <View key={f.label} style={[styles.fact, { borderColor: c.border }]}>
                <Text tone="muted" style={styles.factLabel}>
                  {f.label}
                </Text>
                <Text
                  variant="mono"
                  tone={f.value === undefined ? 'muted' : 'default'}
                  maxFontSizeMultiplier={MAX_SCALE}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {f.value ?? '–'}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </BottomSheet>
    </View>
  )
}

function Step(p: {
  testID: string
  label: string
  hint: string
  disabled: boolean
  onPress(): void
}) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      accessibilityLabel={p.hint}
      accessibilityState={{ disabled: p.disabled }}
      disabled={p.disabled}
      onPress={p.onPress}
      style={[styles.step, { borderColor: c.border }, p.disabled && styles.off]}
    >
      <Text style={styles.stepText}>{p.label}</Text>
    </Pressable>
  )
}

function Chip(p: { testID: string; label: string; onPress(): void }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={p.testID}
      accessibilityRole="button"
      onPress={p.onPress}
      style={[styles.chip, { borderColor: c.border }]}
    >
      <Text style={[styles.chipText, { color: c.primary }]}>{p.label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingBottom: 12, gap: 2 },
  title: { fontSize: 18, fontWeight: '700' },
  ltpLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  ltp: { fontSize: 17, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingBottom: 16, gap: 16 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 20, fontWeight: '600' },
  off: { opacity: 0.4 },
  lots: { flex: 1, textAlign: 'center' },
  pair: { flexDirection: 'row', gap: 12 },
  fill: { flex: 1, gap: 4 },
  caption: { fontSize: 12, textAlign: 'center', fontVariant: ['tabular-nums'] },
  links: { flexDirection: 'row', gap: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
  chipText: { fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  fact: { width: '33.33%', paddingVertical: 8, paddingRight: 8, gap: 2 },
  factLabel: { fontSize: 12 },
})
