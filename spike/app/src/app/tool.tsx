// THROWAWAY SPIKE. Tool tab: mounts the web frontend's Max Pain page in a fresh DOM component on demand and times native mount -> chart drawn, plus WebView JS heap.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runConditions, setDomMounted } from '~/core/bench';
import { PASS, useResults } from '~/core/results';
import ToolDom, { type ToolReadyPayload } from '~/dom/ToolDom';
import { pathOf, respond } from '~/dom/tool/fixtures';
import type { WireRequest, WireResponse } from '~/dom/tool/transport';

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

const NATIVE_TIMEOUT_MS = 30_000;

type FixtureMode = 'dom' | 'native';

interface Latest {
  runId: number;
  openMs: number | null;
  memoryMb: number | null;
  pass: boolean;
  error: string | null;
  domMs: number | null;
  nativeCommitMs: number | null;
  openIndex: number;
}

// Counts opens for the whole app process: the first one also pays for
// starting the WebView/Chromium machinery, later ones do not.
let opensThisProcess = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kept separate and memoised so screen re-renders never re-send props into the WebView. */
const ToolFrame = memo(function ToolFrame(props: {
  runId: number;
  fixtureMode: FixtureMode;
  latencyMs: number;
  onReady: (p: ToolReadyPayload) => Promise<void>;
  serveRequest: (req: WireRequest) => Promise<WireResponse>;
  onNativeCommit: () => void;
}) {
  const { onNativeCommit, ...domProps } = props;
  useLayoutEffect(() => {
    onNativeCommit();
  }, [onNativeCommit]);
  // Recorded in every bench result's settings.domMounted.
  useEffect(() => {
    setDomMounted('tool', true);
    return () => setDomMounted('tool', false);
  }, []);
  return <ToolDom {...domProps} dom={{ style: { flex: 1 } }} />;
});

