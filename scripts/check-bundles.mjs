// Bundle budgets: each platform bundle may grow at most `growth` over the committed baseline
// and may never pass its absolute limit. `--update` rewrites the baseline from a fresh export.
// A passing bundle names its room under the limit, so the growth across PRs is tracked against
// the limit too, and warns when that room is less than one PR may add.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { domPages } from './lib/dom-export.mjs'

const BASELINE = fileURLToPath(new URL('../bundle-baseline.json', import.meta.url))
const PLATFORMS = ['android', 'ios']

/** Sizes in bytes of the platform bundles listed in `<dir>/metadata.json`, and of the DOM pages. */
export function measure(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
  const out = {}
  for (const p of PLATFORMS) {
    const file = meta.fileMetadata?.[p]?.bundle
    if (file) out[p] = statSync(join(dir, file)).size
  }
  // a DOM page's size is its JS: the largest page with that marker
  for (const page of domPages(dir)) {
    if (!page.marker) continue
    const js = page.scripts.reduce((n, s) => n + s.bytes, 0)
    out[page.marker] = Math.max(out[page.marker] ?? 0, js)
  }
  return out
}

/** Compare measured sizes to the config; `lines` is the human-readable report. */
export function compare(measured, cfg) {
  const lines = []
  let ok = true
  for (const [name, limit] of Object.entries(cfg.limits)) {
    const size = measured[name]
    const base = cfg.baseline[name]
    const isPlatform = PLATFORMS.includes(name)
    if (size === undefined) {
      if (isPlatform) {
        ok = false
        lines.push(`${name}: FAIL, no bundle in the export`)
      } else if (base === null || base === undefined) {
        lines.push(`${name}: not built (skipped)`)
      } else {
        ok = false
        lines.push(`${name}: FAIL, baseline exists but nothing was built`)
      }
      continue
    }
    const problems = []
    if (size > limit) problems.push(`over the ${limit} byte limit`)
    let growth = ''
    if (typeof base === 'number') {
      const pct = ((size / base - 1) * 100).toFixed(1)
      growth = ` (${pct.startsWith('-') ? '' : '+'}${pct}%)`
      if (size > base + base * cfg.growth + 1e-9) {
        problems.push(`${name} ${pct.startsWith('-') ? '' : '+'}${pct}% over the baseline ${base}`)
      }
    }
    if (problems.length) ok = false
    let room = ''
    if (!problems.length) {
      room = `, ${limit - size} B under the limit`
      const onePr = typeof base === 'number' ? Math.round(base * cfg.growth) : null
      if (onePr !== null && limit - size < onePr) {
        room += `, less than one ${Math.round(cfg.growth * 100)}% PR (${onePr} B)`
      }
    }
    lines.push(
      `${name}: ${size}${growth} ${problems.length ? `FAIL, ${problems.join('; ')}` : 'ok'}${room}`,
    )
  }
  return { ok, lines }
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'))
  if (!dir) {
    console.error('usage: check-bundles.mjs <export-dir> [--update]')
    return 2
  }
  const cfg = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const measured = measure(resolve(dir))
  if (argv.includes('--update')) {
    for (const name of Object.keys(cfg.limits)) {
      cfg.baseline[name] = measured[name] ?? null
    }
    writeFileSync(BASELINE, `${JSON.stringify(cfg, null, 2)}\n`)
    console.log(`baseline updated: ${JSON.stringify(cfg.baseline)}`)
  }
  const { ok, lines } = compare(measured, cfg)
  for (const l of lines) console.log(l)
  console.log(ok ? 'ok' : 'FAILED')
  return ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
