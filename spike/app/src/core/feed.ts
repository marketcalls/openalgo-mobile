// THROWAWAY SPIKE. Two tick sources behind one interface:
//  - SimFeed: in-app generator. It serializes each tick to the exact JSON the
//    OpenAlgo WebSocket sends and JSON.parses it again, so the JS thread pays the
//    real decode cost, not just the render cost.
//  - WsFeed: the real OpenAlgo protocol (authenticate within 15 s, subscribe with
//    a symbols array, re-authenticate and re-subscribe after every reconnect).
//    Works against spike/mock-feed or a real OpenAlgo server. Read-only: it only
//    subscribes to market data.
import { ALL_STREAMED, type Instrument, keyOf } from './symbols';
import { putQuote } from './tickStore';

export interface FeedStatus {
  state: 'idle' | 'connecting' | 'authenticated' | 'streaming' | 'error' | 'closed';
  detail?: string;
}

export interface Feed {
  start(): void;
  stop(): void;
  onStatus(fn: (s: FeedStatus) => void): void;
}

interface MarketDataMsg {
  type: 'market_data';
  symbol: string;
  exchange: string;
  mode: number;
  data: {
    ltp: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    change?: number;
    change_percent?: number;
    oi?: number;
    depth?: { buy?: { price: number }[]; sell?: { price: number }[] };
    timestamp?: number;
  };
}

function ingest(msg: MarketDataMsg) {
  const d = msg.data;
  const close = d.close ?? d.ltp;
  putQuote(keyOf(msg.symbol, msg.exchange), {
    ltp: d.ltp,
    open: d.open ?? d.ltp,
    high: d.high ?? d.ltp,
    low: d.low ?? d.ltp,
    close,
    volume: d.volume ?? 0,
    change: d.change ?? d.ltp - close,
    changePct: d.change_percent ?? (close ? ((d.ltp - close) / close) * 100 : 0),
    oi: d.oi,
    bid: d.depth?.buy?.[0]?.price,
    ask: d.depth?.sell?.[0]?.price,
    ts: d.timestamp ?? Date.now(),
  });
}

/** Ticks per second across the whole universe (watchlist + chain). */
export class SimFeed implements Feed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = new Map<string, number>();
  private statusFn: (s: FeedStatus) => void = () => {};
  constructor(private ratePerSec: number) {}

  onStatus(fn: (s: FeedStatus) => void) {
    this.statusFn = fn;
  }

  start() {
    // Prime every instrument once so screens have data immediately.
    ALL_STREAMED.forEach((ins) => this.emit(ins));
    const intervalMs = 20; // 50 batches/s, like a busy socket delivering bursts
    const perBatch = Math.max(1, Math.round((this.ratePerSec * intervalMs) / 1000));
    let n = 0;
    this.timer = setInterval(() => {
      for (let i = 0; i < perBatch; i++) {
        // Skewed pick: the first 30 names tick far more often, like real markets.
        const r = Math.random();
        const idx = r < 0.6 ? Math.floor(Math.random() * 30) : Math.floor(Math.random() * ALL_STREAMED.length);
        this.emit(ALL_STREAMED[idx]);
        n++;
      }
    }, intervalMs);
    this.statusFn({ state: 'streaming', detail: `sim ${this.ratePerSec}/s` });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.statusFn({ state: 'closed' });
  }

  private emit(ins: Instrument) {
    const k = keyOf(ins.symbol, ins.exchange);
    const prev = this.last.get(k) ?? ins.base;
    const tick = Math.max(0.05, ins.base * 0.0005);
    const next = Math.max(0.05, Math.round((prev + (Math.random() - 0.5) * 2 * tick) * 20) / 20);
    this.last.set(k, next);
    const msg = {
      type: 'market_data',
      symbol: ins.symbol,
      exchange: ins.exchange,
      mode: 2,
      broker: 'sim',
      data: {
        ltp: next,
        open: ins.base,
        high: Math.max(ins.base, next),
        low: Math.min(ins.base, next),
        close: ins.base,
        volume: Math.floor(Math.random() * 5_000_000),
        change: next - ins.base,
        change_percent: ((next - ins.base) / ins.base) * 100,
        oi: ins.exchange === 'NFO' ? Math.floor(Math.random() * 9_000_000) : undefined,
        timestamp: Date.now(),
      },
    };
    // Round-trip through JSON on purpose: this is the decode cost a socket pays.
    ingest(JSON.parse(JSON.stringify(msg)) as MarketDataMsg);
  }
}

export class WsFeed implements Feed {
  private ws: WebSocket | null = null;
  private statusFn: (s: FeedStatus) => void = () => {};
  private stopped = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private url: string,
    private apiKey: string,
  ) {}

  onStatus(fn: (s: FeedStatus) => void) {
    this.statusFn = fn;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.statusFn({ state: 'closed' });
  }

  private connect() {
    this.statusFn({ state: 'connecting', detail: this.url });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let streaming = false;
    let nSymbols = 0;
    const markStreaming = () => {
      if (streaming) return;
      streaming = true;
      this.statusFn({ state: 'streaming', detail: `${nSymbols} symbols` });
    };
    ws.onopen = () => ws.send(JSON.stringify({ action: 'authenticate', api_key: this.apiKey }));
    ws.onmessage = (ev) => {
      let msg: { type?: string; status?: string; code?: string; message?: string; broker?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'market_data') {
        ingest(msg as unknown as MarketDataMsg);
        // Only claim 'streaming' once data actually arrives (or the subscribe ack).
        if (!streaming) markStreaming();
        return;
      }
      // The OpenAlgo server (and spike/mock-feed) send errors as
      // {status:'error', code, message} with no 'type' field.
      if (msg.status === 'error' && msg.type !== 'auth') {
        return this.statusFn({ state: 'error', detail: `${msg.code ?? 'ERROR'}: ${msg.message ?? ''}`.trim() });
      }
      if (msg.type === 'auth') {
        if (msg.status !== 'success') return this.statusFn({ state: 'error', detail: msg.message ?? 'auth failed' });
        this.retry = 0;
        this.statusFn({ state: 'authenticated', detail: msg.broker });
        const symbols = ALL_STREAMED.map((i) => ({ symbol: i.symbol, exchange: i.exchange }));
        nSymbols = symbols.length;
        ws.send(JSON.stringify({ action: 'subscribe', symbols, mode: 'Quote', request_id: 'spike-1' }));
        this.statusFn({ state: 'authenticated', detail: `subscribing ${nSymbols} symbols` });
        return;
      }
      if (msg.type === 'subscribe' && msg.status !== 'error') markStreaming();
    };
    ws.onerror = () => this.statusFn({ state: 'error', detail: 'socket error' });
    ws.onclose = (ev) => {
      if (this.stopped) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      const why = ev.code ? `closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}, ` : '';
      this.statusFn({ state: 'connecting', detail: `${why}reconnect in ${delay} ms` });
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
