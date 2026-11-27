// The implied-volatility solver the server runs: opengreeks 0.2.0's Black-76 (black76_rust/src/
// iv.rs, pricing.rs, normal.rs and erf.rs, the version openalgo.ref's uv.lock pins), ported with
// its own normal CDF. The web's solver (frontend/src/lib/optionGreeks.ts) stops at a price within
// 1e-8, has no 1e-6 floor and refuses a price at its bound, so it misses the server's IV on the
// golden grid (design 7.8: "a dedicated engine replaces it behind the same wrapper"). The web's
// normal CDF (Hart) differs from opengreeks' (Cody) in the last bits, which moves the IV of a leg
// with almost no time value by up to 6e-6 on the recorded chains; Cody's agrees bit for bit on
// most legs. The Greeks stay the web's.
// Ported from opengreeks (https://github.com/marketcalls/opengreeks, tag v0.2.0), MIT License,
// Copyright (c) 2026 Marketcalls / Rajandran R.

export type Flag = 'c' | 'p'
/** opengreeks' IvError: below intrinsic, above F (call) or K (put), or no convergence. */
export type IvFailure = 'below' | 'above' | 'notConverged'
export type IvResult = { sigma: number } | { error: IvFailure }

// --- normal.rs and erf.rs: Cody's erfc (Math. Comp. 23, 1969) and the A&S 26.2.12 tail ----------

const ERF_A = [
  3.1611237438705655, 113.86415415105016, 377.485237685302, 3209.3775891384694, 0.18577770618460315,
] as const
const ERF_B = [
  23.601290952344122, 244.02463793444417, 1282.6165260773723, 2844.236833439171,
] as const
const ERF_C = [
  0.5641884969886701, 8.883149794388377, 66.11919063714163, 298.6351381974001, 881.952221241769,
  1712.0476126340707, 2051.0783778260716, 1230.3393547979972, 2.1531153547440383e-8,
] as const
const ERF_D = [
  15.744926110709835, 117.6939508913125, 537.1811018620099, 1621.3895745666903, 3290.7992357334597,
  4362.619090143247, 3439.3676741437216, 1230.3393548037495,
] as const
const ERF_P = [
  0.30532663496123236, 0.36034489994980445, 0.12578172611122926, 0.016083785148742275,
  0.0006587491615298378, 0.016315387137302097,
] as const
const ERF_Q = [
  2.568520192289822, 1.8729528499234604, 0.5279051029514285, 0.06051834131244132,
  0.0023352049762686918,
] as const
const SQRPI = 0.5641895835477563
const ONE_OVER_SQRT_TWO_PI = 0.3989422804014327
const ONE_OVER_SQRT_TWO = Math.SQRT1_2

/** Rust's d_int: truncation toward zero. */
const truncate = (x: number) => (x > 0 ? Math.floor(x) : -Math.floor(-x))

/** exp(−y²) split as Cody does, so the large-argument tail keeps its precision. */
function expMinusSquare(y: number): number {
  const ysq = truncate(y * 16) / 16
  const del = (y - ysq) * (y + ysq)
  return Math.exp(-ysq * ysq) * Math.exp(-del)
}

/** calerf(x, 1). */
function erfc(x: number): number {
  const y = Math.abs(x)
  let result: number
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0
    let xnum = ERF_A[4] * ysq
    let xden = ysq
    for (let i = 0; i < 3; i++) {
      xnum = (xnum + (ERF_A[i] as number)) * ysq
      xden = (xden + (ERF_B[i] as number)) * ysq
    }
    return 1 - (x * (xnum + ERF_A[3])) / (xden + ERF_B[3])
  }
  if (y <= 4) {
    let xnum = ERF_C[8] * y
    let xden = y
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + (ERF_C[i] as number)) * y
      xden = (xden + (ERF_D[i] as number)) * y
    }
    result = ((xnum + ERF_C[7]) / (xden + ERF_D[7])) * expMinusSquare(y)
  } else if (y >= 26.543) {
    result = 0
  } else {
    const ysq = 1 / (y * y)
    let xnum = ERF_P[5] * ysq
    let xden = ysq
    for (let i = 0; i < 4; i++) {
      xnum = (xnum + (ERF_P[i] as number)) * ysq
      xden = (xden + (ERF_Q[i] as number)) * ysq
    }
    result = (ysq * (xnum + ERF_P[4])) / (xden + ERF_Q[4])
    result = ((SQRPI - result) / y) * expMinusSquare(y)
  }
  return x < 0 ? 2 - result : result
}

