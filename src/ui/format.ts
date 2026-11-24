const FORMAT = 'en-IN'

function usable(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n)
}

export function signOf(n: number | undefined): 1 | -1 | 0 {
  if (!usable(n) || n === 0) return 0
  return n > 0 ? 1 : -1
}

/** Indian digit grouping, `dp` decimals; `'--'` when there is no price. */
export function fmtPrice(n?: number, dp = 2): string {
  if (!usable(n)) return '--'
  return n.toLocaleString(FORMAT, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

function signed(n: number, body: string): string {
  // A value that rounds to zero carries no sign.
  if (Number(body.replace(/[^0-9.]/g, '')) === 0) return body
  return `${n > 0 ? '+' : '-'}${body}`
}

/** `+1.20`, `-3.50`, `0.00`. */
export function fmtSigned(n?: number, dp = 2): string {
  if (!usable(n)) return '--'
  return signed(n, fmtPrice(Math.abs(n), dp))
}

/** `+0.46%`, `-0.46%`. */
export function fmtPct(n?: number, dp = 2): string {
  if (!usable(n)) return '--'
  return `${signed(n, fmtPrice(Math.abs(n), dp))}%`
}

export function fmtQty(n?: number): string {
  if (!usable(n)) return '--'
  return Math.round(n).toLocaleString(FORMAT)
}
