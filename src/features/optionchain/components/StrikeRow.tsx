// One strike of the ladder (design 17.4, ux OC-2/3/5/8): the call on the left, the strike in the
// middle, the put on the right, mirrored, each side in two cells that fit 360 dp. Price view: OI
// outside over its neutral bar, the LTP over its change inside. Greeks view: the two Greeks picked,
// the first outside. A row reads only its own legs' ticks, so a tick re-renders this row alone; it
// prices them at the chain's shared forward and years. The strike nearest the live spot carries the
// ATM band; the money is tinted amber, never green or red.
import { memo, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { quoteKey } from '~/core/realtime/protocol'
import { useQuoteFrom } from '~/core/realtime/useQuote'
import { useServices } from '~/core/services/services'
import { type ChainPricing, mergeLeg, priceRow } from '~/market/options/live'
import type { ChainLeg } from '~/market/options/schemas'
import { fmtOi, fmtPct, fmtPrice, fmtStrike, signOf } from '~/ui/format'
import { Text } from '~/ui/Text'
import { useTheme } from '~/ui/theme'
import { tokens } from '~/ui/tokens'
import {
  type ChainView,
  changePct,
  GREEK_DP,
  type GreekPair,
  greekOf,
  type LadderRow,
  legLabel,
  strikeId,
} from '../model'

/** The strike column (ux OC-2); each side takes half of the rest. */
export const STRIKE_WIDTH = 76
/** A row at the font scale, capped as its text is (ux G9). */
export const MAX_SCALE = 1.3
export const rowHeight = (fontScale: number) => Math.round(52 * Math.min(fontScale, MAX_SCALE))
export const SPOT_HEIGHT = 24
/** ux OC-8. */
export const FLASH_MS = 400

/** `#rrggbb` at `a` opacity. */
export const tint = (hex: string, a: number) =>
  `${hex.slice(0, 7)}${Math.round(a * 255)
    .toString(16)
    .padStart(2, '0')}`

/** ux OC-3: amber, the warning token's hue (the dark token is a badge fill, too dark to tint). */
const AMBER = tokens.status.light.warning

export type Side = 'ce' | 'pe'

/** Each side's testIDs, spelt out so e2e/README.md's templates find them in src (e2e-ids test). */
const IDS = {
  ce: { cell: 'oc-ce-', atm: 'oc-ce-ATM', ltp: 'oc-ce-ltp-', oi: 'oc-ce-oi-', bar: 'oc-oibar-ce-' },
  pe: { cell: 'oc-pe-', atm: 'oc-pe-ATM', ltp: 'oc-pe-ltp-', oi: 'oc-pe-oi-', bar: 'oc-oibar-pe-' },
} as const

export type StrikeRowProps = {
  item: LadderRow
  underlying: string
  optionsExchange: string
  view: ChainView
  greeks: GreekPair
  pricing: ChainPricing | null
  /** The feed is live and the screen active: ticks merge in. */
  feeding: boolean
  /** The feed is late: LTPs dim (ux OC-7). */
  stale: boolean
  maxOi: { ce: number; pe: number }
  height: number
  reduceMotion: boolean
  onLeg(strike: number, side: Side): void
}

export const StrikeRow = memo(function StrikeRow(p: StrikeRowProps) {
  const { store } = useServices()
  const { c } = useTheme()
  const { row } = p.item
  const ceQ = useQuoteFrom(
    store,
    row.ce ? quoteKey(p.optionsExchange, row.ce.symbol) : '',
    p.feeding,
  )
  const peQ = useQuoteFrom(
    store,
    row.pe ? quoteKey(p.optionsExchange, row.pe.symbol) : '',
    p.feeding,
  )
  const merged = p.feeding
    ? { ...row, ce: row.ce && mergeLeg(row.ce, ceQ), pe: row.pe && mergeLeg(row.pe, peQ) }
    : row
  const live = p.pricing ? priceRow(merged, p.pricing) : merged
  const id = strikeId(row.strike)
  return (
    <View
      testID={`oc-row-${id}`}
      style={[
        styles.row,
        { height: p.height, borderBottomColor: c.border },
        p.item.atm && { backgroundColor: tint(c.primary, 0.12) },
      ]}
    >
      <LegCells {...p} side="ce" leg={live.ce} itm={p.item.ceItm} id={id} />
      <View style={styles.strike}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          maxFontSizeMultiplier={MAX_SCALE}
          style={styles.strikeText}
        >
          {fmtStrike(row.strike)}
        </Text>
      </View>
      <LegCells {...p} side="pe" leg={live.pe} itm={p.item.peItm} id={id} />
    </View>
  )
})

function LegCells(
  p: StrikeRowProps & { side: Side; leg: ChainLeg | null; itm: boolean; id: string },
) {
  const { scheme } = useTheme()
  const { side, leg, id } = p
  if (!leg) return <View style={styles.side} />
  const strike = p.item.row.strike
  const cells =
    p.view === 'price'
      ? [<OiCell key="oi" {...p} leg={leg} />, <LtpCell key="ltp" {...p} leg={leg} />]
      : p.greeks.map((g) => {
          const v = greekOf(leg, g)
          return (
            <View key={g} style={styles.cell}>
              <Num muted={v === undefined}>{v === undefined ? '–' : fmtPrice(v, GREEK_DP[g])}</Num>
            </View>
          )
        })
  return (
    <Pressable
      testID={p.item.atm ? IDS[side].atm : `${IDS[side].cell}${id}`}
      accessibilityRole="button"
      accessibilityLabel={legLabel(p.underlying, leg, strike, side)}
      onPress={() => p.onLeg(strike, side)}
      style={[
        styles.side,
        p.itm && { backgroundColor: tint(AMBER, scheme === 'dark' ? 0.14 : 0.1) },
      ]}
    >
      {/* outer cell first on the call's side; the put mirrors it, its inner cell by the strike */}
      {side === 'ce' ? cells : [...cells].reverse()}
    </Pressable>
  )
}

function OiCell(p: StrikeRowProps & { side: Side; leg: ChainLeg; id: string }) {
  const { c } = useTheme()
  const max = p.side === 'ce' ? p.maxOi.ce : p.maxOi.pe
  const share = max > 0 ? Math.min(1, p.leg.oi / max) : 0
  return (
    <View style={styles.cell}>
      <View
        testID={`${IDS[p.side].bar}${p.id}`}
        style={[
          styles.bar,
          p.side === 'ce' ? styles.barLeft : styles.barRight,
          { width: `${Math.round(share * 100)}%`, backgroundColor: tint(c.foreground, 0.09) },
        ]}
      />
      <Num testID={`${IDS[p.side].oi}${p.id}`} size={13} bold={max > 0 && p.leg.oi === max}>
        {fmtOi(p.leg.oi)}
      </Num>
    </View>
  )
}

function LtpCell(p: StrikeRowProps & { side: Side; leg: ChainLeg; id: string }) {
  const { leg } = p
  const flash = useFlash(leg.symbol, leg.ltp, p.reduceMotion)
  const pct = changePct(leg.ltp, leg.prev_close)
  const sign = signOf(pct)
  return (
    <View style={[styles.cell, flash !== null && { backgroundColor: flash }]}>
      <Num testID={`${IDS[p.side].ltp}${p.id}`} size={14} weight="600" dim={p.stale && p.feeding}>
        {leg.ltpMissing ? '--' : fmtPrice(leg.ltp)}
      </Num>
      <Num size={12} tone={sign > 0 ? 'profit' : sign < 0 ? 'loss' : 'muted'}>
        {fmtPct(pct)}
      </Num>
    </View>
  )
}

/** A numeric cell's text: right-aligned, tabular, one line, shrinking before it clips. */
function Num(p: {
  children: string
  testID?: string
  size?: number
  weight?: '600' | '700'
  bold?: boolean
  muted?: boolean
  dim?: boolean
  tone?: 'profit' | 'loss' | 'muted'
}) {
  return (
    <Text
      testID={p.testID}
      tone={p.tone ?? (p.muted ? 'muted' : 'default')}
      numberOfLines={1}
      adjustsFontSizeToFit
      maxFontSizeMultiplier={MAX_SCALE}
      style={[
        styles.num,
        { fontSize: p.size ?? 14 },
        p.weight !== undefined && { fontWeight: p.weight },
        p.bold && styles.bold,
        p.dim && styles.dim,
      ]}
    >
      {p.children}
    </Text>
  )
}

/**
 * An 18 % tint for 400 ms when the LTP of the same symbol moves, at most once per 400 ms (ux G14):
 * a move while one shows changes nothing, so a busy leg never flickers green and red. None under
 * reduced motion; a recycled row showing another leg drops its tint.
 */
function useFlash(symbol: string, ltp: number, reduceMotion: boolean): string | null {
  const { trade } = useTheme()
  const last = useRef({ symbol, ltp })
  /** When the flash on show ends. */
  const until = useRef(0)
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    const prev = last.current
    last.current = { symbol, ltp }
    if (prev.symbol !== symbol || reduceMotion) {
      until.current = 0
      setFlash(null)
      return
    }
    if (prev.ltp === ltp || Date.now() < until.current) return
    until.current = Date.now() + FLASH_MS
    setFlash(tint(ltp > prev.ltp ? trade.profit : trade.loss, 0.18))
  }, [symbol, ltp, reduceMotion, trade])
  // it ends 400 ms after it began, whatever ticks meanwhile
  useEffect(() => {
    if (flash === null) return
    const t = setTimeout(() => setFlash(null), Math.max(0, until.current - Date.now()))
    return () => clearTimeout(t)
  }, [flash])
  return flash
}

