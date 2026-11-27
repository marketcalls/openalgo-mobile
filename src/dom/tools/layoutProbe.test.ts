// The layout probe (ux-bar T11-03): how far anything on the tool page reaches past the viewport's
// left or right edge, posted to native (T12's `tool-layout`, T16's "overflow 0").
import { createLayoutProbe, PROBE_IDLE_MS } from './layoutProbe'

type Rect = { left: number; right: number }
const rects = new Map<Element, Rect>()
const realRect = Element.prototype.getBoundingClientRect

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this) ?? { left: 0, right: 0 }
    return {
      ...r,
      top: 0,
      bottom: 10,
      width: r.right - r.left,
      height: 10,
      x: r.left,
      y: 0,
    } as DOMRect
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 })
})
afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect
})
beforeEach(() => {
  jest.useFakeTimers()
  document.body.innerHTML =
    '<div id="root"><main id="oa-tool"><div data-oa-route="root"><div class="page">' +
    '<div class="row"><span class="badge">a</span></div>' +
    '<div class="scroller" style="overflow-x: auto"><table><tr><td class="wide">x</td></tr></table></div>' +
    '</div></div></main></div>'
})
afterEach(() => {
  rects.clear()
  jest.useRealTimers()
})

const el = (sel: string) => document.querySelector(sel) as Element
const frames = async () => {
  // two animation frames, then the settle delay
  await jest.advanceTimersByTimeAsync(1_000)
}

test('reports 0 when everything fits, and the widest overflow when not', async () => {
  const sent: number[] = []
  const probe = createLayoutProbe(window, (overflow) => sent.push(overflow))
  rects.set(el('.badge'), { left: 16, right: 344 })
  probe.start()
  await frames()
  expect(sent).toEqual([0])

  rects.set(el('.badge'), { left: 16, right: 401.6 })
  el('.row').append(document.createElement('i'))
  await frames()
  expect(sent).toEqual([0, 41])
  probe.stop()
})

test('what starts left of the screen counts too: a label placed beside a long bar ran off it', async () => {
  // the Crisis rows' return label ("-31.0% vs -34.0%") began 24 px left of the screen, read as
  // "0% vs -34.0%", and the probe, measuring the right edge only, said 0 (E-PR-2)
  const sent: number[] = []
  const probe = createLayoutProbe(window, (overflow) => sent.push(overflow))
  rects.set(el('.badge'), { left: -24, right: 84 })
  probe.start()
  await frames()
  expect(sent).toEqual([24])
  // the worse edge wins
  rects.set(el('.badge'), { left: -10, right: 395 })
  el('.row').append(document.createElement('i'))
  await frames()
  expect(sent).toEqual([24, 35])
  probe.stop()
})

test('a table inside its own sideways scroller is not an overflow', async () => {
  const sent: number[] = []
  const probe = createLayoutProbe(window, (overflow) => sent.push(overflow))
  rects.set(el('.wide'), { left: 16, right: 900 })
  probe.start()
  await frames()
  expect(sent).toEqual([0])
  probe.stop()
})

test('an open portal (a picker sheet) counts', async () => {
  const sent: number[] = []
  const probe = createLayoutProbe(window, (overflow) => sent.push(overflow))
  probe.start()
  await frames()
  const portal = document.createElement('div')
  portal.setAttribute('data-radix-popper-content-wrapper', '')
  portal.innerHTML = '<div data-slot="popover-content"><input></div>'
  document.body.append(portal)
  rects.set(portal.querySelector('input') as Element, { left: 0, right: 380 })
  await frames()
  expect(sent).toEqual([0, 20])
  probe.stop()
})

test('at most 5 reports, only when the value changes, and it lets go after 10 s idle', async () => {
  const sent: number[] = []
  const probe = createLayoutProbe(window, (overflow) => sent.push(overflow))
  probe.start()
  await frames()
  for (let i = 1; i <= 8; i++) {
    rects.set(el('.badge'), { left: 0, right: 360 + i })
    el('.row').append(document.createElement('i'))
    await frames()
  }
  expect(sent).toEqual([0, 1, 2, 3, 4])

  // idle: no observer is left behind
  rects.set(el('.badge'), { left: 0, right: 300 })
  const sent2: number[] = []
  const quiet = createLayoutProbe(window, (overflow) => sent2.push(overflow))
  quiet.start()
  await frames()
  await jest.advanceTimersByTimeAsync(PROBE_IDLE_MS + 1)
  rects.set(el('.badge'), { left: 0, right: 500 })
  el('.row').append(document.createElement('i'))
  await frames()
  expect(sent2).toEqual([0])
  // a route or tab change starts it again
  quiet.start()
  await frames()
  expect(sent2).toEqual([0, 140])
  quiet.stop()
  probe.stop()
})
