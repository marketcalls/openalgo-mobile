// THROWAWAY SPIKE. Chart screen: native header with the native-feed LTP, the
// frontend's OpenAlgoChart inside an Expo DOM component, the native order sheet, and
// two scripted benchmarks (open time, 20 s pan) plus the in-DOM / via-bridge tick toggle.
import { useIsFocused } from 'expo-router';
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isBenchRunning, runBench, runConditions, setDomMounted } from '~/core/bench';
import { PASS, useResults } from '~/core/results';
import { useSettings } from '~/core/settings';
import { keyOf, WATCHLIST } from '~/core/symbols';
import { getQuote, QuotesPausedContext, useQuote } from '~/core/tickStore';
import ChartDom, { type ChartDomRef } from '~/dom/ChartDom';
import type { BridgeQuote, ChartReadyInfo, PanBenchSummary, TickMode, TradeRequest } from '~/dom/chart/types';
import { OrderSheet, type PlacedOrder } from '~/features/order/OrderSheet';

const SYMBOL = 'RELIANCE';
const EXCHANGE = 'NSE';
const KEY = keyOf(SYMBOL, EXCHANGE);
const FALLBACK_BASE = WATCHLIST.find((i) => i.symbol === SYMBOL)?.base ?? 1000;
const PAN_MS = 20_000;
const OPEN_TIMEOUT_MS = 30_000;
const BRIDGE_HZ = 4;

const C = {
  bg: '#0b0f14',
  surface: '#121821',
  border: '#1f2a37',
  text: '#e6edf3',
  muted: '#8b98a5',
  up: '#22c55e',
  down: '#ef4444',
  accent: '#3b82f6',
};

// WebView props. The chart owns every gesture, so the page must not scroll.
const DOM_PROPS = {
  style: { flex: 1 },
  containerStyle: { flex: 1, backgroundColor: C.bg },
  scrollEnabled: false,
  bounces: false,
} as const;

function runSettings(tickMode: TickMode) {
  return { tickMode, ...runConditions() };
}

/** Only this re-renders on RELIANCE ticks, never the DOM host. */
function LiveLtp() {
  const q = useQuote(KEY);
  if (!q) return <Text style={st.ltpMuted}>--</Text>;
  const color = q.change >= 0 ? C.up : C.down;
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <Text style={[st.ltp, { color }]}>{q.ltp.toFixed(2)}</Text>
      <Text style={[st.small, { color }]}>
        {q.change >= 0 ? '+' : ''}
        {q.changePct.toFixed(2)}% <Text style={st.small}>native feed</Text>
      </Text>
    </View>
  );
}

function FeedStatus() {
  const status = useSettings((s) => s.status);
  const ok = status.state === 'streaming' || status.state === 'authenticated';
  return (
    <Text style={[st.small, { color: ok ? C.up : C.muted }]} numberOfLines={1}>
      feed {status.state}
      {status.detail ? ` · ${status.detail}` : ''}
    </Text>
  );
}

interface HostProps {
  tickMode: TickMode;
  active: boolean;
  qty: number;
  domRef: RefObject<ChartDomRef | null>;
  onMounted: (t: number) => void;
  onReady: (info: ChartReadyInfo) => Promise<void>;
  onTrade: (req: TradeRequest) => Promise<void>;
  onBenchDone: (s: PanBenchSummary) => Promise<void>;
  onError: (msg: string) => Promise<void>;
}

/**
 * Owns the DOM component. Memoized with stable callbacks: Expo re-sends every prop
 * (and re-renders the whole DOM tree) on each render of the element, so nothing
 * else on this screen may re-render it. In via-bridge mode the 4 Hz quote prop is
 * the only thing that does, which is exactly the cost being measured.
 */
const ChartHost = memo(function ChartHost(p: HostProps) {
  const [basePrice] = useState(() => getQuote(KEY)?.ltp ?? FALLBACK_BASE);
  const [bridgeQuote, setBridgeQuote] = useState<BridgeQuote | null>(null);
  const { onMounted } = p;

  useLayoutEffect(() => {
    onMounted(performance.now());
  }, [onMounted]);

  // Recorded in every bench result's settings.domMounted (a live WebView is part of the run condition).
  useEffect(() => {
    setDomMounted('chart', true);
    return () => setDomMounted('chart', false);
  }, []);

  useEffect(() => {
    if (p.tickMode !== 'bridge' || !p.active) return;
    let lastTs = -1;
    let seq = 0;
    const id = setInterval(() => {
      const q = getQuote(KEY);
      if (!q || q.ts === lastTs) return;
      lastTs = q.ts;
      setBridgeQuote({ ltp: q.ltp, seq: ++seq, sentAt: Date.now() });
    }, 1000 / BRIDGE_HZ);
    return () => clearInterval(id);
  }, [p.tickMode, p.active]);

  return (
    <ChartDom
      ref={p.domRef}
      dom={DOM_PROPS}
      symbol={SYMBOL}
      exchange={EXCHANGE}
      basePrice={basePrice}
      tickMode={p.tickMode}
      active={p.active}
      qty={p.qty}
      bridgeQuote={p.tickMode === 'bridge' ? bridgeQuote : null}
      onReady={p.onReady}
      onTrade={p.onTrade}
      onBenchDone={p.onBenchDone}
      onError={p.onError}
    />
  );
});

