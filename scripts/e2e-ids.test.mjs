// The Maestro flows may only tap ids the README lists, and every id the README lists must
// still exist in src/. A renamed testID then fails here, not in the CI emulator.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const e2e = join(root, 'e2e')

/** Backticked ids under "## Test IDs" in the README; `{X}` stands for a dynamic part. */
function readmeTemplates() {
  const text = readFileSync(join(e2e, 'README.md'), 'utf8')
  const section = text.split(/^## Test IDs$/m)[1]
  assert.ok(section, 'e2e/README.md has no "## Test IDs" section')
  const out = new Set()
  for (const m of section.matchAll(/`([a-z][A-Za-z0-9{}&_-]*)`/g)) out.add(m[1])
  return [...out]
}

const toRegExp = (template) =>
  new RegExp(
    `^${template
      .split(/\{[A-Za-z]+\}/)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[A-Z0-9&_-]+')}$`,
  )

function flowIds() {
  const out = []
  for (const f of readdirSync(e2e).filter((n) => n.endsWith('.yaml'))) {
    const lines = readFileSync(join(e2e, f), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      const m = line.match(/^\s*(?:-\s*)?id:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/)
      if (m) out.push({ file: f, line: i + 1, id: m[1] })
    }
  }
  return out
}

test('every id in e2e/*.yaml matches a template in e2e/README.md', () => {
  const templates = readmeTemplates().map((t) => ({ t, re: toRegExp(t) }))
  const ids = flowIds()
  assert.ok(ids.length > 0, 'no ids found in the flows')
  const missing = ids.filter(({ id }) => !templates.some(({ re }) => re.test(id)))
  assert.deepEqual(
    missing.map((m) => `${m.file}:${m.line} ${m.id}`),
    [],
  )
})

test('every README template has its static prefix in src/', () => {
  const missing = []
  for (const t of readmeTemplates()) {
    const prefix = t.split('{')[0]
    try {
      execFileSync('grep', ['-rqF', '--', prefix, join(root, 'src')])
    } catch {
      missing.push(t)
    }
  }
  assert.deepEqual(missing, [])
})

test('the trading flows and the mock control script exist and start from a clean app', () => {
  for (const f of ['trading-analyzer', 'trading-semiauto', 'depth-levels']) {
    const text = readFileSync(join(e2e, `${f}.yaml`), 'utf8')
    assert.match(text, /- launchApp:\n\s+clearState: true/, `${f}: launchApp with clearState`)
    assert.match(text, /- runFlow: onboarding-live\.yaml/, `${f}: onboarding first`)
  }
  assert.match(readFileSync(join(e2e, 'scripts', 'mock.js'), 'utf8'), /__mock\/control/)
})

// A header badge (GTT's, the chart's) shows the mode the tabs layout read on mount and on a
// foreground: set later, the flow would see LIVE.
for (const f of ['gtt-analyzer', 'chart-analyzer', 'optionchain-analyzer']) {
  test(`${f} sets analyzer mode before onboarding, so the first mode the app reads is ANALYZE`, () => {
    const text = readFileSync(join(e2e, `${f}.yaml`), 'utf8')
    assert.match(text, /- launchApp:\n\s+clearState: true/)
    const control = text.indexOf(`CONTROL: '{"analyzer":true}'`)
    const onboarding = text.indexOf('- runFlow: onboarding-live.yaml')
    assert.ok(control > 0 && onboarding > 0, 'both steps are in the flow')
    assert.ok(control < onboarding, 'the analyzer control comes before onboarding')
  })
}
