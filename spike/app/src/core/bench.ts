// THROWAWAY SPIKE. Scripted, repeatable benchmark runs: the same automated
// interaction on every phone, so numbers are comparable across devices.
import { useSettings } from './settings';
import { beginWindow, deviceInfo, endWindow, type WindowResult } from './metrics';
import { PASS, useResults } from './results';

export interface BenchOptions {
  scenario: string;
  durationMs?: number;
  /** Called every frame with elapsed ms; drive scrolling/panning from here. */
  drive?: (elapsedMs: number) => void;
  /** Optional extra numbers (e.g. DOM-side fps) merged into the result. */
  collectExtra?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Custom pass rule; default is the native-screen rule. */
  pass?: (w: WindowResult, extra: Record<string, unknown>) => boolean;
}

export function nativePass(w: WindowResult) {
  return (
    (w.ui?.fps ?? 0) >= PASS.nativeUiFps &&
    w.js.fps >= PASS.nativeJsFps &&
    (w.ui?.slowPct ?? 100) <= PASS.nativeSlowPctMax
  );
}

let running = false;
export const isBenchRunning = () => running;

// Which DOM components (WebViews) are alive while a result is recorded. Every tab is
// mounted eagerly by NativeTabs, and a live WebView costs memory and some CPU, so a
// native-screen number taken with the chart WebView alive is not the same
// condition as one taken without it. Recorded in every result's settings.
const liveDom = new Set<string>();
export function setDomMounted(name: string, mounted: boolean) {
  if (mounted) liveDom.add(name);
  else liveDom.delete(name);
}
export const mountedDom = () => Array.from(liveDom).sort();

/** The run conditions every result records. simRate only means something in sim mode. */
export function runConditions() {
  const s = useSettings.getState();
  return {
    feedMode: s.feedMode,
    simRate: s.feedMode === 'sim' ? s.simRate : null,
    flushMode: s.flushMode,
    // Hidden Watchlist/Chain/Chart-header rows stop subscribing to ticks (QuotesPausedContext).
    hiddenTabsPaused: true,
    domMounted: mountedDom(),
    device: deviceInfo(),
  };
}

/**
 * Runs one scripted window. Never leaves `running` stuck: if drive() or
 * collectExtra() throws, the run is recorded as a failed result with the error
 * and later benches still work.
 */
export async function runBench(opts: BenchOptions): Promise<void> {
  if (running) return;
  running = true;
  const settings = runConditions();
  try {
    const duration = opts.durationMs ?? 20_000;
    // Let the screen settle before measuring.
    await new Promise((r) => setTimeout(r, 1000));
    beginWindow();
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const step = () => {
        const el = performance.now() - t0;
        if (el >= duration) return resolve();
        try {
          opts.drive?.(el);
        } catch (e) {
          return reject(e);
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const w = endWindow();
    const extra = (await opts.collectExtra?.()) ?? {};
    useResults.getState().add({
      scenario: opts.scenario,
      settings,
      metrics: { ...w, ...extra },
      pass: (opts.pass ?? nativePass)(w, extra),
    });
  } catch (e) {
    useResults.getState().add({
      scenario: opts.scenario,
      settings,
      metrics: { error: e instanceof Error ? e.message : String(e) },
      pass: false,
      notes: 'The bench threw before it finished; no frame numbers were recorded.',
    });
  } finally {
    running = false;
  }
}
