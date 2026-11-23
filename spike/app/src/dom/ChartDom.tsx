'use dom';
// THROWAWAY SPIKE. The chart as an Expo DOM component: renders the OpenAlgo web
// frontend's OpenAlgoChart unchanged (openalgo-charts widget, mobile: 'auto'), adds
// built-in indicators and the BuySellButtons primitive the /trading terminal uses,
// and reports open time and pan-bench numbers to native. The DOM never places an
// order and holds no credentials: a BUY/SELL tap only calls the native onTrade prop.
import './chart/chart.css';
import './chart/eagerChunks';

import { type DOMImperativeFactory, type DOMProps, useDOMImperativeHandle } from 'expo/dom';
import { BuySellButtons } from 'openalgo-charts';
import type { Widget } from 'openalgo-charts/widget';
import { type Ref, useEffect, useRef, useState } from 'react';
import { type ChartDataEvent, OpenAlgoChart } from '@/components/chart/OpenAlgoChart';
import { useThemeStore } from '@/stores/themeStore';
import { heapMb, runPanBench } from './chart/panBench';
import { SpikeFeed } from './chart/spikeFeed';
import type { BridgeQuote, ChartReadyInfo, PanBenchSummary, TickMode, TradeRequest } from './chart/types';

const T_MODULE = performance.now();
// The frontend's theme store drives buildChartTheme(); dark before the widget is built.
useThemeStore.getState().setMode('dark');

const INTERVALS = ['1m', '5m', '15m', '1h'] as const;

// Counters read by the pan bench. Module scope is fine: one chart per WebView.
let rootRenders = 0;
let bridgeUpdates = 0;
const bridgeLatencies: number[] = [];

export interface ChartDomRef extends DOMImperativeFactory {
  /** Arguments arrive as JSON from native; typed unknown to fit DOMImperativeFactory. */
  startPanBench: (durationMs: unknown) => void;
}

interface Props {
  ref?: Ref<ChartDomRef>;
  dom?: DOMProps;
  symbol: string;
  exchange: string;
  /** Last close of the synthetic history (native's quote at mount). Read once. */
  basePrice: number;
  tickMode: TickMode;
  /** False while the tab is hidden: the in-DOM simulator pauses. */
  active: boolean;
  qty: number;
  bridgeQuote: BridgeQuote | null;
  onReady: (info: ChartReadyInfo) => Promise<void>;
  onTrade: (req: TradeRequest) => Promise<void>;
  onBenchDone: (summary: PanBenchSummary) => Promise<void>;
  onError: (message: string) => Promise<void>;
}

function navTiming() {
  const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  return {
    responseEndMs: nav ? Math.round(nav.responseEnd) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
  };
}

function cssRuleCount(): number | null {
  try {
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) n += sheet.cssRules.length;
    return n;
  } catch {
    return null;
  }
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio });

export default function ChartDom(props: Props) {
  rootRenders++;
  const latest = useRef(props);
  latest.current = props;

  const [feed] = useState(() => new SpikeFeed(props.basePrice));
  const widgetRef = useRef<Widget | null>(null);
  const btnsRef = useRef<BuySellButtons | null>(null);
  const readySent = useRef(false);
  const marks = useRef({ widget: 0, data: 0 });
  const benchRunning = useRef(false);

  const report = (msg: string) => {
    latest.current.onError(msg).catch(() => {});
  };

  // Surface DOM errors on the native screen (release builds have no console).
  useEffect(() => {
    const onErr = (e: ErrorEvent) => report(`DOM error: ${e.message}`);
    const onRej = (e: PromiseRejectionEvent) => report(`DOM rejection: ${String(e.reason?.message ?? e.reason)}`);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  useEffect(() => () => feed.dispose(), [feed]);

  // In-DOM simulator only in 'dom' mode and while the tab is visible.
  useEffect(() => {
    feed.setSimRunning(props.active && props.tickMode === 'dom');
  }, [feed, props.active, props.tickMode]);

  // Via-bridge mode: every new prop value is one tick on the live candle.
  const seq = props.bridgeQuote?.seq;
  useEffect(() => {
    const q = latest.current.bridgeQuote;
    if (!q || latest.current.tickMode !== 'bridge' || !latest.current.active) return;
    bridgeUpdates++;
    bridgeLatencies.push(Date.now() - q.sentAt);
    if (bridgeLatencies.length > 5000) bridgeLatencies.splice(0, 2500);
    feed.applyPrice(q.ltp);
  }, [feed, seq]);

  useEffect(() => {
    btnsRef.current?.setQty(props.qty);
  }, [props.qty]);

  const onWidget = (widget: Widget | null) => {
    widgetRef.current = widget;
    if (!widget) {
      btnsRef.current = null;
      feed.onPrice = null;
      return;
    }
    marks.current.widget = performance.now();
    const chart = widget.chart;
    // NSE equity tick, as terminal.ts does, so prices print with two decimals.
    try {
      chart.setPriceScaleOptions({ minMove: 0.05 });
    } catch (e) {
      report(`setPriceScaleOptions failed: ${(e as Error).message}`);
    }
    // Built-in studies from the openalgo-charts indicators tier (OpenAlgoChart has
    // already imported it). The widget's own Indicators picker and the legend's x
    // add and remove more on the phone.
    try {
      chart.addIndicator('ema', { length: 20 });
      chart.addIndicator('ema', { length: 50 });
      chart.addIndicator('rsi', { length: 14 });
    } catch (e) {
      report(`addIndicator failed: ${(e as Error).message}`);
    }
    // The /trading terminal's inline SELL | qty | BUY panel (terminal.ts buildChart),
    // larger for touch. Its mark follows the live price.
    const btns = new BuySellButtons({
      id: 'trade',
      position: 'top-left',
      margin: { x: 8, y: 64 },
      qty: latest.current.qty,
      scale: 1,
    });
    btns.setMark(feed.lastPrice);
    chart.addPrimitive(btns, 0);
    btnsRef.current = btns;
    feed.onPrice = (px) => btns.setMark(px);
    chart.subscribeClick((id) => {
      if (id !== 'trade:buy' && id !== 'trade:sell') return;
      const p = latest.current;
      p.onTrade({
        side: id === 'trade:buy' ? 'BUY' : 'SELL',
        qty: p.qty,
        price: feed.lastPrice,
        symbol: widget.symbol(),
        exchange: widget.exchange(),
        tappedAt: Date.now(),
      }).catch(() => {});
    });
  };

  const onData = (e: ChartDataEvent) => {
    if (e.error) report(`chart data: ${e.error}`);
    if (readySent.current || e.bars <= 0) return;
    readySent.current = true;
    marks.current.data = performance.now();
    // Two frames: the first lets the engine paint the candles, the second runs after it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const w = widgetRef.current;
        const info: ChartReadyInfo = {
          ok: true,
          bars: w?.chart.dataLayer.length ?? e.bars,
          indicators: w ? w.chart.indicators().map((i) => i.indicatorId) : [],
          mobileLayout: w?.root.dataset.mobile === 'true',
          dom: {
            moduleEvalMs: Math.round(T_MODULE),
            widgetReadyMs: Math.round(marks.current.widget),
            firstDataMs: Math.round(marks.current.data),
            paintedMs: Math.round(performance.now()),
            ...navTiming(),
          },
          memoryMb: heapMb() ? Math.round(heapMb()!.used * 10) / 10 : null,
          cssRules: cssRuleCount(),
          viewport: viewport(),
          userAgent: navigator.userAgent,
        };
        latest.current.onReady(info).catch(() => {});
      }),
    );
  };

  useDOMImperativeHandle(
    props.ref as Ref<ChartDomRef>,
    () => ({
      startPanBench(durationMs: unknown) {
        const w = widgetRef.current;
        const fail = (error: string) =>
          latest.current
            .onBenchDone({
              ok: false,
              error,
              durationMs: 0,
              frames: { fps: 0, p95FrameMs: 0, maxFrameMs: 0, slowPct: 0, frozen: 0, frames: 0 },
              longTasks: { supported: false, count: 0, totalMs: 0, maxMs: 0 },
              memory: { supported: false },
              bars: 0,
              visibleBars: 0,
              panSweeps: 0,
              tickMode: latest.current.tickMode,
              ticksApplied: 0,
              bridgeUpdates: 0,
              rootRenders: 0,
              bridgeLatencyMs: null,
              viewport: viewport(),
              mobileLayout: false,
            })
            .catch(() => {});
        if (!w || w.isDestroyed) return void fail('chart not ready');
        if (benchRunning.current) return void fail('bench already running');
        benchRunning.current = true;
        runPanBench(w.chart, Number(durationMs) || 20_000, {
          ticks: () => feed.ticks,
          bridgeUpdates: () => bridgeUpdates,
          rootRenders: () => rootRenders,
          bridgeLatencies: () => bridgeLatencies,
          tickMode: () => latest.current.tickMode,
          mobileLayout: () => w.root.dataset.mobile === 'true',
        })
          .then((summary) => latest.current.onBenchDone(summary))
          .catch((e) => fail(String((e as Error)?.message ?? e)))
          .finally(() => {
            benchRunning.current = false;
          });
      },
    }),
    [],
  );

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <OpenAlgoChart
        feed={feed}
        symbol={props.symbol}
        exchange={props.exchange}
        interval="5m"
        intervals={INTERVALS}
        topbar
        indicators
        rail
        statusline
        volume
        onReady={onWidget}
        onData={onData}
      />
    </div>
  );
}