export default function ToolScreen() {
  const insets = useSafeAreaInsets();
  const [runId, setRunId] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [fixtureMode, setFixtureMode] = useState<FixtureMode>('dom');
  const [latencyMs, setLatencyMs] = useState(0);
  const [latest, setLatest] = useState<Latest | null>(null);
  const [busy, setBusy] = useState(false);

  const t0 = useRef(0);
  const tCommit = useRef<number | null>(null);
  const currentRun = useRef(0);
  const openIndex = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read by callbacks at record time; chips are disabled while an open is in flight.
  const cfg = useRef({ fixtureMode, latencyMs });
  useEffect(() => {
    cfg.current = { fixtureMode, latencyMs };
  }, [fixtureMode, latencyMs]);

  const record = useCallback((p: ToolReadyPayload | null, openMs: number | null, error: string | null) => {
    const memoryMb = p?.memoryMb ?? null;
    const pass =
      !error && openMs != null && openMs <= PASS.toolOpenMs && (memoryMb == null || memoryMb <= PASS.toolMemoryMb);
    const nativeCommitMs = tCommit.current == null ? null : Math.round(tCommit.current - t0.current);
    useResults.getState().add({
      scenario: 'tool:maxpain-open',
      settings: {
        ...runConditions(),
        fixtureMode: cfg.current.fixtureMode,
        fixtureLatencyMsPerRequest: cfg.current.latencyMs,
        openIndexThisProcess: openIndex.current,
      },
      metrics: {
        openMs: openMs == null ? null : Math.round(openMs),
        nativeCommitMs,
        memoryMb,
        dom: p
          ? {
              msSinceDomStart: p.msSinceDomStart,
              marks: p.marks,
              nav: p.nav,
              heap: p.heap,
              longTasks: p.longTasks,
              wire: p.wire,
              bars: p.bars,
              viewport: p.viewport,
              importMetaRegistryPreexisting: p.importMetaRegistryPreexisting,
              pageErrors: p.pageErrors,
            }
          : null,
        error,
      },
      pass,
      notes:
        'openMs = Open press (fresh mount) -> DOM reports Plotly bars painted. memoryMb = WebView ' +
        'performance.memory.usedJSHeapSize (JS heap only, not WebView process RSS; Chromium may bucket it). ' +
        'Backend answered by in-app fixtures, so real server/broker time is NOT included.',
    });
    setLatest({
      runId: currentRun.current,
      openMs: openMs == null ? null : Math.round(openMs),
      memoryMb,
      pass,
      error,
      domMs: p?.msSinceDomStart ?? null,
      nativeCommitMs,
      openIndex: openIndex.current,
    });
    setBusy(false);
  }, []);

  const onReady = useCallback(
    async (p: ToolReadyPayload) => {
      const t1 = performance.now();
      if (p.runId !== currentRun.current) return; // a stale WebView from an earlier open
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = null;
      record(p, t1 - t0.current, p.ok ? null : p.error);
    },
    [record],
  );

  const serveRequest = useCallback(async (req: WireRequest): Promise<WireResponse> => {
    if (cfg.current.latencyMs > 0) await sleep(cfg.current.latencyMs);
    return (
      respond(req) ?? {
        status: 404,
        body: { status: 'error', message: `spike fixture has no route for ${req.method} ${pathOf(req.url)}` },
      }
    );
  }, []);

  const onNativeCommit = useCallback(() => {
    if (tCommit.current == null) tCommit.current = performance.now();
  }, []);

  const close = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    currentRun.current = -1;
    setMounted(false);
    setBusy(false);
  }, []);

  const open = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    // Unmount any previous instance first and let that commit, so every open
    // creates a brand-new WebView.
    if (timeout.current) clearTimeout(timeout.current);
    currentRun.current = -1;
    setMounted(false);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const id = Date.now();
    opensThisProcess += 1;
    openIndex.current = opensThisProcess;
    currentRun.current = id;
    tCommit.current = null;
    t0.current = performance.now();
    timeout.current = setTimeout(() => {
      if (currentRun.current !== id) return;
      record(null, null, `no onReady from the DOM component within ${NATIVE_TIMEOUT_MS / 1000} s`);
    }, NATIVE_TIMEOUT_MS);
    setRunId(id);
    setMounted(true);
  }, [busy, record]);

  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 26 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Max Pain (web page in DOM component)</Text>
        <View style={styles.row}>
          <Btn label={busy ? 'Opening...' : 'Open Max Pain'} onPress={open} primary disabled={busy} />
          <Btn label="Close" onPress={close} disabled={!mounted} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          <Text style={styles.label}>Fixtures</Text>
          <Chip label="in DOM" on={fixtureMode === 'dom'} onPress={() => setFixtureMode('dom')} disabled={busy} />
          <Chip label="via native bridge" on={fixtureMode === 'native'} onPress={() => setFixtureMode('native')} disabled={busy} />
          <Text style={styles.label}>Latency/req</Text>
          <Chip label="0 ms" on={latencyMs === 0} onPress={() => setLatencyMs(0)} disabled={busy} />
          <Chip label="150 ms" on={latencyMs === 150} onPress={() => setLatencyMs(150)} disabled={busy} />
        </ScrollView>
        <Text style={styles.result}>
          {latest == null
            ? 'Not opened yet. Each open is a fresh WebView; settings apply to the next open.'
            : latest.error
              ? `#${latest.openIndex} FAILED: ${latest.error}`
              : `#${latest.openIndex} open ${latest.openMs} ms (WebView ${latest.domMs} ms, native commit ${latest.nativeCommitMs ?? '-'} ms) | heap ${latest.memoryMb ?? 'n/a'} MB`}
          {latest != null && (
            <Text style={{ color: latest.pass ? C.up : C.down }}>{latest.pass ? '  PASS' : '  FAIL'}</Text>
          )}
        </Text>
      </View>
      <View style={styles.frame}>
        {mounted ? (
          <ToolFrame
            key={runId}
            runId={runId}
            fixtureMode={fixtureMode}
            latencyMs={latencyMs}
            onReady={onReady}
            serveRequest={serveRequest}
            onNativeCommit={onNativeCommit}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.muted}>
              Press Open Max Pain. Pass bar: open {'<='} {PASS.toolOpenMs} ms and JS heap {'<='} {PASS.toolMemoryMb} MB.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function Btn({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, primary && styles.btnPrimary, disabled && styles.disabled]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

function Chip({ label, on, onPress, disabled }: { label: string; on: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.chip, on && styles.chipOn, disabled && styles.disabled]}>
      <Text style={[styles.chipText, on && { color: C.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 12, paddingBottom: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { color: C.text, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: C.muted, fontSize: 12 },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 6,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  btnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  btnText: { color: C.text, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  chipOn: { borderColor: C.accent, backgroundColor: '#172338' },
  chipText: { color: C.muted, fontSize: 12 },
  result: { color: C.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  frame: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: C.muted, fontSize: 13, textAlign: 'center' },
});
