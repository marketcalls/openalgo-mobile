// The phone stylesheets as written (ux-bar §1 G1, G19 and T11-02, T11-11, T11-16): what every
// rule may target and how. T15's selector contract then checks each rule against the pages.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_PAGE_IDS } from '~/dom/bridge/protocol'

const FILES = ['phone.css', 'options.phone.css', 'portfolio.phone.css', 'rotation.phone.css']
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8')

/** The style rules of a stylesheet, media rules opened, as the browser parses them. */
function rulesOf(css: string): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const out: CSSStyleRule[] = []
  const walk = (list: CSSRuleList) => {
    for (const r of Array.from(list)) {
      if ('cssRules' in r && !('selectorText' in r)) walk((r as CSSMediaRule).cssRules)
      else if ('selectorText' in r) out.push(r as CSSStyleRule)
    }
  }
  walk((style.sheet as CSSStyleSheet).cssRules)
  style.remove()
  return out
}
/** Each selector of a rule's list, split at top-level commas. */
function selectorsOf(rule: CSSStyleRule): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of rule.selectorText) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}
const all = FILES.flatMap((f) => rulesOf(read(f)).map((rule) => ({ file: f, rule })))

test('every stylesheet parses into rules, and the tool.css imports it in order', () => {
  for (const f of FILES) expect(rulesOf(read(f)).length).toBeGreaterThan(0)
  const tool = read('tool.css')
  const lines = tool.split('\n').filter((l) => l.startsWith('@'))
  expect(lines).toEqual([
    '@import "tailwindcss" source(none);',
    '@import "tw-animate-css";',
    '@import "./frontend-index.css";',
    '@import "./phone.css";',
    '@source "../../../openalgo/frontend/src";',
    '@source not "../../../openalgo/frontend/src/components/trading/TickBox.tsx";',
    '@source ".";',
  ])
})

test('nothing clips sideways and nothing styles the body alone (T11-02, G1)', () => {
  // an ellipsized cell may hide its own overflow; nothing hides the page's sideways overflow
  for (const f of FILES) expect(read(f)).not.toMatch(/overflow-x\s*:\s*hidden/)
  for (const { file, rule } of all) {
    for (const sel of selectorsOf(rule)) {
      // the G1 rule `html, body` is the one exception
      if (sel === 'body') expect(rule.selectorText.replace(/\s/g, '')).toBe('html,body')
      if (sel === 'body') expect(file).toBe('phone.css')
    }
  }
  const g1 = all.find(({ rule }) => rule.selectorText.replace(/\s/g, '') === 'html,body')?.rule
  expect(g1?.style.getPropertyValue('overflow-x')).toBe('clip')
  expect(g1?.style.getPropertyValue('max-width')).toBe('100vw')
})

test('portals are styled from <html>, never from inside #oa-tool (T11-11, G19)', () => {
  const PORTALED =
    /data-slot="?(select-content|select-item|popover-content|command|dialog-content|alert-dialog-content|tooltip-content)/
  for (const { rule } of all) {
    for (const sel of selectorsOf(rule)) {
      // a portal's own rule (not one that only asks whether a portal is open, as T11-11's
      // `body:has(...) #oa-tool` does)
      if (PORTALED.test(sel) && !/#oa-tool$/.test(sel)) {
        expect(sel).not.toMatch(
          /#oa-tool[^,]*data-slot="?(select-content|popover-content|command|dialog)/,
        )
        expect(sel).toMatch(/^html\[data-oa-tool/)
      }
      // class words with ~=, never a substring of the class attribute
      expect(sel).not.toMatch(/\[class\*=/)
    }
  }
})

test("openalgo-charts' vertical swipe goes to the page: pan-y beats the holder's inline none (T11-16)", () => {
  // openalgo-charts 2.7.3 gives its holder role=application and an inline touch-action of none
  const lib = readFileSync(require.resolve('openalgo-charts'), 'utf8')
  expect(lib).toMatch(
    /style\.touchAction="none",\w+\.getAttribute\("role"\)\|\|\w+\.setAttribute\("role","application"\)/,
  )
  const rule = all.find(({ rule }) =>
    selectorsOf(rule).some((s) => s.includes('[role="application"]')),
  )?.rule
  expect(rule?.style.getPropertyValue('touch-action')).toBe('pan-y')
  expect(rule?.style.getPropertyPriority('touch-action')).toBe('important')
})

test('every rule names the pages it is for, and only pages there are (G19)', () => {
  const ids = new Set<string>(TOOL_PAGE_IDS)
  for (const f of FILES) {
    // other comments go; each rule's prelude (the text since the last brace) holds its tag
    const css = read(f).replace(/\/\*(?!\s*@pages)[\s\S]*?\*\//g, '')
    const preludes = [...css.matchAll(/(?:^|[{}])([^{}]*)\{/g)].map((m) => m[1] ?? '')
    const rules = preludes.filter(
      (p) =>
        !p
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
          .startsWith('@'),
    )
    expect(rules.length).toBeGreaterThan(0)
    for (const prelude of rules) {
      const tag = /\/\*\s*@pages ([^*]+?)\s*\*\//.exec(prelude)
      const selector = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      expect({ f, selector, tagged: tag !== null }).toEqual({ f, selector, tagged: true })
      // `none`: what no state of T15's contract renders (plan F's dialog footers, Plotly's own
      // mode bar under the contract's Plot stub); T15 skips it
      const tagged = (tag?.[1] ?? '').split(/\s+/)
      if (tagged.length === 1 && tagged[0] === 'none') continue
      for (const id of tagged) expect({ f, id, page: ids.has(id) }).toEqual({ f, id, page: true })
    }
  }
})
