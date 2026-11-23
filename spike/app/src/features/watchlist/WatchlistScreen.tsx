// THROWAWAY SPIKE. Native watchlist screen: 100 live rows in FlashList v2 with optional tick flash and a scripted 20 s scroll benchmark.
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FeedStatus } from '~/core/feed';
import type { FrameSummary } from '~/core/metrics';
import { type BenchResult, useResults } from '~/core/results';
import { useSettings } from '~/core/settings';
import { type Instrument, keyOf, WATCHLIST } from '~/core/symbols';
import { QuotesPausedContext } from '~/core/tickStore';
import { BENCH_MS, runWatchlistScrollBench } from './scrollBench';
import { C } from './theme';
import { ROW_H, WatchRow } from './WatchRow';

const keyExtractor = (ins: Instrument) => keyOf(ins.symbol, ins.exchange);
const renderItem = ({ item, extraData }: ListRenderItemInfo<Instrument>) => (
  <WatchRow ins={item} flash={extraData === true} />
);

function selectLatest(s: { results: BenchResult[] }): BenchResult | undefined {
  for (let i = s.results.length - 1; i >= 0; i--) {
    if (s.results[i].scenario.startsWith('watchlist:scroll')) return s.results[i];
  }
  return undefined;
}

function statusColor(st: FeedStatus['state']) {
  if (st === 'streaming' || st === 'authenticated') return C.up;
  if (st === 'connecting') return '#f59e0b';
  if (st === 'error') return C.down;
  return C.muted;
}

export default function WatchlistScreen() {
  const insets = useSafeAreaInsets();
  // Rows stop subscribing to ticks while another tab is visible (see QuotesPausedContext).
  const focused = useIsFocused();
  const listRef = useRef<FlashListRef<Instrument>>(null);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const [flash, setFlash] = useState(true);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useSettings((s) => s.status);
  const feedMode = useSettings((s) => s.feedMode);
  const simRate = useSettings((s) => s.simRate);
  const flushMode = useSettings((s) => s.flushMode);
  const latest = useResults(selectLatest);

  const onListLayout = (e: LayoutChangeEvent) => {
    viewportH.current = e.nativeEvent.layout.height;
  };
  const onContentSize = (_w: number, h: number) => {
    contentH.current = h;
  };

  // Content is 100 fixed-height rows; prefer the measured size, fall back to the arithmetic.
  const maxOffset = () => Math.max(0, (contentH.current || WATCHLIST.length * ROW_H) - viewportH.current);

  const startBench = () => {
    if (running) return;
    if (!viewportH.current || maxOffset() <= 0) {
      setNotice('List is not laid out yet, try again in a moment.');
      return;
    }
    setNotice(null);
    setRunning(true);
    runWatchlistScrollBench({
      getList: () => listRef.current,
      getMaxOffset: maxOffset,
      flash,
      rows: WATCHLIST.length,
      rowHeight: ROW_H,
    })
      .then((r) => {
        if (r === 'busy') setNotice('Another benchmark is running.');
      })
      .catch((e: unknown) => setNotice(`Bench failed: ${String(e)}`))
      .finally(() => setRunning(false));
  };

  const st = status.state;
  // Sim's status detail repeats the rate, so show the rate for sim and the socket detail for ws.
  const feedLabel = feedMode === 'sim' ? `sim ${simRate}/s` : `ws${status.detail ? ` ${status.detail}` : ''}`;

  return (
    <QuotesPausedContext value={!focused}>
      <View style={[s.screen, { paddingTop: Math.max(insets.top, 24) + 8 }]}>
        <StatusBar style="light" />
        <View style={s.header}>
          <Text style={s.title}>Watchlist</Text>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: statusColor(st) }]} />
            <Text style={s.statusTxt} numberOfLines={1}>
              {st} · {feedLabel} · flush {flushMode} · {WATCHLIST.length} rows
            </Text>
          </View>
          <View style={s.btnRow}>
            <Pressable
              onPress={() => setFlash((v) => !v)}
              disabled={running}
              style={({ pressed }) => [s.toggle, flash && s.toggleOn, (pressed || running) && s.dim]}
            >
              <Text style={[s.toggleTxt, flash && s.toggleTxtOn]}>{flash ? 'Flash on' : 'Flash off'}</Text>
            </Pressable>
            <Pressable
              onPress={startBench}
              disabled={running}
              style={({ pressed }) => [s.btn, (pressed || running) && s.dim]}
            >
              <Text style={s.btnTxt}>{running ? 'Running...' : `Run scroll bench (${BENCH_MS / 1000} s)`}</Text>
            </Pressable>
          </View>
          {running ? (
            <View style={s.banner}>
              <Text style={s.bannerTxt}>
                Running {flash ? 'flash-on' : 'flash-off'}: 1 s settle, then {BENCH_MS / 1000} s of scripted scrolling. Do not touch the screen.
              </Text>
            </View>
          ) : notice ? (
            <View style={s.banner}>
              <Text style={s.bannerTxt}>{notice}</Text>
            </View>
          ) : latest ? (
            <ResultBanner r={latest} />
          ) : null}
        </View>
        <View style={s.colHead}>
          <Text style={[s.colTxt, { flex: 1 }]}>SYMBOL</Text>
          <Text style={[s.colTxt, { marginRight: 12 }]}>LTP / CHG</Text>
          <Text style={[s.colTxt, { width: 76, textAlign: 'center' }]}>CHG %</Text>
        </View>
        <View style={s.listWrap} onLayout={onListLayout}>
          <FlashList
            ref={listRef}
            data={WATCHLIST}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            extraData={flash}
            onContentSizeChange={onContentSize}
            showsVerticalScrollIndicator={false}
          />
        </View>
      </View>
    </QuotesPausedContext>
  );
}

