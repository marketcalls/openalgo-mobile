const fs = require('node:fs')
const path = require('node:path')
const { applyReleaseSigning } = require('./releaseSigning')

const fixture = fs.readFileSync(
  path.join(__dirname, '../test/fixtures/android/app-build.gradle'),
  'utf8',
)

function block(gradle, header) {
  const start = gradle.indexOf(header)
  if (start < 0) throw new Error(`no ${header}`)
  let depth = 0
  for (let i = gradle.indexOf('{', start); i < gradle.length; i++) {
    if (gradle[i] === '{') depth++
    if (gradle[i] === '}' && --depth === 0) return gradle.slice(start, i + 1)
  }
  throw new Error('unbalanced')
}

describe('applyReleaseSigning', () => {
  test('adds a release signing config that reads the OA_ environment', () => {
    const out = applyReleaseSigning(fixture)
    const signing = block(out, 'signingConfigs {')
    expect(signing).toMatch(/release \{/)
    for (const name of [
      'OA_KEYSTORE_PATH',
      'OA_KEYSTORE_PASSWORD',
      'OA_KEY_ALIAS',
      'OA_KEY_PASSWORD',
    ]) {
      expect(signing).toContain(`System.getenv('${name}')`)
    }
    expect(signing).toContain('debug {')
  })

  test('the release build type uses the release key only when a keystore is given', () => {
    const release = block(block(applyReleaseSigning(fixture), 'buildTypes {'), 'release {')
    expect(release).toContain(
      "signingConfig System.getenv('OA_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug",
    )
    expect(release).not.toMatch(/signingConfig signingConfigs\.debug/)
  })

  test('the debug build type keeps the debug key', () => {
    const debug = block(block(applyReleaseSigning(fixture), 'buildTypes {'), 'debug {')
    expect(debug).toContain('signingConfig signingConfigs.debug')
  })

  test('applying twice gives the same output as applying once', () => {
    const once = applyReleaseSigning(fixture)
    expect(applyReleaseSigning(once)).toBe(once)
  })

  test('a file without the anchors throws', () => {
    expect(() => applyReleaseSigning('android { }')).toThrow('release signing anchors not found')
    expect(() =>
      applyReleaseSigning(
        fixture.replace(/(release \{[\s\S]*?)signingConfig signingConfigs\.debug/, '$1'),
      ),
    ).toThrow('release signing anchors not found')
  })
})

describe('app.config', () => {
  test('includes the release signing plugin', () => {
    const config = require('../app.config').default({ config: {} })
    expect(config.plugins).toContain('./plugins/withReleaseSigning')
  })
})
