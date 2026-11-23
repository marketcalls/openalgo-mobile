// Throwaway: walk '@/...' and relative imports from entry files under frontend/src, list bare packages.
import fs from 'node:fs'; import path from 'node:path'
const SRC = path.resolve(import.meta.dirname, '../../../openalgo/frontend/src')
const exts = ['.tsx', '.ts', '/index.tsx', '/index.ts']
const seen = new Set(); const pkgs = new Map(); let loc = 0
function resolve(from, spec) {
  let base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(from), spec)
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const e of exts) if (fs.existsSync(base + e)) return base + e
  return null
}
function walk(f) {
  if (seen.has(f)) return; seen.add(f)
  const txt = fs.readFileSync(f, 'utf8'); loc += txt.split('\n').length
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of txt.matchAll(re)) {
    const spec = m[1] || m[2]; if (!spec) continue
    if (/^import\s+type|^export\s+type/.test(m[0])) continue
    if (spec.startsWith('@/') || spec.startsWith('.')) { const r = resolve(f, spec); if (r) walk(r); else console.error('UNRESOLVED', spec, 'in', f) }
    else { const p = spec.startsWith('@') ? spec.split('/').slice(0,2).join('/') : spec.split('/')[0]; if (!pkgs.has(p)) pkgs.set(p, new Set()); pkgs.get(p).add(path.relative(SRC, f)) }
  }
}
for (const e of process.argv.slice(2)) walk(path.join(SRC, e))
console.log('files', seen.size, 'loc', loc)
for (const [p, fs_] of [...pkgs].sort()) console.log(p.padEnd(32), [...fs_].slice(0,3).join(', '))
const env = [...seen].filter(f => fs.readFileSync(f,'utf8').includes('import.meta')).map(f=>path.relative(SRC,f))
console.log('import.meta in:', env.join(', ') || 'none')
