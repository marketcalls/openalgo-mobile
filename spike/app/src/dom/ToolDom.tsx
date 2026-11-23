// THROWAWAY SPIKE. Renders the OpenAlgo web frontend's Max Pain page (frontend/src/pages/MaxPain.tsx, imported unchanged) inside an Expo DOM component and reports when its Plotly chart has actually drawn.
'use dom';

// Order matters: env must run before anything loads '@/api/client', which
// reads import.meta.env at module load (see tool/env.ts).
import { importMetaRegistryPreexisting } from './tool/env';
import './tool/tool.css';

import { type ComponentType, useEffect, useLayoutEffect } from 'react';
import { Toaster, type ToasterProps } from 'sonner';
import { pathOf, respond } from './tool/fixtures';
import { installSpikeTransport, setResponder, type WireRequest, type WireResponse, wireLog } from './tool/transport';

const T_MODULE = performance.now();

// Transport first: the page's first request is issued from a passive effect.
installSpikeTransport();

// The frontend modules, unchanged. Loaded with require() rather than `import`
// for two spike-layout reasons only: (1) they are guaranteed to evaluate after
// env.ts and the transport above, whatever import hoisting/lazy-import mode
// Metro uses; (2) the app's `tsc` does not pull frontend files into its
// program, where they cannot resolve react/axios/radix types because
// frontend/ has no node_modules (see CHANGES.tool.md, "typecheck").
/* eslint-disable @typescript-eslint/no-require-imports */
const MaxPain: ComponentType = require('@/pages/MaxPain').default;
const { useThemeStore } = require('@/stores/themeStore') as {
  useThemeStore: { getState(): { setMode(mode: 'light' | 'dark'): void } };
};
const { useAlertStore } = require('@/stores/alertStore') as {
  useAlertStore: <T>(
    sel: (s: { position: ToasterProps['position']; maxVisibleToasts: number; duration: number }) => T,
  ) => T;
};
/* eslint-enable @typescript-eslint/no-require-imports */

// Force the frontend's dark theme the way its own store does it (adds 'dark'
// to <html>, persisted to localStorage like on the web).
useThemeStore.getState().setMode('dark');
document.documentElement.classList.add('dark');

