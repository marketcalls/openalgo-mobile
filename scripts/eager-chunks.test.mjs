import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { eagerChunkFiles, lazyImports } from './lib/lazy-imports.mjs'
import { OPENALGO_CHARTS } from './lib/pins.mjs'

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const DIST = repo('node_modules/openalgo-charts/dist')
const WIDGET_MJS = join(DIST, 'openalgo-charts.widget.mjs')
const EAGER = repo('src/dom/chart/eagerChunks.ts')

test('every lazy import in the widget is imported eagerly', () => {
  assert.deepEqual(new Set(lazyImports(WIDGET_MJS)), eagerChunkFiles(EAGER))
})

test('the pinned widget has 8 lazy chunks, every one a literal import', () => {
  const pkg = JSON.parse(readFileSync(join(DIST, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.version, OPENALGO_CHARTS)
  const lazy = lazyImports(WIDGET_MJS)
  assert.equal(new Set(lazy).size, 8)
  // A computed import() names no file, so no eager list could cover it.
  const every = readFileSync(WIDGET_MJS, 'utf8').match(/\bimport\(/g) ?? []
  assert.equal(every.length, lazy.length)
})

test('lazyImports lists literal targets; eagerChunkFiles names the dist files a list imports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-imports-'))
  try {
    const dist = join(dir, 'dist')
    mkdirSync(dist)
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs']) writeFileSync(join(dist, f), '')
    const bundle = join(dist, 'w.mjs')
    writeFileSync(
      bundle,
      'import"./c.mjs";const x=()=>import("./a.mjs"),y=()=>import( \'./b.mjs\' ),z=import(name)',
    )
    assert.deepEqual(lazyImports(bundle), ['./a.mjs', './b.mjs'])

    const list = join(dir, 'list.ts')
    writeFileSync(
      list,
      "// no import( in a comment counts\nimport './dist/a.mjs'\nimport './dist/b.mjs'\n",
    )
    assert.deepEqual(eagerChunkFiles(list, dist), new Set(['./a.mjs', './b.mjs']))

    writeFileSync(list, "import './dist/missing.mjs'\n")
    assert.throws(() => eagerChunkFiles(list, dist), /missing\.mjs/)
    writeFileSync(list, "import './elsewhere.mjs'\n")
    assert.throws(() => eagerChunkFiles(list, dist), /elsewhere\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
