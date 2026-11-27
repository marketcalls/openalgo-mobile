// Small touch helpers the shell runs over the web pages (ux-bar T11-19), none of which edits a page:
// - a picker's search field opens without raising the keyboard (it rises on a tap of the field);
// - the GEX table opens centred on its ATM row, until the trader touches it;
// - a focused text field scrolls to the top of the view once the keyboard is up;
// - a page's "good" green on a negative value reads as a loss (data-oa-sign=neg, phone.css).
// The observer lets go after 10 s with no change and on dispose; a tap starts it again.

const IDLE_MS = 10_000
const KEYBOARD_MS = 250
const TAP_MS = 600
const CMDK_INPUT = '[cmdk-input]'
const GEX_TABLE = '[class~="max-h-[500px]"]'
const GEX_ATM = 'tr[class~="bg-yellow-500/10"]'
const EMERALD = '[class~="text-emerald-500"], [class~="text-emerald-600"]'
const TEXT_INPUT = /^(text|number|search|email|tel|url|date)$/

/** Whether `text` reads as a negative number (a minus sign or a hyphen-minus first). */
export const isNegative = (text: string): boolean => /^\s*[-−]\s*[₹\d.]/.test(text)

export function installHelpers(win: Window & typeof globalThis): () => void {
  const doc = win.document
  let lastTap: { at: number; target: EventTarget | null } = { at: 0, target: null }
  const touchedTables = new WeakSet<Element>()
  const centred = new WeakSet<Element>()
  let observer: MutationObserver | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }

  function onPointerDown(e: Event) {
    lastTap = { at: Date.now(), target: e.target }
    const table = (e.target as Element | null)?.closest?.(GEX_TABLE)
    if (table) touchedTables.add(table)
    watch()
  }

  function onFocusIn(e: Event) {
    const el = e.target
    if (!(el instanceof win.HTMLInputElement)) return
    const tapped = lastTap.target === el && Date.now() - lastTap.at < TAP_MS
    if (el.matches(CMDK_INPUT)) {
      // Radix focuses the search field as the picker opens: keep the focus (arrow keys, typing
      // with a hardware keyboard) but not the soft keyboard, until the field itself is tapped.
      if (tapped) return
      el.setAttribute('inputmode', 'none')
      el.addEventListener('pointerdown', () => el.removeAttribute('inputmode'), { once: true })
      return
    }
    if (!TEXT_INPUT.test(el.type) || el.closest('[data-radix-popper-content-wrapper]')) return
    later(() => {
      if (doc.activeElement === el) el.scrollIntoView({ block: 'start' })
    }, KEYBOARD_MS)
  }

  function centreGex() {
    for (const table of Array.from(doc.querySelectorAll<HTMLElement>(`#oa-tool ${GEX_TABLE}`))) {
      if (touchedTables.has(table)) continue
      const row = table.querySelector<HTMLElement>(GEX_ATM)
      if (!row || centred.has(row)) continue
      centred.add(row)
      // scrollTop only: the page itself does not move
      table.scrollTop = Math.max(0, row.offsetTop - (table.clientHeight - row.offsetHeight) / 2)
    }
  }

  function markSigns() {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`#oa-tool :is(${EMERALD})`))) {
      const neg = isNegative(el.textContent ?? '')
      if (neg && el.dataset.oaSign !== 'neg') el.dataset.oaSign = 'neg'
      else if (!neg && el.dataset.oaSign !== undefined) delete el.dataset.oaSign
    }
  }

  function letGo() {
    observer?.disconnect()
    observer = null
    if (idle !== null) clearTimeout(idle)
    idle = null
  }

  function changed() {
    if (idle !== null) clearTimeout(idle)
    idle = setTimeout(letGo, IDLE_MS)
    centreGex()
    markSigns()
  }

  function watch() {
    if (observer === null) {
      observer = new win.MutationObserver(changed)
      observer.observe(doc.body, { subtree: true, childList: true, characterData: true })
    }
    changed()
  }

  win.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('focusin', onFocusIn, true)
  watch()
  return () => {
    letGo()
    for (const t of timers) clearTimeout(t)
    timers.clear()
    win.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('focusin', onFocusIn, true)
  }
}
