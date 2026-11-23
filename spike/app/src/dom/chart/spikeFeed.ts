// THROWAWAY SPIKE. In-DOM DataFeed for the chart: deterministic synthetic history
// (2,000 bars per interval) plus a live tick simulator, so the chart can be measured
// without a server. Runs inside the WebView only. It never touches the network.
//
// Honest-numbers notes:
// - History is continuous 24x7 bars (no NSE session gaps), seeded, so every phone
//   draws the same candles. Its last close is the price native passed at mount.
// - getBars returns the whole 2,000-bar series for any request that reaches the
//   live end (the engine asks for ~500 by default), so the pan bench sweeps a fixed
//   2,000-bar dataset without paging. Older pages return [] (history exhausted).
// - The sim clock runs SIM_SPEED times faster than the wall clock so a 5-minute
//   candle rolls every 10 s of real time. Bar times therefore run ahead of the wall
//   clock after a while; the engine's bar-close countdown will look odd.
import type { Bar, BarSubscriptionOptions, BarsRequest, DataFeed, UnsubscribeFn } from 'openalgo-charts';
import { tryResolveInterval } from 'openalgo-charts';

export const HISTORY_BARS = 2000;
export const SIM_SPEED = 30; // simulated seconds per real second
export const SIM_TICK_HZ = 5; // in-DOM ticks per second
const TICK_SIZE = 0.05;

const roundTick = (x: number) => Math.round(x / TICK_SIZE) * TICK_SIZE;
const fix = (x: number) => Math.round(x * 100) / 100;

function xorshift(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function intervalSeconds(code: string): number {
  const d = tryResolveInterval(code);
  if (d && d.bucketing.mode === 'interval') return d.bucketing.seconds;
  if (d && d.bucketing.mode === 'calendar') return 86400 * 30;
  return 300;
}

/** Seeded random walk whose last close lands on endPrice. */
function generate(seed: number, n: number, sec: number, endTime: number, endPrice: number): Bar[] {
  const rnd = xorshift(seed);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 0.5774;
  const sigma = 0.0012 * Math.sqrt(sec / 300);
  const raw: { o: number; h: number; l: number; c: number; v: number }[] = [];
  let p = 1;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + sigma * gauss());
    const h = Math.max(o, c) * (1 + Math.abs(sigma * 0.6 * gauss()));
    const l = Math.min(o, c) * (1 - Math.abs(sigma * 0.6 * gauss()));
    raw.push({ o, h, l, c, v: Math.round((20_000 + rnd() * 180_000) * (sec / 300)) });
    p = c;
  }
  const k = endPrice / p;
  const firstTime = endTime - (n - 1) * sec;
  return raw.map((r, i) => {
    const open = fix(roundTick(r.o * k));
    const close = fix(roundTick(r.c * k));
    return {
      time: firstTime + i * sec,
      open,
      close,
      high: fix(Math.max(roundTick(r.h * k), open, close)),
      low: fix(Math.min(roundTick(r.l * k), open, close)),
      volume: r.v,
    };
  });
}

interface Sub {
  key: string;
  sec: number;
  onBar: (bar: Bar) => void;
}

export class SpikeFeed implements DataFeed {
  private series = new Map<string, Bar[]>();
  private subs = new Set<Sub>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private simClockSec: number;
  private lastRealMs = 0;
  private rnd: () => number;
  /** Current instrument price (the sim's or the last bridged one). */
  lastPrice: number;
  /** Total ticks applied to the live candle since creation. */
  ticks = 0;
  /** Called on every applied tick, outside React (sets the BUY/SELL mark). */
  onPrice: ((price: number) => void) | null = null;

  constructor(basePrice: number) {
    this.lastPrice = fix(roundTick(basePrice));
    this.simClockSec = Math.floor(Date.now() / 1000);
    this.rnd = xorshift(hash('live') ^ 0x5bd1e995);
  }

  private seriesFor(symbol: string, exchange: string, interval: string): Bar[] {
    const key = `${exchange}:${symbol}|${interval}`;
    let bars = this.series.get(key);
    if (!bars) {
      const sec = intervalSeconds(interval);
      const end = Math.floor(this.simClockSec / sec) * sec;
      bars = generate(hash(key), HISTORY_BARS, sec, end, this.lastPrice);
      this.series.set(key, bars);
    }
    return bars;
  }

  async getBars(req: BarsRequest): Promise<Bar[]> {
    const bars = this.seriesFor(req.symbol, req.exchange, req.interval);
    if (req.to !== undefined && req.to < bars[0].time) return [];
    return bars.map((b) => ({ ...b }));
  }

  subscribeBars(req: BarsRequest, onBar: (bar: Bar) => void, _opts?: BarSubscriptionOptions): UnsubscribeFn {
    this.seriesFor(req.symbol, req.exchange, req.interval);
    const sub: Sub = { key: `${req.exchange}:${req.symbol}|${req.interval}`, sec: intervalSeconds(req.interval), onBar };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** In-DOM tick simulator on/off (off in via-bridge mode and when the tab is hidden). */
  setSimRunning(on: boolean) {
    if (on && !this.timer) {
      this.lastRealMs = 0;
      this.timer = setInterval(() => {
        const step = Math.max(TICK_SIZE, this.lastPrice * 0.0004);
        const next = fix(Math.max(TICK_SIZE, roundTick(this.lastPrice + (this.rnd() - 0.5) * 2 * step)));
        this.applyPrice(next);
      }, 1000 / SIM_TICK_HZ);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Update the live candle with one trade at `price` (sim tick or bridged quote). */
  applyPrice(price: number) {
    const now = performance.now();
    // Advance the sim clock by real elapsed time x SIM_SPEED, capped so a pause
    // (hidden tab, bridge gap) does not jump candles.
    const realDelta = this.lastRealMs ? Math.min(1000, now - this.lastRealMs) : 1000 / SIM_TICK_HZ;
    this.lastRealMs = now;
    this.simClockSec += (realDelta / 1000) * SIM_SPEED;
    this.lastPrice = price;
    this.ticks++;
    const vol = Math.round(50 + this.rnd() * 950);
    for (const sub of this.subs) {
      const bars = this.series.get(sub.key);
      if (!bars || !bars.length) continue;
      const bucket = Math.floor(this.simClockSec / sub.sec) * sub.sec;
      const last = bars[bars.length - 1];
      let bar: Bar;
      if (bucket > last.time) {
        bar = { time: bucket, open: price, high: price, low: price, close: price, volume: vol };
        bars.push(bar);
        if (bars.length > HISTORY_BARS * 2) bars.splice(0, bars.length - HISTORY_BARS * 2);
      } else {
        bar = {
          time: last.time,
          open: last.open,
          high: Math.max(last.high, price),
          low: Math.min(last.low, price),
          close: price,
          volume: (last.volume ?? 0) + vol,
        };
        bars[bars.length - 1] = bar;
      }
      sub.onBar({ ...bar });
    }
    this.onPrice?.(price);
  }

  dispose() {
    this.setSimRunning(false);
    this.subs.clear();
    this.onPrice = null;
  }
}
