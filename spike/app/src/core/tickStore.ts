// THROWAWAY SPIKE. External tick store: ticks land in a Map outside React and are
// published to subscribers at most once per flush, so 500 msgs/s do not become
// 500 React renders/s. The flush policy is switchable so the spike can show the
// cost of the naive approach ('immediate') next to the coalesced one ('raf').
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface Quote {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number; // previous close (the WebSocket field name)
  volume: number;
  change: number;
  changePct: number;
  oi?: number;
  bid?: number;
  ask?: number;
  ts: number;
  dir: 1 | -1 | 0; // direction of the last tick, for row flashing
}

export type FlushMode = 'raf' | 'interval250' | 'immediate';

const quotes = new Map<string, Quote>();
const listeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
const dirty = new Set<string>();
let mode: FlushMode = 'raf';
let scheduled = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

let ticksIn = 0;
let flushes = 0;
let keysPublished = 0;

function flush() {
  scheduled = false;
  if (dirty.size === 0) return;
  flushes++;
  const keys = Array.from(dirty);
  dirty.clear();
  keysPublished += keys.length;
  for (const k of keys) listeners.get(k)?.forEach((fn) => fn());
  anyListeners.forEach((fn) => fn());
}

function schedule() {
  if (mode === 'immediate') return flush();
  if (mode === 'raf' && !scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
  // interval250 is driven by the interval itself.
}

export function setFlushMode(next: FlushMode) {
  mode = next;
  if (intervalId) clearInterval(intervalId);
  intervalId = next === 'interval250' ? setInterval(flush, 250) : null;
}

export function getFlushMode(): FlushMode {
  return mode;
}

export function putQuote(key: string, q: Omit<Quote, 'dir'>) {
  ticksIn++;
  const prev = quotes.get(key);
  const dir: Quote['dir'] = prev ? (q.ltp > prev.ltp ? 1 : q.ltp < prev.ltp ? -1 : prev.dir) : 0;
  quotes.set(key, { ...q, dir });
  dirty.add(key);
  schedule();
}

export function getQuote(key: string): Quote | undefined {
  return quotes.get(key);
}

export function subscribeKey(key: string, fn: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

export function subscribeAny(fn: () => void) {
  anyListeners.add(fn);
  return () => {
    anyListeners.delete(fn);
  };
}

/**
 * True while the screen that shows these quotes is not visible. expo-router's
 * NativeTabs mounts every tab at startup and never freezes hidden ones, so without
 * this a hidden Watchlist or Chain keeps re-rendering its rows on every tick and
 * that work lands in whatever bench runs on the visible tab. Screens provide
 * `<QuotesPausedContext value={!focused}>`; a real app would pause hidden screens too.
 */
export const QuotesPausedContext = createContext(false);
const noopUnsubscribe = () => {};

/** One row re-renders only when its own symbol ticks (and only while its screen is visible). */
export function useQuote(key: string): Quote | undefined {
  const paused = useContext(QuotesPausedContext);
  // When the screen is shown again the subscribe function changes, so React
  // re-subscribes and re-reads the snapshot: the row catches up at once.
  return useSyncExternalStore(
    (fn) => (paused ? noopUnsubscribe : subscribeKey(key, fn)),
    () => quotes.get(key),
  );
}

/** Counters since the last call, for the HUD and benchmark summaries. */
export function takeStoreCounters() {
  const out = { ticksIn, flushes, keysPublished };
  ticksIn = 0;
  flushes = 0;
  keysPublished = 0;
  return out;
}