function ResultBanner({ r }: { r: BenchResult }) {
  const m = r.metrics as { ui?: FrameSummary | null; js?: FrameSummary; ticksPerSec?: number };
  const ui = m.ui ?? null;
  const fmtFps = (f: FrameSummary | null | undefined) => (f ? `${f.fps}` : '-');
  return (
    <View style={[s.banner, { borderColor: r.pass ? C.up : C.down }]}>
      <View style={s.bannerTop}>
        <Text style={s.bannerTitle} numberOfLines={1}>
          {r.scenario.replace('watchlist:', '')}
        </Text>
        <Text style={[s.badge, { color: r.pass ? C.up : C.down }]}>{r.pass ? 'PASS' : 'FAIL'}</Text>
      </View>
      <Text style={s.bannerNums}>
        UI {fmtFps(ui)} fps · JS {fmtFps(m.js)} fps · UI slow {ui ? `${ui.slowPct}%` : '-'} · UI p95 {ui ? `${ui.p95FrameMs} ms` : '-'}
        {m.ticksPerSec != null ? ` · ${m.ticksPerSec} ticks/s` : ''}
      </Text>
      {!ui ? <Text style={s.bannerTxt}>No UI-thread samples: the frame probe was not running.</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  title: { color: C.text, fontSize: 22, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusTxt: { flex: 1, color: C.muted, fontSize: 12 },
  btnRow: { flexDirection: 'row', gap: 8 },
  toggle: {
    paddingHorizontal: 12,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleOn: { borderColor: C.accent },
  toggleTxt: { color: C.muted, fontSize: 13, fontWeight: '600' },
  toggleTxtOn: { color: C.text },
  btn: {
    flex: 1,
    height: 36,
    borderRadius: 8,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  dim: { opacity: 0.55 },
  banner: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 3,
  },
  bannerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  bannerTitle: { flex: 1, color: C.text, fontSize: 12, fontWeight: '600' },
  badge: { fontSize: 12, fontWeight: '700' },
  bannerNums: { color: C.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  bannerTxt: { color: C.muted, fontSize: 12 },
  colHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  colTxt: { color: C.muted, fontSize: 10, fontWeight: '600', letterSpacing: 0.6 },
  listWrap: { flex: 1 },
});
