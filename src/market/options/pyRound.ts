// Python's float arithmetic where the ported services depend on it (design 7.8, "rounding
// before aggregation"): round() and sum(), so the on-device routes give the server's digits.

/**
 * Python 3 `round(x, nd)` for a float: the exact binary value rounded to `nd` places, an exact
 * tie to the even digit. `toFixed` rounds the exact value too but breaks a tie away from zero,
 * so only a tie is corrected. A tie has at most nd + 1 decimals (it is a dyadic rational), and a
 * double next to one differs from it long before place nd + 25, so 25 more places tell them apart.
 */
export function pyRound(x: number, nd: number): number {
  // Python returns these unchanged; toFixed would print 1e21 and above in exponent form.
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x
  const negative = x < 0 || Object.is(x, -0)
  const abs = Math.abs(x)
  let digits = abs.toFixed(nd)
  const rest = abs.toFixed(nd + 25).slice(-25)
  if (/^50*$/.test(rest)) {
    // toFixed went up to an odd last digit: Python stays on the even one below it.
    const last = Number(digits[digits.length - 1])
    if (last % 2 === 1) digits = `${digits.slice(0, -1)}${last - 1}`
  }
  const rounded = Number(digits)
  return negative ? -rounded : rounded
}

/**
 * CPython 3.12+ `sum()` of floats: Neumaier's compensated sum (bltinmodule.c builtin_sum_impl).
 * The start value is the int 0, so sum([-0.0]) is 0.0; the compensation is added only when it
 * is finite, so an overflowed sum stays infinite.
 */
export function pySum(xs: readonly number[]): number {
  let sum = 0
  let c = 0
  for (const x of xs) {
    const t = sum + x
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum
    sum = t
  }
  return c !== 0 && Number.isFinite(c) ? sum + c : sum
}
