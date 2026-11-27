// The layout probe (ux-bar T11-03): how far anything on the tool page reaches past the viewport's
// right edge, or starts before its left edge (a label placed right of a long negative bar ran off
// the left, E-PR-2), for native's `tool-layout` (T12) and the phone pass's "overflow 0" (T16). An element
// inside its own sideways scroller (a wide table) does not count: the trader can swipe to it. Never
// scrollWidth: `overflow-x: clip` on <html> hides an overflow from it, not from the eye.

/** The probe lets go after this long with no change on the page (ux-bar G18). */
export const PROBE_IDLE_MS = 10_000
/** A page's life sends native at most this many layout reports. */
export const MAX_LAYOUT_REPORTS = 5
/** The bridge's cap on a reported overflow (dom/bridge/schemas.ts, native only). */
const MAX_OVERFLOW = 100_000
/** A burst of changes (a plot drawing) is measured once, after it settles. */
const SETTLE_MS = 250
/** The page, and what Radix portals to <body> while it is open. */
const SCOPE =
  '#oa-tool *, [data-radix-popper-content-wrapper] *, [role="dialog"] *, [role="alertdialog"] *'
const WATCHED = ['class', 'style', 'hidden', 'data-state']

export type LayoutProbe = { start(): void; stop(): void }

export function createLayoutProbe(
  win: Window & typeof globalThis,
  report: (overflow: number) => void,
): LayoutProbe {
  const doc = win.document
  let observer: MutationObserver | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let last: number | null = null
  let reports = 0
  let done = false

  /** The widest overflow past either edge in whole px, 0 when everything fits. */
  function measure(): number {
    const width = win.innerWidth
    const scrolls = new Map<Element, boolean>()
    const inScroller = (el: Element): boolean => {
      const parent = el.parentElement
      if (parent === null || parent === doc.body || parent === doc.documentElement) return false
      const known = scrolls.get(parent)
      if (known !== undefined) return known
      const x = win.getComputedStyle(parent).overflowX
      const hit = x === 'auto' || x === 'scroll' || inScroller(parent)
      scrolls.set(parent, hit)
      return hit
    }
    let max = 0
    for (const el of Array.from(doc.querySelectorAll(SCOPE))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const over = Math.max(r.right - width, -r.left)
      if (over > max && !inScroller(el)) max = over
    }
    return Math.min(Math.floor(max), MAX_OVERFLOW)
  }

  function post(overflow: number) {
    if (done || overflow === last) return
    last = overflow
    reports += 1
    report(overflow)
    if (reports >= MAX_LAYOUT_REPORTS) stop()
  }

  // Measured after the change settles and two frames have laid it out.
  function settle() {
    if (pending || done) return
    pending = true
    setTimeout(() => {
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => {
          pending = false
          if (!done) post(measure())
        }),
      )
    }, SETTLE_MS)
  }

  function letGo() {
    observer?.disconnect()
    observer = null
    if (idle !== null) clearTimeout(idle)
    idle = null
  }

  function touched() {
    if (idle !== null) clearTimeout(idle)
    idle = setTimeout(letGo, PROBE_IDLE_MS)
    settle()
  }

  // A tap (a tab, a picker, a stepper) changes the layout after the probe let go.
  const onTap = () => start()

  function start() {
    if (done) return
    if (observer === null) {
      observer = new win.MutationObserver(touched)
      observer.observe(doc.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: WATCHED,
      })
    }
    touched()
  }

  function stop() {
    done = true
    letGo()
    win.removeEventListener('click', onTap, true)
  }

  win.addEventListener('click', onTap, true)
  return { start, stop }
}