const normPdf = (x: number) => ONE_OVER_SQRT_TWO_PI * Math.exp(-0.5 * x * x)

/** norm_cdf: the asymptotic series at z ≤ −10, else 0.5·erfc(−z/√2). */
function normCdf(z: number): number {
  if (!(z <= -10)) return 0.5 * erfc(-z * ONE_OVER_SQRT_TWO)
  const eps = Number.EPSILON
  let sum = 1
  if (z >= -1 / Math.sqrt(eps)) {
    const zsqr = z * z
    let i = 1
    let g = 1
    let a = Number.MAX_VALUE
    let last: number
    // A do-while, as the Rust unrolls its first pass.
    do {
      last = a
      const x = (4 * i - 3) / zsqr
      const y = x * ((4 * i - 1) / zsqr)
      a = g * (x - y)
      sum -= a
      g *= y
      i += 1
      a = Math.abs(a)
    } while (last > a && a >= Math.abs(sum) * eps)
  }
  return (-normPdf(z) * sum) / z
}

// --- pricing.rs ------------------------------------------------------------------------------

const d1Of = (F: number, K: number, t: number, sigma: number) =>
  (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t))

/** undiscounted_black_price: q·(F·N(q·d1) − K·N(q·d2)). */
function undiscounted(flag: Flag, F: number, K: number, t: number, sigma: number): number {
  const q = flag === 'c' ? 1 : -1
  const d1 = d1Of(F, K, t, sigma)
  const d2 = d1 - sigma * Math.sqrt(t)
  return q * (F * normCdf(q * d1) - K * normCdf(q * d2))
}

// --- iv.rs -----------------------------------------------------------------------------------

const SIGMA_LO = 1e-6
const SIGMA_HI = 5
const PRICE_TOLERANCE_REL = 1e-12
const MAX_NEWTON_ITERS = 50
const MAX_BISECTION_ITERS = 100
const TWO_PI = 2 * Math.PI

/**
 * opengreeks `implied_volatility(price, F, K, r, t, flag)`: σ as a decimal, or the error the
 * Python binding raises ("price is below intrinsic value", "price exceeds theoretical maximum",
 * "IV solver failed to converge"). A price at intrinsic gives the 1e-6 floor, and one past what
 * σ = 5 reaches gives the top of the bisection bracket, 4.999999999999996.
 */
export function impliedVol(
  price: number,
  F: number,
  K: number,
  r: number,
  t: number,
  flag: Flag,
): IvResult {
  // The solver works on undiscounted prices.
  const target = price * Math.exp(r * t)
  const intrinsic = flag === 'c' ? Math.max(F - K, 0) : Math.max(K - F, 0)
  const upper = flag === 'c' ? F : K
  if (target < intrinsic - 1e-14) return { error: 'below' }
  if (target > upper + 1e-14) return { error: 'above' }
  if (target <= intrinsic) return { sigma: SIGMA_LO }

  const tol = PRICE_TOLERANCE_REL * (1 + Math.abs(target))

  // Brenner-Subrahmanyam seed.
  let sigma = (Math.sqrt(TWO_PI / t) * target) / upper
  if (!Number.isFinite(sigma) || sigma < SIGMA_LO) sigma = 0.2
  sigma = Math.min(Math.max(sigma, SIGMA_LO), SIGMA_HI)

  // Newton on the undiscounted price, stopping on a small residual or a small step.
  let prev = Number.NaN
  for (let i = 0; i < MAX_NEWTON_ITERS; i++) {
    const diff = undiscounted(flag, F, K, t, sigma) - target
    if (Math.abs(diff) < tol) return { sigma }
    if (!Number.isNaN(prev) && Math.abs(sigma - prev) < 1e-12 * (1 + sigma)) return { sigma }
    const vega = F * Math.sqrt(t) * normPdf(d1Of(F, K, t, sigma))
    if (vega < 1e-15) break
    const next = sigma - diff / vega
    if (!Number.isFinite(next) || next <= 0 || next > SIGMA_HI) break
    prev = sigma
    sigma = next
  }

  // Bisection over the bracket.
  let lo = SIGMA_LO
  let hi = SIGMA_HI
  for (let i = 0; i < MAX_BISECTION_ITERS; i++) {
    const mid = 0.5 * (lo + hi)
    const pm = undiscounted(flag, F, K, t, mid)
    if (Math.abs(pm - target) < tol) return { sigma: mid }
    if (pm < target) lo = mid
    else hi = mid
    if (hi - lo < 1e-14) return { sigma: 0.5 * (lo + hi) }
  }
  return { error: 'notConverged' }
}
