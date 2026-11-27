// `npm run export`: the Android and iOS bundles plus the DOM pages, into dist-export.
// A two-platform `expo export` with tree shaking fails ("Missing AST for module:
// node_modules/expo/dom/entry.js": the two platforms bundle the same DOM entries at once and
// share their modules), so each platform is exported on its own and the iOS output is merged
// into the Android one. `--clear` makes the first run cold; the second reuses its tree-shaken cache.
// The tree-shaking flags come from the environment (the package script and CI set them).
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function files(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)],
  )
}

/** Copy the iOS export's files into the Android export and list the iOS bundle in metadata.json.
 *  A file both exports hold (the DOM pages, shared assets) must be byte-identical. */
export function mergeExports(androidDir, iosDir) {
  const meta = JSON.parse(readFileSync(join(androidDir, 'metadata.json'), 'utf8'))
  const iosMeta = JSON.parse(readFileSync(join(iosDir, 'metadata.json'), 'utf8'))
  for (const f of files(iosDir)) {
    if (f === 'metadata.json') continue
    const to = join(androidDir, f)
    if (existsSync(to)) {
      if (!readFileSync(to).equals(readFileSync(join(iosDir, f)))) {
        throw new Error(`${f} differs between the Android and the iOS export`)
      }
      continue
    }
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(join(iosDir, f), to)
  }
  meta.fileMetadata.ios = iosMeta.fileMetadata.ios
  writeFileSync(join(androidDir, 'metadata.json'), JSON.stringify(meta))
}

function expoExport(platform, outDir, extra = []) {
  const r = spawnSync(
    'npx',
    ['expo', 'export', ...extra, '--platform', platform, '--output-dir', outDir],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) throw new Error(`expo export (${platform}) exited ${r.status}`)
}

function main() {
  const out = resolve('dist-export')
  const ios = resolve('dist-export-ios')
  expoExport('android', out, ['--clear'])
  expoExport('ios', ios)
  mergeExports(out, ios)
  rmSync(ios, { recursive: true, force: true })
  console.log(`Exported: ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
