import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mergeExports } from './export.mjs'

function exp(platform, files) {
  const dir = mkdtempSync(join(tmpdir(), `export-${platform}-`))
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  writeFileSync(
    join(dir, 'metadata.json'),
    JSON.stringify({
      fileMetadata: { [platform]: { bundle: `_expo/static/js/${platform}/b.hbc` } },
    }),
  )
  return dir
}

test('the iOS bundle and files join the Android export, and shared DOM files must match', () => {
  const a = exp('android', { '_expo/static/js/android/b.hbc': 'A', 'www.bundle/p.html': 'page' })
  const i = exp('ios', { '_expo/static/js/ios/b.hbc': 'I', 'www.bundle/p.html': 'page' })
  mergeExports(a, i)
  assert.equal(readFileSync(join(a, '_expo/static/js/ios/b.hbc'), 'utf8'), 'I')
  const meta = JSON.parse(readFileSync(join(a, 'metadata.json'), 'utf8'))
  assert.deepEqual(Object.keys(meta.fileMetadata).sort(), ['android', 'ios'])

  const a2 = exp('android', { 'www.bundle/p.html': 'one' })
  const i2 = exp('ios', { 'www.bundle/p.html': 'two' })
  assert.throws(() => mergeExports(a2, i2), /differs between/)
})
