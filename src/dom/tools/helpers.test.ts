// The shell's touch helpers (ux-bar T11-19) over plain page markup.
import { installHelpers, isNegative } from './helpers'

let dispose: () => void = () => {}
beforeEach(() => {
  jest.useFakeTimers()
  document.body.innerHTML = '<main id="oa-tool"></main>'
})
afterEach(() => {
  dispose()
  jest.useRealTimers()
})
const main = () => document.querySelector('#oa-tool') as HTMLElement
const settle = () => jest.advanceTimersByTimeAsync(0)

test("a picker's search field takes the focus without the keyboard, until it is tapped", async () => {
  dispose = installHelpers(window).dispose
  main().innerHTML = '<input cmdk-input type="text">'
  const input = main().querySelector('input') as HTMLInputElement
  input.focus()
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('inputmode')).toBe('none')
  input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  expect(input.hasAttribute('inputmode')).toBe(false)

  // a field the trader taps opens with the keyboard
  input.blur()
  input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  input.focus()
  expect(input.hasAttribute('inputmode')).toBe(false)
})

test('a focused field scrolls to the top once the keyboard is up', async () => {
  dispose = installHelpers(window).dispose
  main().innerHTML =
    '<input type="number"><div data-radix-popper-content-wrapper><input type="text"></div>'
  const [field, inSheet] = Array.from(document.querySelectorAll('input'))
  const scroll = jest.fn()
  for (const el of [field, inSheet]) (el as HTMLElement).scrollIntoView = scroll
  field?.focus()
  expect(scroll).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(250)
  expect(scroll).toHaveBeenCalledWith({ block: 'start' })
  // a field in a bottom sheet is already in view
  scroll.mockClear()
  inSheet?.focus()
  await jest.advanceTimersByTimeAsync(250)
  expect(scroll).not.toHaveBeenCalled()
})

test('the GEX table opens centred on its ATM row, and leaves it once touched', async () => {
  dispose = installHelpers(window).dispose
  const box = document.createElement('div')
  box.className = 'overflow-x-auto max-h-[500px] overflow-y-auto'
  box.innerHTML =
    '<table><tbody><tr><td>1</td></tr><tr class="border-b bg-yellow-500/10 font-semibold"><td>2</td></tr></tbody></table>'
  Object.defineProperty(box, 'clientHeight', { value: 300 })
  const atm = box.querySelector('tr.font-semibold') as HTMLElement
  Object.defineProperty(atm, 'offsetTop', { value: 900 })
  Object.defineProperty(atm, 'offsetHeight', { value: 30 })
  main().append(box)
  await settle()
  expect(box.scrollTop).toBe(765)

  // the trader scrolled it: a refresh does not pull it back
  box.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  box.scrollTop = 10
  const row = atm.cloneNode(true) as HTMLElement
  atm.replaceWith(row)
  await settle()
  expect(box.scrollTop).toBe(10)
})

test("a 'good' green on a negative value is marked as a loss", async () => {
  dispose = installHelpers(window).dispose
  main().innerHTML =
    '<div class="text-2xl text-emerald-500">-12.40%</div><div class="text-emerald-500">8.10%</div>'
  await settle()
  const [neg, pos] = Array.from(main().children) as HTMLElement[]
  expect(neg?.dataset.oaSign).toBe('neg')
  expect(pos?.dataset.oaSign).toBeUndefined()
  // the value turns positive on a refresh
  if (neg) neg.textContent = '3.00%'
  await settle()
  expect(neg?.dataset.oaSign).toBeUndefined()
  expect(['-1', '−₹4', ' - 2.5'].map(isNegative)).toEqual([true, true, true])
  expect(['-', '—', '1-2', 'n/a'].map(isNegative)).toEqual([false, false, false, false])
})

test('a new route wakes the observer: a report that mounts after 10 s idle gets its loss marks at once', async () => {
  // the Portfolio Backtester's builder changes nothing while its run is out (> 10 s), then
  // navigates to the report, whose Total Return is always the page's emerald (tone="good")
  const h = installHelpers(window)
  dispose = h.dispose
  await jest.advanceTimersByTimeAsync(10_001)
  main().innerHTML = '<div class="text-emerald-500">-18.40%</div>'
  await settle()
  const el = main().firstElementChild as HTMLElement
  expect(el.dataset.oaSign).toBeUndefined()
  h.wake()
  expect(el.dataset.oaSign).toBe('neg')
  // and it watches again: a value the report draws next is marked too
  main().insertAdjacentHTML('beforeend', '<div class="text-emerald-600">-2.10%</div>')
  await settle()
  expect((main().lastElementChild as HTMLElement).dataset.oaSign).toBe('neg')
  // a disposed set never wakes
  h.dispose()
  main().innerHTML = '<div class="text-emerald-500">-1%</div>'
  h.wake()
  expect((main().firstElementChild as HTMLElement).dataset.oaSign).toBeUndefined()
})

test('the observer lets go after 10 s with no change, and a tap starts it again', async () => {
  dispose = installHelpers(window).dispose
  await jest.advanceTimersByTimeAsync(10_001)
  main().innerHTML = '<div class="text-emerald-500">-1%</div>'
  await settle()
  const el = main().firstElementChild as HTMLElement
  expect(el.dataset.oaSign).toBeUndefined()
  main().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  expect(el.dataset.oaSign).toBe('neg')
})
