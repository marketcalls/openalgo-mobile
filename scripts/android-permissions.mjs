#!/usr/bin/env node
// The Android permissions of a release build, with no prebuild and no native build. Two sources
// make the merged manifest: the app's own manifest, as `npx expo config --type introspect` makes
// it (the template and the config plugins, each blockedPermissions entry as tools:node="remove"),
// and the src/main/AndroidManifest.xml of every native package, which Gradle's manifest merger
// adds unless the app's manifest removes it. Debug-only manifests (src/debug) are not shipped.
// Maven AARs (androidx.biometric and the like) are not read: `aapt2 dump permissions` on a built
// APK is the full answer.
//
// Prints JSON: { app: [{ name, remove }], libraries: { <package>: [name] }, final: [name] }.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const from = { paths: [require.resolve('expo/package.json')] }
const { getPrebuildConfigAsync } = require(require.resolve('@expo/prebuild-config', from))
const { compileModsAsync } = require(require.resolve('@expo/config-plugins', from))

async function appManifest() {
  const { exp } = await getPrebuildConfigAsync(root, { platforms: ['android'] })
  const out = await compileModsAsync(exp, {
    projectRoot: root,
    introspect: true,
    platforms: ['android'],
    assertMissingModProviders: false,
  })
  const manifest = out._internal.modResults.android.manifest.manifest
  return (manifest['uses-permission'] ?? []).map(({ $ }) => ({
    name: $['android:name'],
    remove: $['tools:node'] === 'remove',
  }))
}

/** Every package folder under node_modules, scoped ones and one nested level included. */
function packages(dir, depth = 0) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (!e.isDirectory() || e.name.startsWith('.')) return []
    const at = join(dir, e.name)
    if (e.name.startsWith('@')) return packages(at, depth)
    const nested = depth === 0 ? packages(join(at, 'node_modules'), 1) : []
    return [at, ...nested]
  })
}

const USES = /<uses-permission(?:-sdk-23)?\b[^>]*?android:name="([^"]+)"/g

function libraryManifests() {
  const out = {}
  for (const pkg of packages(join(root, 'node_modules'))) {
    const file = join(pkg, 'android', 'src', 'main', 'AndroidManifest.xml')
    if (!existsSync(file)) continue
    const names = [...readFileSync(file, 'utf8').matchAll(USES)].map((m) => m[1])
    if (names.length) out[pkg.slice(root.length + 1)] = [...new Set(names)].sort()
  }
  return out
}

const app = await appManifest()
const libraries = libraryManifests()
const removed = new Set(app.filter((p) => p.remove).map((p) => p.name))
const final = [
  ...new Set([
    ...app.filter((p) => !p.remove).map((p) => p.name),
    ...Object.values(libraries).flat(),
  ]),
]
  .filter((name) => !removed.has(name))
  .sort()
process.stdout.write(`${JSON.stringify({ app, libraries, final }, null, 2)}\n`)
