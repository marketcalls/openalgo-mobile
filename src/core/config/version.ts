// Known server quirk: a build reports 2.0.1.7 as '2.0.1.17'.
const QUIRKS: Record<string, string> = { '2.0.1.17': '2.0.1.7' }

export function normalizeVersion(v: string): string {
  const t = v.trim().replace(/^v/i, '')
  return QUIRKS[t] ?? t
}

function parts(v: string): number[] {
  return normalizeVersion(v)
    .split('.')
    .map((p) => {
      const n = Number.parseInt(p, 10)
      return Number.isFinite(n) ? n : 0
    })
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function atLeast(v: string | null, min: string): boolean {
  return v !== null && compareVersions(v, min) >= 0
}