// Collect long tasks (>50 ms main-thread blocks) from page start.
const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(e.duration);
  }).observe({ type: 'longtask', buffered: true });
} catch {
  // not supported: reported as null below
}
const longTasksSupported = (() => {
  try {
    return PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  } catch {
    return false;
  }
})();

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message ?? e)));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandledrejection: ${String(e.reason)}`));

export interface ToolReadyPayload {
  runId: number;
  ok: boolean;
  error: string | null;
  /** performance.now() in the WebView when the plot was on screen (0 = WebView navigation start). */
  msSinceDomStart: number;
  memoryMb: number | null;
  heap: { usedMb: number; totalMb: number; limitMb: number } | null;
  marks: {
    // Bundle loaded and parsed; Expo DOM runtime, React and sonner evaluated.
    // The frontend modules and Plotly are evaluated right AFTER this mark.
    moduleEvalMs: number;
    firstCommitMs: number | null; // React committed the first tree (frontend + Plotly evaluated by then)
    maxPainResponseMs: number | null; // fixture answer for POST /oitracker/api/maxpain delivered
    plotMs: number; // bars found in the DOM, then two animation frames
  };
  nav: Record<string, number> | null;
  longTasks: { count: number; totalMs: number; maxMs: number } | null;
  wire: { method: string; path: string; status: number; startMs: number; ms: number; via: string }[];
  bars: number;
  viewport: { width: number; height: number; dpr: number };
  importMetaRegistryPreexisting: boolean;
  pageErrors: string[];
}

interface Props {
  runId: number;
  fixtureMode: 'dom' | 'native';
  latencyMs: number;
  onReady: (p: ToolReadyPayload) => Promise<void>;
  /** Native action: answers a request on the React Native side (fixtureMode 'native'). */
  serveRequest: (req: WireRequest) => Promise<WireResponse>;
  dom?: import('expo/dom').DOMProps;
}

// Each native mount is a fresh WebView (fresh JS context), so these reset per
// open. On web (expo start --web) DOM components render inline, hence runId.
let firstCommitMs: number | null = null;
let readySentFor = -1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domResponder(latencyMs: number) {
  return async (req: WireRequest): Promise<WireResponse> => {
    if (latencyMs > 0) await sleep(latencyMs);
    return (
      respond(req) ?? {
        status: 404,
        body: { status: 'error', message: `spike fixture has no route for ${req.method} ${pathOf(req.url)}` },
      }
    );
  };
}

function countBars() {
  return document.querySelectorAll('.js-plotly-plot .barlayer .point path').length;
}

/** Resolves once Plotly has drawn bars, after two more frames so they are painted. */
function waitForPlot(timeoutMs: number): Promise<{ ok: boolean; bars: number }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearTimeout(timer);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ok, bars: countBars() })));
    };
    const obs = new MutationObserver(() => {
      if (countBars() > 0) finish(true);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (countBars() > 0) finish(true);
  });
}

function heapInfo() {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!m || !m.usedJSHeapSize) return null;
  const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
  return { usedMb: mb(m.usedJSHeapSize), totalMb: mb(m.totalJSHeapSize), limitMb: mb(m.jsHeapSizeLimit) };
}

function navInfo(): Record<string, number> | null {
  const n = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  if (!n) return null;
  const r = (x: number) => Math.round(x);
  return {
    responseEnd: r(n.responseEnd),
    domInteractive: r(n.domInteractive),
    domContentLoaded: r(n.domContentLoadedEventEnd),
    loadEventEnd: r(n.loadEventEnd),
  };
}

export default function ToolDom({ runId, fixtureMode, latencyMs, onReady, serveRequest }: Props) {
  // Layout effects run before any passive effect, so the responder is in place
  // before MaxPain's fetch effects fire (the transport also queues until set).
  useLayoutEffect(() => {
    if (firstCommitMs == null) firstCommitMs = Math.round(performance.now());
    setResponder(
      fixtureMode === 'native'
        ? async (req) => serveRequest(req)
        : domResponder(latencyMs),
    );
  }, [fixtureMode, latencyMs, serveRequest]);

  useEffect(() => {
    if (readySentFor === runId) return;
    readySentFor = runId;
    waitForPlot(20_000).then(({ ok, bars }) => {
      const plotMs = Math.round(performance.now());
      const heap = heapInfo();
      const mp = wireLog.find((w) => w.path === '/oitracker/api/maxpain');
      const lt = longTasksSupported
        ? {
            count: longTasks.length,
            totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
            maxMs: Math.round(longTasks.reduce((a, b) => Math.max(a, b), 0)),
          }
        : null;
      onReady({
        runId,
        ok,
        error: ok ? null : `no Plotly bars after 20 s (${errors.length} page errors)`,
        msSinceDomStart: plotMs,
        memoryMb: heap ? heap.usedMb : null,
        heap,
        marks: {
          moduleEvalMs: Math.round(T_MODULE),
          firstCommitMs,
          maxPainResponseMs: mp ? mp.startMs + mp.ms : null,
          plotMs,
        },
        nav: navInfo(),
        longTasks: lt,
        wire: wireLog.slice(),
        bars,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        importMetaRegistryPreexisting,
        pageErrors: errors.slice(0, 10),
      }).catch(() => {});
    });
  }, [runId, onReady]);

  // Same Toaster settings the web app's Providers read from alertStore.
  const position = useAlertStore((s) => s.position);
  const maxVisibleToasts = useAlertStore((s) => s.maxVisibleToasts);
  const duration = useAlertStore((s) => s.duration);

  // Mirrors the web Layout's <main className="container mx-auto px-4 py-6 ...">
  // (MaxPain adds its own py-6); the Navbar/Footer/bottom nav are not reused.
  return (
    <div className="min-h-screen w-full min-w-0 bg-background text-foreground">
      <main className="container mx-auto px-4 pb-6">
        <MaxPain />
      </main>
      <Toaster
        theme="dark"
        position={position}
        richColors
        visibleToasts={maxVisibleToasts}
        duration={duration}
        closeButton
      />
    </div>
  );
}
