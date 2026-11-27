// The React Compiler (app.config.ts experiments.reactCompiler) memoizes a useMemo on the values
// its callback reads and drops any other listed dependency. A tick counter that only re-ran a
// memo (useChainFeed's `beat`, useLiveLtps' `version`, the watchlist's `focus` and `seeded`) was
// dropped in the shipped bundle: the chain's spot marker lagged its header, the Portfolio
// screen's live prices froze. Each is now an argument of the memo's work; this compiles the
// three files as Metro does for a release and checks each memo's guard holds its counter.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const babel = require('@babel/core')

function compiled(file) {
  return babel.transformFileSync(`${ROOT}${file}`, {
    cwd: ROOT,
    filename: `${ROOT}${file}`,
    configFile: `${ROOT}babel.config.js`,
    babelrc: false,
    caller: { name: 'metro', bundler: 'metro', platform: 'ios', supportsReactCompiler: true },
  }).code
}

/** The names the compiled guard in front of `call(` compares, as `$[n]!==name`. */
function guardOf(code, call) {
  const m = new RegExp(`if\\(([^{]*)\\)\\{t\\d+=${call}\\(`).exec(code)
  assert.ok(m, `no compiled memo around ${call}(`)
  return [...m[1].matchAll(/!==([\w.$]+)/g)].map((x) => x[1])
}

test('the chain pricing memo re-runs on its throttled tick', () => {
  const code = compiled('src/features/optionchain/hooks/useChainFeed.ts')
  assert.match(code, /react\/compiler-runtime/)
  assert.ok(guardOf(code, 'pricedAt').includes('beat'))
})

test('the live LTPs memo re-runs on each tick', () => {
  const code = compiled('src/market/books/useLiveLtps.ts')
  assert.ok(guardOf(code, 'ltpsAt').includes('version'))
})

test('the watchlist snapshot is retaken on focus and on the first seed', () => {
  const guard = guardOf(
    compiled('src/features/watchlist/screens/WatchlistScreen.tsx'),
    'snapshotAt',
  )
  assert.ok(guard.includes('focus'))
  assert.ok(guard.includes('seeded'))
})
