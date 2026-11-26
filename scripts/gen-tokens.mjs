// Generates src/ui/tokens.ts from the pinned openalgo web CSS. `--check` fails if it is stale.
// The trade-colour map (with file:line citations) lives in lib/css-tokens.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTokens, renderTokensTs } from './lib/css-tokens.mjs'
import { readOpenalgoFile, readRef } from './openalgo-src.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src/ui/tokens.ts')
const indexCss = readOpenalgoFile('frontend/src/index.css', { repoRoot: root })
const themeCss = readFileSync(join(root, 'node_modules/tailwindcss/theme.css'), 'utf8')
const text = renderTokensTs(buildTokens({ indexCss, themeCss }), readRef(root))

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(out, 'utf8')
  } catch {}
  if (current !== text) {
    console.error('tokens.ts is stale: run npm run tokens')
    process.exit(1)
  }
} else {
  writeFileSync(out, text)
}
