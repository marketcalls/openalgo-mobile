// Generates the tool registry, the web's default underlyings and the broker exchange map from the
// pinned openalgo source. `--check` fails if a generated file is stale. `--out <dir>` writes (or
// checks) under <dir> instead of the repo root.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseBrokers,
  parseExchanges,
  parseTools,
  renderBrokersRegistry,
  renderToolsRegistry,
} from './lib/frontend-gen.mjs'
import { listOpenalgoDir, readOpenalgoFile, readRef } from './openalgo-src.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outRoot = outIdx >= 0 ? resolve(argv[outIdx + 1]) : root
const read = (rel) => readOpenalgoFile(rel, { repoRoot: root })
const ref = readRef(root)
const themeCss = readFileSync(join(root, 'node_modules/tailwindcss/theme.css'), 'utf8')

const tools = parseTools(read('frontend/src/lib/tools.ts'), themeCss)
const { underlyings, fallback } = parseExchanges(
  read('frontend/src/hooks/useSupportedExchanges.ts'),
)
const brokers = parseBrokers(listOpenalgoDir('broker', { repoRoot: root }), (n) =>
  read(`broker/${n}/plugin.json`),
)

const files = {
  'src/market/tools/registry.ts': renderToolsRegistry({ tools, underlyings, fallback, ref }),
  'src/market/brokers/registry.ts': renderBrokersRegistry({ brokers, ref }),
}

if (argv.includes('--check')) {
  const stale = []
  for (const [rel, text] of Object.entries(files)) {
    let current = ''
    try {
      current = readFileSync(join(outRoot, rel), 'utf8')
    } catch {}
    if (current !== text) stale.push(rel)
  }
  if (stale.length) {
    console.error(`${stale.join(', ')} is stale: run npm run gen:frontend`)
    process.exit(1)
  }
} else {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(outRoot, rel)), { recursive: true })
    writeFileSync(join(outRoot, rel), text)
  }
}
