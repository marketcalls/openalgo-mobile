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

// A link from outside the app never opens an order screen (src/app/+native-intent.tsx): on the
// device it would open the instrument sheet, so a flow reaches those screens through the UI.
test('no flow opens the ticket, modify or a GTT screen by link', () => {
  const offending = []
  for (const f of readdirSync(e2e).filter((n) => n.endsWith('.yaml'))) {
    const lines = readFileSync(join(e2e, f), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (/openLink|^\s*link:/.test(line) && /(order|gtt)(\/|%2f)/i.test(line)) {
        offending.push(`${f}:${i + 1} ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offending, [])
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

// ux-bar T16-01 and T16-03: the tool flows check what the trader sees, not only that it loaded.
test('tools-maxpain checks the layout probe and screenshots Max Pain, then GEX and its table', () => {
  const text = readFileSync(join(e2e, 'tools-maxpain.yaml'), 'utf8')
  const at = (s) => {
    const i = text.indexOf(s)
    assert.ok(i >= 0, `tools-maxpain has ${s}`)
    return i
  }
  const layout = '- assertVisible:\n    id: tool-layout\n    text: "overflow 0"'
  const maxPain = at('visible: "Max Pain: \\\\d+"')
  const firstLayout = at(layout)
  assert.ok(maxPain < firstLayout && firstLayout < at('- takeScreenshot: tools-maxpain'))
  const gex = at('id: tool-tile-GEX')
  assert.ok(at('visible: "Net GEX: .*"') > gex)
  assert.ok(text.indexOf(layout, gex) > gex, 'the layout probe again on GEX')
  assert.match(text, /- scrollUntilVisible:\n\s+element: "GEX Table"\n\s+direction: DOWN/)
  assert.ok(at('- takeScreenshot: tools-gex-table') > at('element: "GEX Table"'))
})

test('optionchain-analyzer checks BUY and SELL with no scroll and the chips after a ladder swipe', () => {
  const text = readFileSync(join(e2e, 'optionchain-analyzer.yaml'), 'utf8')
  const at = (s) => {
    const i = text.indexOf(s)
    assert.ok(i >= 0, `optionchain-analyzer has ${s}`)
    return i
  }
  // once the chain opens, nothing scrolls before the ATM call and the leg sheet's two sides
  const sell = at('- assertVisible:\n    id: oc-leg-sell')
  const opened = at('- tapOn:\n    id: tool-tile-OPTIONCHAIN')
  assert.ok(!/scrollUntilVisible|swipe/.test(text.slice(opened, sell)))
  assert.ok(
    at('- assertVisible:\n    id: oc-leg-buy') < sell && sell < at('- takeScreenshot: oc-leg'),
  )
  const swipe = at('- swipe:\n    from:\n      id: oc-ladder\n    direction: UP')
  assert.ok(at('- assertVisible:\n    id: oc-expiry-0') > swipe)
})

test('CI runs the phone pass: both tool flows again at 360 dp, dark, font 1.3, reset in a trap', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const script = ci.slice(
    ci.indexOf('cat > "$RUNNER_TEMP/e2e.sh" <<\'SCRIPT\''),
    ci.indexOf('          SCRIPT\n'),
  )
  const at = (s, from = 0) => {
    const i = script.indexOf(s, from)
    assert.ok(i >= 0, `the e2e script has ${s}`)
    return i
  }
  const trap = at('trap phone_reset EXIT')
  for (const reset of [
    'adb shell wm density reset',
    'adb shell cmd uimode night no',
    'adb shell settings put system font_scale 1.0',
  ]) {
    assert.ok(at(reset) < trap, `phone_reset runs ${reset}`)
  }
  const set = [
    'adb shell wm density 480',
    'adb shell cmd uimode night yes',
    'adb shell settings put system font_scale 1.3',
  ].map((s) => at(s, trap))
  const pass = at('PASS=360-dark-1.3x', trap)
  assert.ok(set.every((i) => i < pass))
  assert.ok(at('run_flow tools-maxpain', pass) < at('run_flow optionchain-analyzer', pass))
  // after the default run of the same flows
  assert.ok(at('run_flow optionchain-analyzer') < trap)
  // the screenshots reach the artifact on a green run too
  assert.match(script, /mv "\$shot" "\$DEBUG\/shots\//)
  assert.match(ci, /- name: Upload the e2e debug output\n\s+if: always\(\)/)
})
