// THROWAWAY SPIKE. Types shared by the native chart screen and the 'use dom' chart.
// Type-only: the two sides run in different JS engines and share nothing at runtime,
// so everything that crosses the bridge must be plain JSON.

export type TickMode = 'dom' | 'bridge';

export type TradeSide = 'BUY' | 'SELL';

/** What the DOM sends when the on-chart BUY or SELL button is tapped. */
export interface TradeRequest {
  side: TradeSide;
  qty: number;
  price: number;
  symbol: string;
  exchange: string;
  /** Date.now() in the WebView at the tap, for tap -> native latency. */
  tappedAt: number;
}

/** A quote native forwards to the DOM in via-bridge mode (throttled to 4 Hz). */
export interface BridgeQuote {
  ltp: number;
  seq: number;
  /** Date.now() on the native side when the prop was set. */
  sentAt: number;
}

/** Same shape as FrameSummary in src/core/metrics.ts (copied, not shared). */
export interface DomFrameSummary {
  fps: number;
  p95FrameMs: number;
  maxFrameMs: number;
  slowPct: number;
  frozen: number;
  frames: number;
}

export interface LatencySummary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface DomMemory {
  supported: boolean;
  /** Chromium's performance.memory is coarse (bucketed) without a flag. */
  note?: string;
  startMb?: number;
  endMb?: number;
  peakMb?: number;
  limitMb?: number;
}

export interface PanBenchSummary {
  ok: boolean;
  error?: string;
  durationMs: number;
  frames: DomFrameSummary;
  longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number };
  memory: DomMemory;
  bars: number;
  visibleBars: number;
  panSweeps: number;
  tickMode: TickMode;
  ticksApplied: number;
  bridgeUpdates: number;
  /** ChartDom root renders during the bench (each prop change re-renders the DOM tree). */
  rootRenders: number;
  bridgeLatencyMs: LatencySummary | null;
  viewport: { w: number; h: number; dpr: number };
  mobileLayout: boolean;
}

/** Sent once per mount, after the first frame with candles has been painted. */
export interface ChartReadyInfo {
  ok: boolean;
  error?: string;
  bars: number;
  indicators: string[];
  mobileLayout: boolean;
  /** DOM-side timeline in ms since the WebView's navigation start (performance.now()). */
  dom: {
    moduleEvalMs: number;
    widgetReadyMs: number;
    firstDataMs: number;
    paintedMs: number;
    responseEndMs: number | null;
    domContentLoadedMs: number | null;
  };
  memoryMb: number | null;
  cssRules: number | null;
  viewport: { w: number; h: number; dpr: number };
  userAgent: string;
}