/** The live spot between the strikes around it (ux OC-3). */
export function SpotMarker({ spot }: { spot: number }) {
  const { c } = useTheme()
  return (
    <View testID="oc-spot" style={styles.spot} accessibilityLabel={`Spot ${fmtPrice(spot)}`}>
      <View style={[styles.spotLine, { backgroundColor: c.primary }]} />
      <View style={[styles.spotPill, { backgroundColor: c.primary }]}>
        <Text
          maxFontSizeMultiplier={MAX_SCALE}
          style={[styles.spotText, { color: c.primaryForeground }]}
        >
          {fmtPrice(spot)}
        </Text>
      </View>
      <View style={[styles.spotLine, { backgroundColor: c.primary }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  side: { flex: 1, flexDirection: 'row', minWidth: 0 },
  cell: { flex: 1, minWidth: 0, justifyContent: 'center', paddingHorizontal: 6 },
  strike: { width: STRIKE_WIDTH, alignItems: 'center', justifyContent: 'center' },
  strikeText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  num: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700' },
  dim: { opacity: 0.5 },
  bar: { position: 'absolute', top: 6, bottom: 6 },
  barLeft: { left: 0 },
  barRight: { right: 0 },
  spot: { height: SPOT_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  spotLine: { flex: 1, height: 1 },
  spotPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  spotText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
})
