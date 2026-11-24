// Key scan for the exported bundles (design 8: "bundle scan for key-like strings"). gitleaks'
// openalgo-api-key rule needs `apikey` and a separator before the key, but a Hermes bundle keeps
// its strings back to back with none, so a key inlined at build time passes it. This looks for
// what a key is, 64 lowercase hex characters, anywhere in a run of hex: the strings next to it
// may start or end with a hex letter. The only known runs are the asset hashes (32 hex, the
// asset file names), which Metro lists side by side; they are cut out first.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_LENGTH = 64
const HEX_RUN = new RegExp(`[0-9a-f]{${KEY_LENGTH},}`, 'g')

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

/** The asset hashes: the names of the files in `assets/`, and any listed in metadata.json. */
function assetHashes(dir) {
  const out = new Set()
  try {
    for (const name of readdirSync(join(dir, 'assets')))
      if (/^[0-9a-f]{32}$/.test(name)) out.add(name)
  } catch {}
  try {
    for (const m of readFileSync(join(dir, 'metadata.json'), 'utf8').matchAll(/[0-9a-f]{32}/g)) {
      out.add(m[0])
    }
  } catch {}
  return out
}

/**
 * One line per key-like run in the export's bundles and metadata (the image and font files under
 * `assets/` are skipped). A line names the file, the byte offset and the run's length, never the
 * characters.
 */
export function scanExport(dir) {
  const hashes = assetHashes(dir)
  const found = []
  for (const file of files(dir)) {
    const rel = relative(dir, file)
    if (rel.split(sep)[0] === 'assets') continue
    const text = readFileSync(file).toString('latin1')
    for (const m of text.matchAll(HEX_RUN)) {
      let rest = m[0]
      for (const h of hashes) rest = rest.split(h).join(' ')
      if (rest.split(' ').some((part) => part.length >= KEY_LENGTH)) {
        found.push(`${rel}: a run of ${m[0].length} hex characters at byte ${m.index}`)
      }
    }
  }
  return found
}

function main(argv) {
  const dir = argv[0]
  if (!dir) {
    console.error('usage: check-bundle-keys.mjs <export-dir>')
    return 2
  }
  const found = scanExport(resolve(dir))
  for (const line of found) console.log(line)
  if (found.length > 0) {
    console.log(
      `FAILED: ${found.length} key-like string(s); an API key must never ship in a bundle`,
    )
    return 1
  }
  console.log('ok: no key-like string in the bundles')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
