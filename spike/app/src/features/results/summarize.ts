// THROWAWAY SPIKE. Pulls the headline numbers out of a bench result and builds the JSON the maintainer copies back.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { mountedDom } from '~/core/bench';
import { deviceInfo, type FrameSummary, getStartup } from '~/core/metrics';
import { type BenchResult, PASS } from '~/core/results';
import { useSettings } from '~/core/settings';

const BASE_KEYS = new Set(['durationMs', 'js', 'ui', 'ticksPerSec', 'flushesPerSec']);

function isFrameSummary(x: unknown): x is FrameSummary {
  return !!x && typeof x === 'object' && typeof (x as FrameSummary).fps === 'number';
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 100 ? 0 : 1));

export interface KeyNumber {
  label: string;
  value: string;
}

/**
 * Headline numbers for one result. UI and JS thread numbers come from runBench's
 * frame window (absent for tool-open results). Anything else a screen put in
 * metrics (DOM fps, open ms, memory...) is shown generically, because each
 * screen names its own keys; nested detail stays in the expanded raw JSON.
 */
export function keyNumbers(r: BenchResult): KeyNumber[] {
  const m = r.metrics;
  const out: KeyNumber[] = [];
  const ui = isFrameSummary(m.ui) ? m.ui : null;
  const js = isFrameSummary(m.js) ? m.js : null;
  const windowed = 'js' in m || 'ui' in m; // tool-open results have no frame window
  if (windowed) out.push({ label: 'UI fps', value: ui ? String(ui.fps) : 'n/a' });
  if (ui) out.push({ label: 'UI slow', value: `${fmt(ui.slowPct)}%` });
  if (ui) out.push({ label: 'UI p95', value: `${ui.p95FrameMs} ms` });
  if (windowed) out.push({ label: 'JS fps', value: js ? String(js.fps) : 'n/a' });
  if (js) out.push({ label: 'JS slow', value: `${fmt(js.slowPct)}%` });
  if (js && js.frozen) out.push({ label: 'JS frozen', value: String(js.frozen) });
  if (ui && ui.frozen) out.push({ label: 'UI frozen', value: String(ui.frozen) });
  if (typeof m.ticksPerSec === 'number') out.push({ label: 'ticks/s', value: String(m.ticksPerSec) });
  if (typeof m.flushesPerSec === 'number') out.push({ label: 'flushes/s', value: String(m.flushesPerSec) });

  for (const [k, v] of Object.entries(m)) {
    if (BASE_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ label: k, value: fmt(v) });
    else if (v === null) out.push({ label: k, value: 'n/a' });
    else if (typeof v === 'boolean') out.push({ label: k, value: v ? 'yes' : 'no' });
    else if (isFrameSummary(v)) pushFrames(out, k, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // One level down, e.g. a DOM bench summary { frames: FrameSummary, ok, error }.
      const o = v as Record<string, unknown>;
      for (const v2 of Object.values(o)) if (isFrameSummary(v2)) pushFrames(out, k, v2);
      if (o.ok === false && typeof o.error === 'string') out.push({ label: `${k} error`, value: o.error });
    }
  }
  return out;
}

function pushFrames(out: KeyNumber[], k: string, v: FrameSummary) {
  out.push({ label: `${k} fps`, value: String(v.fps) });
  if (typeof v.slowPct === 'number') out.push({ label: `${k} slow`, value: `${fmt(v.slowPct)}%` });
}

/** Feed settings a result was recorded with, as one short line. */
export function settingsLine(r: BenchResult): string {
  const st = r.settings;
  const feed = st.feedMode === 'ws' ? 'ws' : st.feedMode === 'sim' ? `sim ${String(st.simRate ?? '?')}/s` : String(st.feedMode ?? '?');
  return `${feed} · flush ${String(st.flushMode ?? '?')}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const STARTUP_NOTE =
  'From React Native startup markers. On Android RN 0.88 logs its "start" marker when it begins loading the JS bundle ' +
  '(ReactInstance::loadScript), so both numbers leave out process start, native init and Hermes runtime creation: ' +
  'they are lower bounds, not true cold start. First render is taken in the root layout effect, which can run ' +
  'slightly before the first frame reaches the screen, and it includes mounting all five tabs (NativeTabs mounts ' +
  'every tab eagerly; the chart WebView is deferred until the Chart tab is first opened). The numbers come from ' +
  'this process launch, so force-stop ' +
  'the app before reopening to get a cold value; returning to a backgrounded app does not update them.';

function buildInfo() {
  const g = globalThis as {
    HermesInternal?: { getRuntimeProperties?: () => Record<string, unknown> };
    nativeFabricUIManager?: unknown;
  };
  let hermes: Record<string, unknown> | null = null;
  try {
    const props = g.HermesInternal?.getRuntimeProperties?.();
    if (props) {
      hermes = {};
      for (const [k, v] of Object.entries(props)) if (typeof v !== 'object') hermes[k] = v;
    } else if (g.HermesInternal) hermes = {};
  } catch {
    hermes = g.HermesInternal ? {} : null;
  }
  // Platform.constants is undefined on web; guard so Copy can never throw here.
  const rnv = (Platform.constants as { reactNativeVersion?: { major: number; minor: number; patch: number } } | undefined)
    ?.reactNativeVersion;
  return {
    dev: __DEV__,
    appVersion: Constants.expoConfig?.version ?? null,
    reactNative: rnv ? `${rnv.major}.${rnv.minor}.${rnv.patch}` : null,
    hermes,
    fabric: typeof g.nativeFabricUIManager !== 'undefined',
  };
}

export function deviceExtra() {
  return {
    isPhysicalDevice: Device.isDevice,
    brand: Device.brand,
    apiLevel: Device.platformApiLevel,
    cpuAbis: Device.supportedCpuArchitectures,
  };
}

/** Everything the maintainer pastes back. The API key and WebSocket URL are deliberately left out. */
export function buildExport(results: BenchResult[]) {
  const s = useSettings.getState();
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  return {
    kind: 'openalgo-rn-expo-spike-results',
    exportedAt: new Date().toISOString(),
    build: buildInfo(),
    device: { ...deviceInfo(), ...deviceExtra() },
    startup: { ...(getStartup() ?? { jsToFirstRenderMs: null, rnStartMarkerToFirstRenderMs: null, raw: null }), note: STARTUP_NOTE },
    // Only the state: the status detail can carry the WebSocket URL.
    settingsNow: {
      feedMode: s.feedMode,
      simRate: s.feedMode === 'sim' ? s.simRate : null,
      flushMode: s.flushMode,
      feedState: s.status.state,
      domMounted: mountedDom(),
    },
    passThresholds: PASS,
    summary: { total: results.length, passed, failed, unjudged: results.length - passed - failed },
    results,
  };
}
