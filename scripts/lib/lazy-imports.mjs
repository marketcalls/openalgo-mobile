// An Expo DOM page cannot load a lazy chunk (design 7.7 Bundles), so every chunk a bundled
// package loads with a dynamic import is imported up front by a list such as
// src/dom/chart/eagerChunks.ts. These read both sides: the package's lazy imports and the list.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../../node_modules/openalgo-charts/dist', import.meta.url))

// A dynamic import of a relative string literal, as a bundler writes it in a dist file.
const LAZY = /\bimport\(\s*(["'])(\.{1,2}\/[^"'\n]+)\1\s*\)/g
// A side-effect import at the start of a line, as an eager list writes it.
const EAGER = /^import\s+(["'])([^"'\n]+)\1/gm

/** Every literal `import("./…")` target in a dist file, in order, as written. */
export function lazyImports(file) {
  return [...readFileSync(file, 'utf8').matchAll(LAZY)].map((m) => m[2])
}

/**
 * The dist files an eager list imports, each as `./<name>`, the way the dist's own lazy imports
 * name them. Every import must be a relative path to an existing file directly in `dist`.
 */
export function eagerChunkFiles(file, dist = DIST) {
  const out = new Set()
  for (const [, , spec] of readFileSync(file, 'utf8').matchAll(EAGER)) {
    const target = resolve(dirname(file), spec)
    const name = relative(dist, target)
    if (!spec.startsWith('.') || name.includes(sep) || name.startsWith('..')) {
      throw new Error(`${spec} is not a file in ${dist}`)
    }
    if (!existsSync(target)) throw new Error(`${spec} does not exist`)
    out.add(`./${name}`)
  }
  return out
}
