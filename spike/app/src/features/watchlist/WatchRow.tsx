// THROWAWAY SPIKE. One watchlist row: subscribes only to its own symbol and optionally flashes on LTP change, to measure per-row cost.
import { memo, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { type Instrument, keyOf } from '~/core/symbols';
import { useQuote } from '~/core/tickStore';
import { noteFlash } from './flashStats';
import { C, DOWN_CHIP, DOWN_TINT, fmtPct, fmtPrice, fmtSigned, signOf, UP_CHIP, UP_TINT } from './theme';

export const ROW_H = 56;
export const FLASH_MS = 400;

interface RowProps {
  ins: Instrument;
  flash: boolean;
}

export const WatchRow = memo(function WatchRow({ ins, flash }: RowProps) {
  const itemKey = keyOf(ins.symbol, ins.exchange);
  const q = useQuote(itemKey);
  const sg = q ? signOf(q.change) : 0;
  const color = sg > 0 ? C.up : sg < 0 ? C.down : C.muted;
  const chipBg = sg > 0 ? UP_CHIP : sg < 0 ? DOWN_CHIP : C.surface;

  return (
    <View style={s.row}>
      {flash ? <FlashOverlay itemKey={itemKey} ltp={q?.ltp} ts={q?.ts} /> : null}
      <View style={s.left}>
        <Text style={s.sym} numberOfLines={1}>
          {ins.symbol}
        </Text>
        <Text style={s.tag}>{ins.exchange}</Text>
      </View>
      <View style={s.mid}>
        <Text style={s.ltp}>{q ? fmtPrice(q.ltp) : '--'}</Text>
        <Text style={[s.chg, { color }]}>{q ? fmtSigned(q.change) : '--'}</Text>
      </View>
      <View style={[s.chip, { backgroundColor: chipBg }]}>
        <Text style={[s.pct, { color }]}>{q ? fmtPct(q.changePct) : '--'}</Text>
      </View>
    </View>
  );
});

interface FlashProps {
  itemKey: string;
  ltp: number | undefined;
  ts: number | undefined;
}

/**
 * Mounted only while "Flash on", so "Flash off" carries zero Reanimated cost per row.
 * FlashList recycles cells: when the cell switches to another symbol, its first
 * quote is not a price change, so the key is tracked and that case is skipped.
 */
function FlashOverlay({ itemKey, ltp, ts }: FlashProps) {
  // Signed intensity: +1 = up tint, -1 = down tint, decays to 0 over FLASH_MS.
  const f = useSharedValue(0);
  const last = useRef<{ key: string; ltp: number | undefined }>({ key: itemKey, ltp });

  useEffect(() => {
    const prev = last.current;
    last.current = { key: itemKey, ltp };
    if (prev.key !== itemKey || prev.ltp == null || ltp == null || ltp === prev.ltp) return;
    const target = ltp > prev.ltp ? 1 : -1;
    f.set(withSequence(withTiming(target, { duration: 0 }), withTiming(0, { duration: FLASH_MS })));
    noteFlash();
    // ts is a dependency on purpose: the effect is driven by each published quote.
  }, [itemKey, ltp, ts, f]);

  const style = useAnimatedStyle(() => {
    'worklet';
    const v = f.get();
    return { opacity: v < 0 ? -v : v, backgroundColor: v < 0 ? DOWN_TINT : UP_TINT };
  });

  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]} />;
}

const s = StyleSheet.create({
  row: {
    height: ROW_H,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  left: { flex: 1, minWidth: 0, justifyContent: 'center' },
  sym: { color: C.text, fontSize: 15, fontWeight: '600', letterSpacing: 0.2 },
  tag: {
    alignSelf: 'flex-start',
    marginTop: 3,
    color: C.muted,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  mid: { alignItems: 'flex-end', justifyContent: 'center', marginRight: 12 },
  ltp: { color: C.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chg: { marginTop: 2, fontSize: 12, fontVariant: ['tabular-nums'] },
  chip: {
    width: 76,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
