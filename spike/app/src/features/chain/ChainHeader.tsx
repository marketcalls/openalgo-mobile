// THROWAWAY SPIKE. Option chain header: ticking NIFTY quote, expiry, feed status,
// and the summary banner of the last chain:scroll benchmark run.
import { StyleSheet, Text, View } from 'react-native';
import type { FrameSummary, WindowResult } from '~/core/metrics';
import { PASS, useResults } from '~/core/results';
import { useSettings } from '~/core/settings';
import { CHAIN_EXPIRY, CHAIN_UNDERLYING } from '~/core/symbols';
import { useQuote } from '~/core/tickStore';
import { bandCode, C, decodeBand, fmtExpiry, fmtPct, fmtSigned, ROWS, UNDER_KEY } from './ui';

/** Re-renders on every underlying tick; it is the only component that does. */
export function UnderlyingHeader() {
  const q = useQuote(UNDER_KEY);
  const status = useSettings((st) => st.status);
  const { atm } = decodeBand(bandCode(q?.ltp));
  const chgColor = q == null || q.change === 0 ? C.muted : q.change > 0 ? C.up : C.down;
  const statusColor =
    status.state === 'streaming' ? C.up : status.state === 'error' ? C.down : status.state === 'closed' || status.state === 'idle' ? C.muted : C.amber;
  return (
    <View style={s.wrap}>
      <View style={s.line}>
        <Text style={s.sym}>{CHAIN_UNDERLYING.symbol}</Text>
        <Text style={s.ltp}>{q ? q.ltp.toFixed(2) : '-'}</Text>
        <Text style={[s.chg, { color: chgColor }]}>
          {fmtSigned(q?.change)} ({fmtPct(q?.changePct)})
        </Text>
      </View>
      <View style={s.line}>
        <Text style={s.meta} numberOfLines={1}>
          Exp {fmtExpiry(CHAIN_EXPIRY)} · ATM {atm >= 0 ? ROWS[atm].strike : '-'}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={[s.dot, { backgroundColor: statusColor }]} />
        <Text style={s.meta} numberOfLines={1}>
          {status.state}
          {status.detail ? ` · ${status.detail}` : ''}
        </Text>
      </View>
    </View>
  );
}

type ChainMetrics = WindowResult & {
  scrollRangeDp?: number;
  observedMaxOffsetDp?: number;
  atmBandChanges?: number;
};

function fv(x: FrameSummary | null | undefined, key: 'fps' | 'slowPct' | 'p95FrameMs') {
  return x == null ? '-' : String(x[key]);
}

export function BenchBanner({ running }: { running: boolean }) {
  const last = useResults((st) => {
    for (let i = st.results.length - 1; i >= 0; i--) if (st.results[i].scenario === 'chain:scroll') return st.results[i];
    return undefined;
  });
  if (running) {
    return (
      <View style={[s.banner, { borderColor: C.accent }]}>
        <Text style={s.bannerTxt}>Running chain:scroll for 20 s (1 s settle first). Do not touch the screen.</Text>
      </View>
    );
  }
  if (!last) return null;
  const m = last.metrics as unknown as ChainMetrics;
  const color = last.pass ? C.up : C.down;
  return (
    <View style={[s.banner, { borderColor: color }]}>
      <Text style={[s.bannerHead, { color }]}>
        {last.pass ? 'PASS' : 'FAIL'} chain:scroll · {Math.round((m.durationMs ?? 0) / 100) / 10} s
      </Text>
      <Text style={s.bannerTxt}>
        UI {fv(m.ui, 'fps')} fps (p95 {fv(m.ui, 'p95FrameMs')} ms, slow {fv(m.ui, 'slowPct')}%) · JS {fv(m.js, 'fps')} fps (slow{' '}
        {fv(m.js, 'slowPct')}%)
      </Text>
      <Text style={s.bannerSub}>
        ticks {m.ticksPerSec}/s · flushes {m.flushesPerSec}/s · scroll range {m.scrollRangeDp ?? '-'} dp (seen{' '}
        {m.observedMaxOffsetDp ?? '-'}) · ATM band moves {m.atmBandChanges ?? '-'} · bar UI≥{PASS.nativeUiFps} JS≥{PASS.nativeJsFps} slow≤
        {PASS.nativeSlowPctMax}%
      </Text>
      {m.ui == null ? <Text style={[s.bannerSub, { color: C.amber }]}>No UI-thread samples: UiFpsProbe did not register.</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 12, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sym: { color: C.text, fontSize: 15, fontWeight: '700' },
  ltp: { color: C.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chg: { fontSize: 13, fontVariant: ['tabular-nums'] },
  meta: { color: C.muted, fontSize: 11, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  banner: {
    marginHorizontal: 12,
    marginTop: 6,
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: C.surface,
    gap: 2,
  },
  bannerHead: { fontSize: 13, fontWeight: '700' },
  bannerTxt: { color: C.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  bannerSub: { color: C.muted, fontSize: 10, fontVariant: ['tabular-nums'] },
});
