// THROWAWAY SPIKE. One option chain row: CE half and PE half are separate memo
// components, each subscribed only to its own option symbol, so a CE tick
// re-renders only that CE half (one View, three Text), not the row or the list.
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type Quote, useQuote } from '~/core/tickStore';
import { C, fmtOI, fmtPct, fmtPrice, ROW_H, type Row, STRIKE_W } from './ui';

function ltpStyle(q: Quote | undefined) {
  return q?.dir === 1 ? s.up : q?.dir === -1 ? s.down : null;
}
function chgStyle(q: Quote | undefined) {
  return q == null || q.changePct === 0 ? s.muted : q.changePct > 0 ? s.up : s.down;
}

interface HalfProps {
  qkey: string;
  itm: boolean;
}

export const CeHalf = memo(function CeHalf({ qkey, itm }: HalfProps) {
  const q = useQuote(qkey);
  return (
    <View style={[s.half, itm && s.itm]}>
      <Text style={[s.cell, s.oi]} numberOfLines={1}>
        {fmtOI(q?.oi)}
      </Text>
      <Text style={[s.cell, s.chg, chgStyle(q)]} numberOfLines={1}>
        {fmtPct(q?.changePct)}
      </Text>
      <Text style={[s.cell, s.ltp, ltpStyle(q)]} numberOfLines={1}>
        {fmtPrice(q?.ltp)}
      </Text>
    </View>
  );
});

export const PeHalf = memo(function PeHalf({ qkey, itm }: HalfProps) {
  const q = useQuote(qkey);
  return (
    <View style={[s.half, itm && s.itm]}>
      <Text style={[s.cell, s.ltp, ltpStyle(q)]} numberOfLines={1}>
        {fmtPrice(q?.ltp)}
      </Text>
      <Text style={[s.cell, s.chg, chgStyle(q)]} numberOfLines={1}>
        {fmtPct(q?.changePct)}
      </Text>
      <Text style={[s.cell, s.oi]} numberOfLines={1}>
        {fmtOI(q?.oi)}
      </Text>
    </View>
  );
});

interface RowProps {
  row: Row;
  ceItm: boolean;
  peItm: boolean;
  atm: boolean;
}

/** Props are primitives plus a module-level row object, so memo bails out for
 *  every row whose moneyness did not change when the ATM band moves. */
export const ChainRow = memo(function ChainRow({ row, ceItm, peItm, atm }: RowProps) {
  return (
    <View style={[s.row, atm && s.atmRow]}>
      <CeHalf qkey={row.ceKey} itm={ceItm} />
      <View style={[s.strike, atm && s.atmStrike]}>
        <Text style={[s.strikeTxt, atm && s.atmStrikeTxt]} numberOfLines={1}>
          {row.strike}
        </Text>
      </View>
      <PeHalf qkey={row.peKey} itm={peItm} />
    </View>
  );
});

/** Column header above the list (outside FlashList so it never scrolls away). */
export function ChainColumns() {
  return (
    <View>
      <View style={s.sideLabels}>
        <Text style={[s.sideTxt, { color: C.up }]}>CALLS</Text>
        <View style={{ width: STRIKE_W }} />
        <Text style={[s.sideTxt, { color: C.down }]}>PUTS</Text>
      </View>
      <View style={[s.row, s.colRow]}>
        <View style={s.half}>
          <Text style={[s.colTxt, s.oi]}>OI</Text>
          <Text style={[s.colTxt, s.chg]}>Chg%</Text>
          <Text style={[s.colTxt, s.ltp]}>LTP</Text>
        </View>
        <View style={s.strike}>
          <Text style={s.colTxt}>Strike</Text>
        </View>
        <View style={s.half}>
          <Text style={[s.colTxt, s.ltp]}>LTP</Text>
          <Text style={[s.colTxt, s.chg]}>Chg%</Text>
          <Text style={[s.colTxt, s.oi]}>OI</Text>
        </View>
      </View>
    </View>
  );
}

const num = { fontVariant: ['tabular-nums' as const], fontSize: 12, textAlign: 'center' as const };

const s = StyleSheet.create({
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  atmRow: {
    backgroundColor: C.atmRow,
    borderTopWidth: 1,
    borderTopColor: C.accent,
    borderBottomWidth: 1,
    borderBottomColor: C.accent,
  },
  half: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  itm: { backgroundColor: C.itm },
  cell: { ...num, color: C.text, paddingHorizontal: 1 },
  oi: { flex: 0.9, color: C.muted },
  chg: { flex: 1 },
  ltp: { flex: 1.25 },
  up: { color: C.up },
  down: { color: C.down },
  muted: { color: C.muted },
  strike: {
    width: STRIKE_W,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  atmStrike: { backgroundColor: C.accent, borderColor: C.accent },
  strikeTxt: { ...num, fontSize: 13, fontWeight: '700', color: C.text },
  atmStrikeTxt: { color: '#ffffff' },
  sideLabels: { flexDirection: 'row', paddingTop: 6, paddingBottom: 2 },
  sideTxt: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  colRow: { height: 24, backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  colTxt: { fontSize: 10, color: C.muted, textAlign: 'center', fontWeight: '600' },
});
