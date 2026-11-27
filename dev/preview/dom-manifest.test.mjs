// The preview's manifest and frame pages (dev/preview/dom-manifest.mjs): each entry's html, and
// beside it the served copy the iframe loads, with the bridge boot first.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = new URL('./dom-manifest.mjs', import.meta.url).pathname

test('each entry maps to its html, and its .frame.html boots the bridge from the query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dom-manifest-'))
  const www = join(dir, 'www.bundle')
  mkdirSync(www)
  const page = (js) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script src="./${js}" defer></script></body></html>`
  writeFileSync(join(www, 'a.js'), 'x="oa-dom:chart"')
  writeFileSync(join(www, 'b.js'), 'x="oa-entry:src/dom/tools/OptionToolsDom.tsx"')
  writeFileSync(join(www, 'chart.html'), page('a.js'))
  writeFileSync(join(www, 'tools.html'), page('b.js'))
  const run = () => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  assert.equal(run().status, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(www, 'entries.json'), 'utf8')), {
    'src/dom/chart/ChartDom.tsx': 'chart.html',
    'src/dom/tools/OptionToolsDom.tsx': 'tools.html',
  })
  const frame = readFileSync(join(www, 'tools.frame.html'), 'utf8')
  assert.match(
    frame,
    /^<!DOCTYPE html><html><head><script>window\.ReactNativeWebView=parent\.__oaDomFrames\[new URLSearchParams\(location\.search\)\.get\("oaframe"\)\];<\/script><meta charset="utf-8">/,
  )
  assert.ok(existsSync(join(www, 'chart.frame.html')))
  // a second run reads past its own frame pages
  assert.equal(run().status, 0)
})
