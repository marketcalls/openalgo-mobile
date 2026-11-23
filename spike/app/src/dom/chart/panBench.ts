// THROWAWAY SPIKE. Scripted pan benchmark that runs inside the WebView: it moves the
// chart's visible logical range every frame (back and forth through history) and
// measures the WebView's own frames, long tasks and heap, because the DOM runs in a
// different JS engine than the native frame probes.
import type { Chart } from 'openalgo-charts';
import type { DomFrameSummary, DomMemory, LatencySummary, PanBenchSummary, TickMode } from './types';

/** Copied from src/core/metrics.ts summarize() (no module state is shared across engines). */
export function summarize(deltas: number[]): DomFrameSummary {
  if (!deltas.length) return { fps: 0, p95FrameMs: 0, maxFrameMs: 0, slowPct: 0, frozen: 0, frames: 0 };
  const sorted = [...deltas].sort((a, b) => a - b);
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    fps: Math.round((deltas.length * 1000) / sum),
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
    maxFrameMs: Math.round(sorted[sorted.length - 1]),
    slowPct: Math.round((deltas.filter((d) => d > 25).length / deltas.length) * 1000) / 10,
    frozen: deltas.filter((d) => d > 100).length,
    frames: deltas.length,
  };
}

export function latency(samples: number[]): LatencySummary | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Math.round(s[Math.floor(s.length * 0.5)]),
    p95: Math.round(s[Math.floor(s.length * 0.95)]),
    max: Math.round(s[s.length - 1]),
  };
}

interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function heapMb(): { used: number; limit: number } | null {
  const m = (performance as unknown as { memory?: PerfMemory }).memory;
  if (!m || !m.usedJSHeapSize) return null;
  return { used: m.usedJSHeapSize / 1048576, limit: m.jsHeapSizeLimit / 1048576 };
}

const mb = (x: number) => Math.round(x * 10) / 10;

export interface BenchCounters {
  ticks: () => number;
  bridgeUpdates: () => number;
  rootRenders: () => number;
  /** Bridged-quote latencies recorded since `since` (index into the sample array). */
  bridgeLatencies: () => number[];
  tickMode: () => TickMode;
  mobileLayout: () => boolean;
}

export function runPanBench(chart: Chart, durationMs: number, c: BenchCounters): Promise<PanBenchSummary> {
  return new Promise((resolve) => {
    const bars = chart.dataLayer.length;
    const start = chart.getVisibleLogicalRange();
    const width = Math.max(60, Math.min(240, Math.round((start?.to ?? 120) - (start?.from ?? 0)) || 120));
    const maxFrom = Math.max(0, bars - width);
    const sweepMs = 5000; // one direction: newest -> oldest takes 5 s

    // Long tasks (Chromium WebView supports 'longtask'; other engines may not).
    const longTasks = { supported: false, count: 0, totalMs: 0, maxMs: 0 };
    let po: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longTasks.count++;
            longTasks.totalMs += e.duration;
            longTasks.maxMs = Math.max(longTasks.maxMs, e.duration);
          }
        });
        po.observe({ type: 'longtask' });
        longTasks.supported = true;
      }
    } catch {
      po = null;
    }

    const mem0 = heapMb();
    let peak = mem0?.used ?? 0;
    const ticks0 = c.ticks();
    const bridge0 = c.bridgeUpdates();
    const renders0 = c.rootRenders();
    const lat0 = c.bridgeLatencies().length;

    const deltas: number[] = [];
    let last = 0;
    let t0 = 0;
    let lastMem = 0;

    const finish = () => {
      try {
        po?.disconnect();
      } catch {}
      try {
        if (start) chart.setVisibleLogicalRange(start);
      } catch {}
      const mem1 = heapMb();
      if (mem1) peak = Math.max(peak, mem1.used);
      const memory: DomMemory = mem1
        ? {
            supported: true,
            note: 'performance.memory (Chromium, coarse)',
            startMb: mem0 ? mb(mem0.used) : undefined,
            endMb: mb(mem1.used),
            peakMb: mb(peak),
            limitMb: mb(mem1.limit),
          }
        : { supported: false };
      const elapsed = performance.now() - t0;
      const ticksApplied = c.ticks() - ticks0;
      resolve({
        ok: true,
        durationMs: Math.round(elapsed),
        frames: summarize(deltas),
        longTasks: { ...longTasks, totalMs: Math.round(longTasks.totalMs), maxMs: Math.round(longTasks.maxMs) },
        memory,
        bars,
        visibleBars: width,
        panSweeps: Math.round((elapsed / sweepMs) * 10) / 10,
        tickMode: c.tickMode(),
        ticksApplied,
        bridgeUpdates: c.bridgeUpdates() - bridge0,
        rootRenders: c.rootRenders() - renders0,
        bridgeLatencyMs: latency(c.bridgeLatencies().slice(lat0)),
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        mobileLayout: c.mobileLayout(),
      });
    };

    const step = (t: number) => {
      if (!t0) {
        t0 = performance.now();
        lastMem = t0;
      }
      if (last) deltas.push(t - last);
      last = t;
      const el = performance.now() - t0;
      if (el >= durationMs) return finish();
      // Triangle wave: start at the newest bars, sweep to the oldest, come back.
      const phase = (el / sweepMs) % 2;
      const x = phase < 1 ? phase : 2 - phase;
      const from = maxFrom * (1 - x);
      chart.setVisibleLogicalRange({ from, to: from + width });
      if (el - (lastMem - t0) >= 1000) {
        lastMem = performance.now();
        const m = heapMb();
        if (m) peak = Math.max(peak, m.used);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
