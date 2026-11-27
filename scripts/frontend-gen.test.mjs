import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseBrokers,
  parseExchanges,
  parseTools,
  renderFrontendIndexCss,
} from './lib/frontend-gen.mjs'
import { listOpenalgoDir, readOpenalgoFile, readRef } from './openalgo-src.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readOpenalgoFile(rel, { repoRoot: root })
const themeCss = readFileSync(join(root, 'node_modules/tailwindcss/theme.css'), 'utf8')
const tools = parseTools(read('frontend/src/lib/tools.ts'), themeCss)

test('20 tools in the web order, Strategy Builder first, Arbitrage last; ids are unique', () => {
  assert.equal(tools.length, 20)
  assert.equal(tools[0].id, 'strategybuilder')
  assert.equal(tools[0].title, 'Strategy Builder')
  assert.equal(tools[1].id, 'strategybuilder-portfolio')
  assert.equal(tools.at(-1).id, 'arbitrage')
  assert.equal(new Set(tools.map((t) => t.id)).size, 20)
})

test('colours are hex and initials match the web tile', () => {
  for (const t of tools) assert.match(t.color, /^#[0-9a-f]{6}$/, t.id)
  const oc = tools.find((t) => t.title === 'Option Chain')
  assert.equal(oc.initials, 'OC')
  assert.equal(tools[0].initials, 'SB')
  assert.ok(tools.every((t) => t.description.length > 10))
})

test('a changed tools.ts layout fails loudly', () => {
  const src = `export const tools = [
  { title: 'A', description: 'a long enough text', href: '/a', color: 'bg-red-500' },
  { title: 'B', description: 'b long enough text', href: '/b' },
]`
  assert.throws(() => parseTools(src, themeCss), /color/)
  assert.throws(() => parseTools('export const tools = []', themeCss), /no tools/)
})

test('quotes, escapes and line breaks in a tool object parse', () => {
  const src = `interface Tool { title: string; href: string }
export const tools = [
  {
    title: "It's X",
    description:
      'a \\'quoted\\' text',
    href: '/x/y',
    color: 'bg-red-500',
  },
]`
  const [t] = parseTools(src, themeCss)
  assert.deepEqual(
    { id: t.id, title: t.title, description: t.description, initials: t.initials },
    { id: 'x-y', title: "It's X", description: "a 'quoted' text", initials: 'IX' },
  )
})

test('the default underlyings are the web list', () => {
  const { underlyings, fallback } = parseExchanges(
    read('frontend/src/hooks/useSupportedExchanges.ts'),
  )
  assert.deepEqual(underlyings.NFO, ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'])
  assert.deepEqual(Object.keys(underlyings), ['NFO', 'BFO', 'MCX', 'CDS', 'CRYPTO'])
  assert.deepEqual(fallback, ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX', 'CRYPTO'])
  assert.throws(() => parseExchanges('const x = 1'), /UNDERLYINGS/)
})

test('zerodha lists NSE … GLOBAL_INDEX and is IN_stock', () => {
  const names = listOpenalgoDir('broker', { repoRoot: root })
  const brokers = parseBrokers(names, (n) => read(`broker/${n}/plugin.json`))
  assert.equal(brokers.zerodha.type, 'IN_stock')
  assert.equal(brokers.zerodha.leverage, false)
  assert.deepEqual(brokers.zerodha.exchanges.slice(0, 2), ['NSE', 'BSE'])
  assert.equal(brokers.zerodha.exchanges.at(-1), 'GLOBAL_INDEX')
  assert.ok(Object.values(brokers).some((b) => b.type === 'crypto'))
  assert.equal(brokers.__init__, undefined)
  assert.equal(brokers.__pycache__, undefined)
  assert.ok(brokers.dhan_sandbox, 'dhan_sandbox (underscore folder) is a real broker')
})

test('every broker folder with a plugin.json at the ref is in BROKERS', () => {
  const names = listOpenalgoDir('broker', { repoRoot: root })
  const brokers = parseBrokers(names, (n) => read(`broker/${n}/plugin.json`))
  const withPlugin = names.filter((n) => {
    if (n === '__pycache__') return false
    try {
      read(`broker/${n}/plugin.json`)
      return true
    } catch {
      return false
    }
  })
  assert.ok(withPlugin.length > 0)
  assert.deepEqual(Object.keys(brokers).sort(), withPlugin.sort())
})

test('a plugin.json without exchanges fails loudly', () => {
  assert.throws(
    () => parseBrokers(['x'], () => '{"broker_type":"IN_stock"}'),
    /supported_exchanges/,
  )
})

test('--check fails when a generated file is stale', () => {
  const out = mkdtempSync(join(tmpdir(), 'oa-gen-'))
  const run = (...a) =>
    execFileSync('node', [join(root, 'scripts/gen-frontend.mjs'), '--out', out, ...a], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  assert.throws(() => run('--check'), /stale/) // nothing generated there yet
  run()
  run('--check')
  const f = join(out, 'src/market/tools/registry.ts')
  writeFileSync(f, readFileSync(f, 'utf8').replace("'Option Chain'", "'Option Chains'"))
  assert.throws(() => run('--check'), /stale/)
  run()
  run('--check')
})

test("the tool pages' copy of index.css drops only its two package @imports", () => {
  const src = read('frontend/src/index.css')
  const css = renderFrontendIndexCss({ src, ref: 'c8b2896' })
  assert.match(css.split('\n')[0], /^\/\* GENERATED from openalgo c8b2896 .*Do not edit\. \*\/$/)
  assert.doesNotMatch(css, /@import\s+["'](tailwindcss|tw-animate-css)["']/)
  // everything else is the web's, line for line
  const kept = src
    .split('\n')
    .filter((l) => !/^@import\s+["'](tailwindcss|tw-animate-css)["'];\s*$/.test(l))
  assert.equal(css.split('\n').slice(1).join('\n'), kept.join('\n'))
  assert.match(css, /@custom-variant dark/)
  assert.match(css, /@theme inline/)
})

test('an index.css without both package @imports fails loudly', () => {
  assert.throws(
    () => renderFrontendIndexCss({ src: '@import "tailwindcss";\n:root{}', ref: 'x' }),
    /tw-animate-css/,
  )
  assert.throws(
    () =>
      renderFrontendIndexCss({
        src: '@import "tailwindcss";\n@import "tw-animate-css";\n@import "./other.css";\n',
        ref: 'x',
      }),
    /other\.css/,
  )
})

test('gen-frontend writes src/dom/tools/frontend-index.css and --check finds it stale', () => {
  const out = mkdtempSync(join(tmpdir(), 'oa-gen-css-'))
  try {
    const run = (...a) =>
      execFileSync('node', [join(root, 'scripts/gen-frontend.mjs'), '--out', out, ...a], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    run()
    const f = join(out, 'src/dom/tools/frontend-index.css')
    assert.equal(
      readFileSync(f, 'utf8'),
      renderFrontendIndexCss({ src: read('frontend/src/index.css'), ref: readRef(root) }),
    )
    run('--check')
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n.x{}`)
    assert.throws(() => run('--check'), /frontend-index\.css is stale/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
