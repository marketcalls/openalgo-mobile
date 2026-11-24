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

describe('tooling config', () => {
  test('tsconfig excludes openalgo and the boundary fixtures, and loads jest and node types', () => {
    // tsconfig allows comments, so evaluate it as JS rather than JSON.parse
    const tsconfig = new Function(
      `return (${fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')})`,
    )()
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['openalgo', 'test/fixtures']))
    expect(tsconfig.compilerOptions.types).toEqual(expect.arrayContaining(['jest', 'node']))
  })

  test.each(['jest.config.js', 'jest.compat.config.js', 'jest.real.config.js'])(
    '%s ignores the checked-out openalgo/ folder',
    (file) => {
      const cfg = require(path.join(root, file))
      expect(cfg.testPathIgnorePatterns).toContain('<rootDir>/openalgo/')
      expect(cfg.modulePathIgnorePatterns).toContain('<rootDir>/openalgo/')
    },
  )
})
