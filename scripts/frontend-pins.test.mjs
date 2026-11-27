import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { frontendVersions, TOOL_PACKAGES } from './lib/frontend-pins.mjs'
import { readOpenalgoFile } from './openalgo-src.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
const pkg = read('package.json')
const appLock = read('package-lock.json')
const lock = readOpenalgoFile('frontend/package-lock.json', { repoRoot: root })

test('every DOM package is pinned exactly to the frontend lockfile', () => {
  const want = frontendVersions(lock, TOOL_PACKAGES)
  for (const n of TOOL_PACKAGES) {
    assert.equal(pkg.dependencies[n] ?? pkg.devDependencies[n], want[n], n)
    assert.equal(appLock.packages[`node_modules/${n}`]?.version, want[n], `${n} as installed`)
  }
})

test('react, react-dom, react-query and zustand come from the app, not the frontend', () => {
  for (const n of ['react', 'react-dom', '@tanstack/react-query', 'zustand']) {
    assert.ok(!TOOL_PACKAGES.includes(n), n)
  }
})

test('a package the frontend does not lock is refused', () => {
  const text = JSON.stringify({ packages: { 'node_modules/clsx': { version: '2.1.1' } } })
  assert.deepEqual(frontendVersions(text, ['clsx']), { clsx: '2.1.1' })
  assert.throws(() => frontendVersions(text, ['axios']), /axios is not in the frontend lockfile/)
})