function Btn({ label, onPress, disabled, active }: { label: string; onPress: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        st.btn,
        active && { backgroundColor: C.accent, borderColor: C.accent },
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={st.btnTxt}>{label}</Text>
    </Pressable>
  );
}

export default function ChartScreen() {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  // NativeTabs mounts every tab at app start (expo-router preloads them). Without this
  // the chart WebView would load its 2.3 MB bundle during app startup and stay alive
  // behind every other tab's bench. Mount it on the first visit to this tab instead,
  // so 'first-mount' open time is "user opens the Chart tab", as in the real app.
  const [visited, setVisited] = useState(focused);
  if (focused && !visited) setVisited(true);
  const [tickMode, setTickMode] = useState<TickMode>('dom');
  const [mountKey, setMountKey] = useState(0);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<null | 'open' | 'pan'>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Loading chart…');
  const [trade, setTrade] = useState<TradeRequest | null>(null);
  const [tapLatency, setTapLatency] = useState<number | null>(null);

  const domRef = useRef<ChartDomRef | null>(null);
  const tickModeRef = useRef(tickMode);
  tickModeRef.current = tickMode;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const mountAt = useRef(0);
  const pressAt = useRef<number | null>(null);
  const opens = useRef(0);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const benchDone = useRef<((s: PanBenchSummary) => void) | null>(null);

  const onMounted = useCallback((t: number) => {
    mountAt.current = t;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      const remount = pressAt.current != null;
      setStatus(`Chart did not report ready within ${OPEN_TIMEOUT_MS / 1000} s`);
      useResults.getState().add({
        scenario: 'chart:open',
        settings: runSettings(tickModeRef.current),
        metrics: { error: 'timeout', timeoutMs: OPEN_TIMEOUT_MS, kind: remount ? 'remount' : 'first-mount' },
        pass: false,
      });
      pressAt.current = null;
      setBusy(null);
    }, OPEN_TIMEOUT_MS);
  }, []);

  const onReady = useCallback(async (info: ChartReadyInfo) => {
    const readyAt = performance.now();
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    const openMs = Math.round(readyAt - mountAt.current);
    const remount = pressAt.current != null;
    const pressToReadyMs = remount ? Math.round(readyAt - (pressAt.current as number)) : null;
    pressAt.current = null;
    opens.current += 1;
    useResults.getState().add({
      scenario: 'chart:open',
      settings: runSettings(tickModeRef.current),
      metrics: {
        openMs,
        pressToReadyMs,
        // The first mount in a session also pays WebView process start-up.
        kind: remount ? 'remount' : 'first-mount',
        openIndex: opens.current,
        // A first mount while the tab is hidden loads in the background.
        focusedAtReady: focusedRef.current,
        ...info,
      },
      pass: info.ok && openMs <= PASS.chartOpenMs,
      notes: 'native mount -> DOM first painted frame with candles',
    });
    setReady(true);
    setBusy(null);
    setStatus(`Ready in ${openMs} ms · ${info.bars} bars · ${info.indicators.join(', ') || 'no indicators'}`);
  }, []);

  const onTrade = useCallback(async (req: TradeRequest) => {
    const latency = Math.max(0, Date.now() - req.tappedAt);
    setTapLatency(latency);
    setTrade(req);
    useResults.getState().add({
      scenario: 'chart:trade-tap',
      settings: runSettings(tickModeRef.current),
      metrics: { domTapToNativeMs: latency, side: req.side },
    });
  }, []);

  const onBenchDone = useCallback(async (s: PanBenchSummary) => {
    benchDone.current?.(s);
    benchDone.current = null;
  }, []);

  const onError = useCallback(async (msg: string) => {
    setStatus(msg.slice(0, 160));
  }, []);

  const reopen = () => {
    if (busy) return;
    setBusy('open');
    setReady(false);
    setStatus('Re-opening chart…');
    pressAt.current = performance.now();
    // Expo's DOM wrapper fills ref.current with a proxy only while it is null and
    // React never clears it (the ref is not attached to an element), so without
    // this the remounted chart would keep the old WebView's dead proxy.
    domRef.current = null;
    setMountKey((k) => k + 1);
  };

  const runPan = async () => {
    if (busy || !ready) return;
    if (isBenchRunning()) {
      setStatus('Another benchmark is running');
      return;
    }
    const mode = tickMode;
    setBusy('pan');
    setStatus(`Pan bench running (${PAN_MS / 1000} s, ticks ${mode === 'dom' ? 'in-DOM' : 'via bridge'})…`);
    const done = new Promise<PanBenchSummary | { ok: false; error: string }>((resolve) => {
      benchDone.current = resolve;
    });
    let started = false;
    await runBench({
      scenario: `chart:pan:ticks-${mode}`,
      durationMs: PAN_MS,
      drive: () => {
        // First frame of the native window: start the DOM's own 20 s pan + probes.
        if (started) return;
        started = true;
        const start = domRef.current?.startPanBench;
        // runBench records a thrown error as a failed result instead of hanging.
        if (typeof start !== 'function') throw new Error('chart DOM ref has no startPanBench (WebView not ready)');
        start(PAN_MS);
      },
      collectExtra: async () => {
        const dom = await Promise.race([
          done,
          new Promise<{ ok: false; error: string }>((r) =>
            setTimeout(() => r({ ok: false, error: 'DOM did not report within 15 s after the window' }), 15_000),
          ),
        ]);
        benchDone.current = null;
        return { tickMode: mode, dom, domFps: dom.ok ? (dom as PanBenchSummary).frames.fps : null };
      },
      pass: (_w, extra) => typeof extra.domFps === 'number' && extra.domFps >= PASS.chartFps,
    });
    const last = useResults.getState().results.at(-1);
    const m = (last?.metrics ?? {}) as { domFps?: number | null; ui?: { fps: number } | null; js?: { fps: number } };
    setStatus(
      `Pan: DOM ${m.domFps ?? '-'} fps · native UI ${m.ui?.fps ?? '-'} · JS ${m.js?.fps ?? '-'} · ${last?.pass ? 'PASS' : 'FAIL'}`,
    );
    setBusy(null);
  };

  const onPlaced = useCallback((o: PlacedOrder) => setQty(o.qty), []);

  return (
    <QuotesPausedContext value={!focused}>
      <View style={st.root}>
        <View style={[st.header, { paddingTop: insets.top + 22 }]}>
          <View style={st.row}>
            <View style={{ flex: 1 }}>
              <Text style={st.sym}>
                {SYMBOL} <Text style={st.ex}>{EXCHANGE}</Text>
              </Text>
              <FeedStatus />
            </View>
            <LiveLtp />
          </View>
          <View style={[st.row, { gap: 8, marginTop: 8 }]}>
            <Btn label="Open time" onPress={reopen} disabled={!!busy} />
            <Btn label={busy === 'pan' ? 'Panning…' : 'Run pan bench (20 s)'} onPress={runPan} disabled={!!busy || !ready} />
          </View>
          <View style={[st.row, { gap: 8, marginTop: 8 }]}>
            <Text style={st.small}>Ticks:</Text>
            <Btn label="in-DOM" active={tickMode === 'dom'} onPress={() => setTickMode('dom')} disabled={busy === 'pan'} />
            <Btn label="via bridge" active={tickMode === 'bridge'} onPress={() => setTickMode('bridge')} disabled={busy === 'pan'} />
          </View>
          <Text style={[st.small, { marginTop: 6 }]} numberOfLines={2}>
            {status}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          {visited ? (
            <ChartHost
              key={mountKey}
              tickMode={tickMode}
              active={focused}
              qty={qty}
              domRef={domRef}
              onMounted={onMounted}
              onReady={onReady}
              onTrade={onTrade}
              onBenchDone={onBenchDone}
              onError={onError}
            />
          ) : null}
        </View>
        {trade && (
          <OrderSheet
            key={trade.tappedAt}
            request={trade}
            tapLatencyMs={tapLatency}
            onClose={() => setTrade(null)}
            onPlaced={onPlaced}
          />
        )}
      </View>
    </QuotesPausedContext>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    backgroundColor: C.surface,
    borderBottomWidth: 1,
    borderColor: C.border,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  sym: { color: C.text, fontSize: 18, fontWeight: '800' },
  ex: { color: C.muted, fontSize: 12, fontWeight: '600' },
  ltp: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  ltpMuted: { color: C.muted, fontSize: 18, fontVariant: ['tabular-nums'] },
  small: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bg,
  },
  btnTxt: { color: C.text, fontSize: 13, fontWeight: '700' },
});
