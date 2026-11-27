import fs from 'node:fs'
import path from 'node:path'
import type { ConfigContext } from 'expo/config'
import createConfig from '../app.config'
import pkg from '../package.json'

const root = path.resolve(__dirname, '..')
const ctx = { config: {} } as ConfigContext

function build(buildNumber?: string) {
  const saved = process.env.BUILD_NUMBER
  if (buildNumber === undefined) delete process.env.BUILD_NUMBER
  else process.env.BUILD_NUMBER = buildNumber
  try {
    return createConfig(ctx)
  } finally {
    if (saved === undefined) delete process.env.BUILD_NUMBER
    else process.env.BUILD_NUMBER = saved
  }
}

describe('app.config', () => {
  test('identity', () => {
    const c = build()
    expect(c.name).toBe('OpenAlgo')
    expect(c.slug).toBe('openalgo-mobile')
    expect(c.ios?.bundleIdentifier).toBe('in.openalgo.mobile')
    expect(c.android?.package).toBe('in.openalgo.mobile')
    expect(c.version).toBe(pkg.version)
  })

  test('BUILD_NUMBER drives versionCode and buildNumber', () => {
    const c = build('42')
    expect(c.android?.versionCode).toBe(42)
    expect(c.ios?.buildNumber).toBe('42')
  })

  test('unset BUILD_NUMBER gives 1', () => {
    const c = build()
    expect(c.android?.versionCode).toBe(1)
    expect(c.ios?.buildNumber).toBe('1')
  })

  test('a malformed BUILD_NUMBER throws', () => {
    expect(() => build('4x')).toThrow(/BUILD_NUMBER must be a positive integer/)
  })

  test('Android: no backup, cleartext allowed (the URL rule is enforced in app code)', () => {
    const c = build()
    expect(c.android?.allowBackup).toBe(false)
    const entry = (c.plugins ?? []).find(
      (p) => Array.isArray(p) && p[0] === 'expo-build-properties',
    )
    expect(entry).toBeDefined()
    const opts = (entry as [string, { android: { usesCleartextTraffic: boolean } }])[1]
    expect(opts.android.usesCleartextTraffic).toBe(true)
  })

  test('iOS: local networking only, never arbitrary loads', () => {
    const c = build()
    const info = c.ios?.infoPlist ?? {}
    expect(info.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true })
    expect(JSON.stringify(c)).not.toContain('NSAllowsArbitraryLoads')
    expect(info.NSLocalNetworkUsageDescription).toBe(
      'OpenAlgo connects to your OpenAlgo server on your home network.',
    )
  })

  test('extra and experiments', () => {
    const c = build()
    expect(c.extra?.minServerVersion).toBe('2.0.0.0')
    expect(c.experiments?.typedRoutes).toBe(true)
    expect(c.experiments?.reactCompiler).toBe(true)
  })
})

/** Width, height and colour type (2 RGB, 6 RGBA) from a PNG's IHDR chunk. */
function png(file: string) {
  const b = fs.readFileSync(path.join(root, file))
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  expect(b.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] }
}

const RGB = 2
const RGBA = 6

describe('brand images (assets/brand/README.md)', () => {
  const splash = () => {
    const entry = (build().plugins ?? []).find(
      (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
    )
    expect(entry).toBeDefined()
    return (entry as [string, Record<string, unknown>])[1]
  }

  test('the app icon is 1024 px with no alpha channel, as the App Store requires', () => {
    expect(build().icon).toBe('./assets/images/icon.png')
    expect(png('assets/images/icon.png')).toEqual({ width: 1024, height: 1024, colorType: RGB })
  })

  test('the Android adaptive icon: a transparent mark over black, with a themed monochrome', () => {
    const icon = build().android?.adaptiveIcon
    expect(icon).toEqual({
      backgroundColor: '#000000',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    })
    for (const f of [icon?.foregroundImage, icon?.monochromeImage]) {
      expect(png(String(f))).toEqual({ width: 1024, height: 1024, colorType: RGBA })
    }
  })

  test('the splash: the white logo on black, the same in light and dark mode', () => {
    const s = splash()
    expect(s).toEqual({
      backgroundColor: '#000000',
      image: './assets/images/splash-icon.png',
      imageWidth: 200,
    })
    expect(s.dark).toBeUndefined()
    expect(png('assets/images/splash-icon.png')).toEqual({
      width: 1024,
      height: 1024,
      colorType: RGBA,
    })
  })

  test('the favicon is 48 px', () => {
    expect(build().web?.favicon).toBe('./assets/images/favicon.png')
    expect(png('assets/images/favicon.png')).toEqual({ width: 48, height: 48, colorType: RGB })
  })

  test('the in-app mark is 64 px at 1x, with 2x and 3x', () => {
    for (const [suffix, size] of [
      ['', 64],
      ['@2x', 128],
      ['@3x', 192],
    ] as const) {
      expect(png(`assets/brand/openalgo-mark${suffix}.png`)).toEqual({
        width: size,
        height: size,
        colorType: RGBA,
      })
    }
  })

  test('assets/images holds only the images the config uses: no template images left', () => {
    const used = new Set(JSON.stringify(build()).match(/\.\/assets\/images\/[^"]+/g))
    const files = fs
      .readdirSync(path.join(root, 'assets/images'))
      .filter((f) => !f.startsWith('.')) // .DS_Store
      .map((f) => `./assets/images/${f}`)
    expect(files.sort()).toEqual([...used].sort())
  })
})

describe('tooling config', () => {
  test('tsconfig excludes openalgo and the boundary fixtures, and loads jest and node types', () => {
    // tsconfig allows comments, so evaluate it as JS rather than JSON.parse
    const tsconfig = new Function(
      `return (${fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')})`,
    )()
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['openalgo', 'test/fixtures']))
    expect(tsconfig.compilerOptions.types).toEqual(expect.arrayContaining(['jest', 'node']))
    // files tsc reaches through @/ are checked; openalgo/ itself is not included
    expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['./openalgo/frontend/src/*'])
  })

  test.each(['jest.config.js', 'jest.compat.config.js', 'jest.real.config.js'])(
    "%s runs none of openalgo/'s tests and resolves @/ into its frontend",
    (file) => {
      const cfg = require(path.join(root, file))
      // jest.config.js holds a "native" and a "dom" project, and each one needs the patterns.
      for (const project of cfg.projects ?? [cfg]) {
        expect(project.testPathIgnorePatterns).toContain('<rootDir>/openalgo/')
        expect(project.moduleNameMapper['^@/(.*)$']).toBe('<rootDir>/openalgo/frontend/src/$1')
        expect(project.modulePathIgnorePatterns ?? []).not.toContain('<rootDir>/openalgo/')
      }
    },
  )
})
