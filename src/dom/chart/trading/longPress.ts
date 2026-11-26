// A long press on the chart (design 7.9.6): the phone's right click, which opens the web
// terminal's price menu (contextMenuAt, terminal.ts:7686-7690 at c8b2896). A finger held still
// for 500 ms (8 px of drift), alone on the screen, is a press at that point. The y it reports is
// the element's own, the coordinate the chart prices from (preflight conflict 26). `blocked` is
// asked at the press and again when it fires, so a drawing tool or a line drag that began in
// between still wins.
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP_PX = 8

type Press = { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> }

export function attachLongPress(
  el: HTMLElement,
  o: { ms?: number; slopPx?: number; blocked(): boolean; onPress(y: number): void },
): () => void {
  const ms = o.ms ?? LONG_PRESS_MS
  const slop = o.slopPx ?? LONG_PRESS_SLOP_PX
  let press: Press | null = null

  const cancel = () => {
    if (press !== null) clearTimeout(press.timer)
    press = null
  }
  const fire = (y: number) => {
    press = null
    if (!o.blocked()) o.onPress(y - el.getBoundingClientRect().top)
  }

  const onDown = (e: PointerEvent) => {
    cancel()
    // A second finger is a pinch, never a press.
    if (!e.isPrimary || o.blocked()) return
    const { clientX: x, clientY: y } = e
    press = { id: e.pointerId, x, y, timer: setTimeout(() => fire(y), ms) }
  }
  const onMove = (e: PointerEvent) => {
    if (press?.id !== e.pointerId) return
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > slop) cancel()
  }
  const onEnd = (e: PointerEvent) => {
    if (press?.id === e.pointerId) cancel()
  }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onEnd)
  el.addEventListener('pointercancel', onEnd)
  return () => {
    cancel()
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onEnd)
    el.removeEventListener('pointercancel', onEnd)
  }
}
