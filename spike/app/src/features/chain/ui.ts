// THROWAWAY SPIKE. Colors, sizes and number formatters for the native option chain screen.
import { CHAIN, CHAIN_UNDERLYING, keyOf } from '~/core/symbols';

export const C = {
  bg: '#0b0f14',
  surface: '#121821',
  border: '#1f2a37',
  text: '#e6edf3',
  muted: '#8b98a5',
  up: '#22c55e',
  down: '#ef4444',
  accent: '#3b82f6',
  amber: '#f59e0b',
  itm: '#1a2330', // in-the-money half shading
  atmRow: '#14223a', // ATM row tint (under the halves that are not ITM)
};

/** Fixed row height: deterministic layout, so the scroll range is the same on every run. */
export const ROW_H = 34;
export const STRIKE_W = 64;

export const UNDER_KEY = keyOf(CHAIN_UNDERLYING.symbol, CHAIN_UNDERLYING.exchange);

export interface Row {
  i: number;
  strike: number;
  ceKey: string;
  peKey: string;
}

export const ROWS: Row[] = CHAIN.map((r, i) => ({
  i,
  strike: r.strike,
  ceKey: keyOf(r.ce.symbol, r.ce.exchange),
  peKey: keyOf(r.pe.symbol, r.pe.exchange),
}));

const STRIKES = ROWS.map((r) => r.strike);

/**
 * Moneyness of the whole chain packed into one number, so a useSyncExternalStore
 * snapshot only changes (and the list only re-renders) when the ATM strike or an
 * ITM boundary moves, not on every underlying tick.
 *   atm = index of the strike nearest the LTP
 *   lt  = number of strikes < LTP  (CE ITM rows are i < lt)
 *   le  = number of strikes <= LTP (PE ITM rows are i >= le)
 * Returns -1 when there is no underlying quote yet.
 */
export function bandCode(ltp: number | undefined): number {
  if (ltp == null || !Number.isFinite(ltp)) return -1;
  let lt = 0;
  let le = 0;
  let atm = 0;
  let best = Infinity;
  for (let i = 0; i < STRIKES.length; i++) {
    const s = STRIKES[i];
    if (s < ltp) lt++;
    if (s <= ltp) le++;
    const d = Math.abs(s - ltp);
    if (d < best) {
      best = d;
      atm = i;
    }
  }
  return atm * 10000 + lt * 100 + le;
}

export function decodeBand(code: number) {
  if (code < 0) return { atm: -1, lt: 0, le: STRIKES.length + 1 };
  return { atm: Math.floor(code / 10000), lt: Math.floor(code / 100) % 100, le: code % 100 };
}

export function fmtPrice(v: number | undefined): string {
  return v == null ? '-' : v.toFixed(2);
}

export function fmtSigned(v: number | undefined): string {
  if (v == null) return '-';
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

export function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(1)}k%`;
  if (a >= 100) return `${sign}${a.toFixed(0)}%`;
  return `${sign}${a.toFixed(1)}%`;
}

/** Indian compact units: 45.6K, 12.3L (lakh), 1.23Cr (crore). */
export function fmtOI(v: number | undefined): string {
  if (v == null) return '-';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/** '27NOV26' -> '27 Nov 2026'. */
export function fmtExpiry(code: string): string {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(code);
  if (!m) return code;
  return `${m[1]} ${m[2][0]}${m[2].slice(1).toLowerCase()} 20${m[3]}`;
}
