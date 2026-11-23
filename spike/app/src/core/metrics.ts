// THROWAWAY SPIKE. Frame metrics for release builds (the RN perf monitor is dev-only).
//
// JS thread: a requestAnimationFrame loop. When the JS thread is busy decoding
// ticks or rendering, rAF callbacks arrive late, so long gaps mean JS jank
// (touch handlers, list cell creation, tick processing all stall).
// UI thread: Reanimated's useFrameCallback runs a worklet on the UI thread every
// frame (see UiFpsProbe). Long gaps there mean visible jank (scrolling stutters).
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { takeStoreCounters } from './tickStore';

export interface FrameSummary {
  fps: number;
  p95FrameMs: number;
  maxFrameMs: number;
  slowPct: number; // frames over 1.5x the 60 Hz budget (25 ms)
  frozen: number; // frames over 100 ms
  frames: number;
}

export interface UiCounters {
  frames: { value: number };
  sum: { value: number };
  max: { value: number };
  slow: { value: number };
  frozen: { value: number };
  hist: { value: number[] }; // buckets of 4 ms up to 100 ms
}

let uiCounters: UiCounters | null = null;
export function registerUiCounters(c: UiCounters | null) {
  uiCounters = c;
}

function resetUi() {
  if (!uiCounters) return;
  uiCounters.frames.value = 0;
  uiCounters.sum.value = 0;
  uiCounters.max.value = 0;
  uiCounters.slow.value = 0;
  uiCounters.frozen.value = 0;
  uiCounters.hist.value = new Array(26).fill(0);
}

function readUi(): FrameSummary | null {
  if (!uiCounters) return null;
  const frames = uiCounters.frames.value;
  if (!frames) return null;
  const hist = uiCounters.hist.value;
  let acc = 0;
  let p95 = 100;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= frames * 0.95) {
      p95 = (i + 1) * 4;
      break;
    }
  }
  return {
    fps: Math.round((frames * 1000) / uiCounters.sum.value),
    p95FrameMs: p95,
    maxFrameMs: Math.round(uiCounters.max.value),
    slowPct: Math.round((uiCounters.slow.value / frames) * 1000) / 10,
    frozen: uiCounters.frozen.value,
    frames,
  };
}

// --- JS thread sampler -------------------------------------------------------
let jsDeltas: number[] = [];
let lastJs = 0;
let jsRunning = false;
function jsLoop(t: number) {
  if (lastJs) jsDeltas.push(t - lastJs);
  lastJs = t;
  if (jsDeltas.length > 20_000) jsDeltas = jsDeltas.slice(-10_000);
  if (jsRunning) requestAnimationFrame(jsLoop);
}
export function startJsSampler() {
  if (jsRunning) return;
  jsRunning = true;
  lastJs = 0;
  requestAnimationFrame(jsLoop);
}

export function summarize(deltas: number[]): FrameSummary {
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

// --- Measurement windows -----------------------------------------------------
export interface WindowResult {
  durationMs: number;
  js: FrameSummary;
  ui: FrameSummary | null;
  ticksPerSec: number;
  flushesPerSec: number;
}

let windowStart = 0;
export function beginWindow() {
  jsDeltas = [];
  lastJs = 0;
  resetUi();
  takeStoreCounters();
  windowStart = performance.now();
}

export function endWindow(): WindowResult {
  const durationMs = performance.now() - windowStart;
  const c = takeStoreCounters();
  return {
    durationMs: Math.round(durationMs),
    js: summarize(jsDeltas),
    ui: readUi(),
    ticksPerSec: Math.round((c.ticksIn * 1000) / durationMs),
    flushesPerSec: Math.round((c.flushes * 1000) / durationMs),
  };
}

/** Live HUD numbers over the last ~1 s without disturbing a running window. */
export function peekLive(): { jsFps: number; uiFps: number | null } {
  const recent = jsDeltas.slice(-60);
  const js = summarize(recent);
  const ui = readUi();
  return { jsFps: js.fps, uiFps: ui ? ui.fps : null };
}

// --- Startup -----------------------------------------------------------------
export interface StartupResult {
  jsToFirstRenderMs: number | null;
  /**
   * From rnStartupTiming.startTime to the root layout's first effect. On Android
   * RN 0.88 logs that start marker in ReactInstance::loadScript (when the JS
   * bundle starts loading), so this EXCLUDES process start, native init and Hermes
   * runtime creation: a lower bound, not cold start. Renamed from
   * nativeStartToFirstRenderMs, which overstated what it covers.
   */
  rnStartMarkerToFirstRenderMs: number | null;
  raw: Record<string, number | null> | null;
}

let startup: StartupResult | null = null;
export function markFirstRender() {
  if (startup) return startup;
  const now = performance.now();
  const perf = performance as unknown as { rnStartupTiming?: Record<string, number | null> };
  const t = perf.rnStartupTiming ?? null;
  const raw = t
    ? {
        startTime: t.startTime ?? null,
        initializeRuntimeStart: t.initializeRuntimeStart ?? null,
        executeJavaScriptBundleEntryPointStart: t.executeJavaScriptBundleEntryPointStart ?? null,
        endTime: t.endTime ?? null,
        firstRender: now,
      }
    : null;
  startup = {
    jsToFirstRenderMs: raw?.executeJavaScriptBundleEntryPointStart != null
      ? Math.round(now - raw.executeJavaScriptBundleEntryPointStart)
      : null,
    rnStartMarkerToFirstRenderMs: raw?.startTime != null ? Math.round(now - raw.startTime) : null,
    raw,
  };
  return startup;
}
export const getStartup = () => startup;

export function deviceInfo() {
  return {
    platform: Platform.OS,
    osVersion: Device.osVersion,
    model: Device.modelName,
    manufacturer: Device.manufacturer,
    yearClass: Device.deviceYearClass,
    totalMemoryMb: Device.totalMemory ? Math.round(Device.totalMemory / 1048576) : null,
  };
}
