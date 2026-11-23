// THROWAWAY SPIKE. Watchlist colors and number formatting, kept local so this screen does not depend on other builders' files.
export const C = {
  bg: '#0b0f14',
  surface: '#121821',
  border: '#1f2a37',
  text: '#e6edf3',
  muted: '#8b98a5',
  up: '#22c55e',
  down: '#ef4444',
  accent: '#3b82f6',
};

export const UP_TINT = 'rgba(34,197,94,0.24)';
export const DOWN_TINT = 'rgba(239,68,68,0.24)';
export const UP_CHIP = 'rgba(34,197,94,0.14)';
export const DOWN_CHIP = 'rgba(239,68,68,0.14)';

/** Sign with a dead band so a -0.001 change renders as flat, not red "-0.00". */
export function signOf(n: number): 1 | -1 | 0 {
  return n >= 0.005 ? 1 : n <= -0.005 ? -1 : 0;
}

/** 2-decimal price with Indian digit grouping (12,34,567.80). Cheaper than toLocaleString per tick. */
export function fmtPrice(n: number): string {
  const s = Math.abs(n).toFixed(2);
  const dot = s.length - 3;
  let int = s.slice(0, dot);
  if (int.length > 3) {
    const head = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    int = `${head},${int.slice(-3)}`;
  }
  return (n < 0 && signOf(n) !== 0 ? '-' : '') + int + s.slice(dot);
}

export function fmtSigned(n: number): string {
  const sg = signOf(n);
  return (sg > 0 ? '+' : '') + (sg === 0 ? '0.00' : fmtPrice(n));
}

export function fmtPct(n: number): string {
  const sg = signOf(n);
  return `${sg > 0 ? '+' : ''}${sg === 0 ? '0.00' : n.toFixed(2)}%`;
}
